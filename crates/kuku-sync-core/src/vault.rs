use std::collections::{BTreeMap, BTreeSet};

use automerge::transaction::Transactable;
use automerge::{ActorId, AutoCommit, ObjId, ObjType, ROOT, ReadDoc, ScalarValue, Value};

use crate::error::{Result, SyncCoreError};
use crate::materialize::{build_projection_plan, path_conflicts};
use crate::model::{FileCreate, FileState, MaterializeIssue, MaterializedFile, MaterializedVault};
use crate::path::normalize_path;
use crate::text_doc::TextDocument;

pub(crate) const FILES_BY_ID: &str = "filesById";
pub(crate) const FIELD_STABLE_FILE_ID: &str = "stable_file_id";
pub(crate) const FIELD_INCARNATION_ID: &str = "incarnation_id";
pub(crate) const FIELD_DISPLAY_PATH: &str = "display_path";
pub(crate) const FIELD_NORMALIZED_PATH: &str = "normalized_path";
pub(crate) const FIELD_STATE: &str = "state";
pub(crate) const FIELD_TEXT_DOC_ID: &str = "text_doc_id";
pub(crate) const FIELD_BLOB_REF: &str = "blob_ref";
pub(crate) const FIELD_TOMBSTONE_CONTENT: &str = "tombstone_content";

pub struct VaultCore {
    pub(crate) actor: Vec<u8>,
    pub(crate) manifest: AutoCommit,
    pub(crate) text_docs: BTreeMap<String, TextDocument>,
    pub(crate) known_blobs: BTreeSet<String>,
}

impl VaultCore {
    pub fn new(actor: impl AsRef<[u8]>) -> Result<Self> {
        let actor = actor.as_ref().to_vec();
        let mut manifest = AutoCommit::new();
        manifest.set_actor(ActorId::from(actor.as_slice()));
        manifest.put_object(&ROOT, FILES_BY_ID, ObjType::Map)?;
        manifest.commit();

        Ok(Self {
            actor,
            manifest,
            text_docs: BTreeMap::new(),
            known_blobs: BTreeSet::new(),
        })
    }

    pub fn actor_id(&self) -> &[u8] {
        &self.actor
    }

    pub fn fork_for_actor(&mut self, actor: impl AsRef<[u8]>) -> Result<Self> {
        let actor = actor.as_ref().to_vec();
        let mut manifest = AutoCommit::load(&self.manifest.save())?;
        manifest.set_actor(ActorId::from(actor.as_slice()));

        let mut text_docs = BTreeMap::new();
        for (doc_id, text_doc) in &mut self.text_docs {
            text_docs.insert(doc_id.clone(), text_doc.fork_for_actor(actor.as_slice())?);
        }

        Ok(Self {
            actor,
            manifest,
            text_docs,
            known_blobs: self.known_blobs.clone(),
        })
    }

    pub fn create_markdown(&mut self, input: FileCreate) -> Result<()> {
        let normalized_path = normalize_path(&input.display_path);
        let text_doc = TextDocument::new(
            self.actor.as_slice(),
            input.text_doc_id.clone(),
            input.content,
        )?;
        self.text_docs.insert(input.text_doc_id.clone(), text_doc);

        let files_obj = self.files_by_id_obj()?;
        let file_obj =
            self.manifest
                .put_object(&files_obj, input.stable_file_id.as_str(), ObjType::Map)?;
        self.manifest.put(
            &file_obj,
            FIELD_STABLE_FILE_ID,
            input.stable_file_id.as_str(),
        )?;
        self.manifest
            .put(&file_obj, FIELD_INCARNATION_ID, input.incarnation_id)?;
        self.manifest
            .put(&file_obj, FIELD_DISPLAY_PATH, input.display_path)?;
        self.manifest
            .put(&file_obj, FIELD_NORMALIZED_PATH, normalized_path)?;
        self.manifest
            .put(&file_obj, FIELD_STATE, FileState::Active.as_str())?;
        self.manifest
            .put(&file_obj, FIELD_TEXT_DOC_ID, input.text_doc_id)?;
        if let Some(blob_ref) = input.blob_ref {
            self.manifest.put(&file_obj, FIELD_BLOB_REF, blob_ref)?;
        }
        self.manifest.commit();
        Ok(())
    }

    pub fn edit_markdown(&mut self, text_doc_id: &str, content: impl Into<String>) -> Result<()> {
        let Some(text_doc) = self.text_docs.get_mut(text_doc_id) else {
            return Err(SyncCoreError::MissingFile(text_doc_id.to_owned()));
        };
        text_doc.set_content(content.into())
    }

    pub fn rename_file(
        &mut self,
        stable_file_id: &str,
        display_path: impl Into<String>,
    ) -> Result<()> {
        let display_path = display_path.into();
        let normalized_path = normalize_path(&display_path);
        let file_obj = self.file_obj(stable_file_id)?;
        self.manifest
            .put(&file_obj, FIELD_DISPLAY_PATH, display_path)?;
        self.manifest
            .put(&file_obj, FIELD_NORMALIZED_PATH, normalized_path)?;
        self.manifest.commit();
        Ok(())
    }

    pub fn tombstone_file(&mut self, stable_file_id: &str) -> Result<()> {
        let file_obj = self.file_obj(stable_file_id)?;
        let text_doc_id = self.required_string(&file_obj, FIELD_TEXT_DOC_ID)?;
        let tombstone_content = self
            .text_docs
            .get_mut(&text_doc_id)
            .map(TextDocument::content)
            .transpose()?
            .unwrap_or_default();
        self.manifest
            .put(&file_obj, FIELD_STATE, FileState::Tombstoned.as_str())?;
        self.manifest
            .put(&file_obj, FIELD_TOMBSTONE_CONTENT, tombstone_content)?;
        self.manifest.commit();
        Ok(())
    }

    pub fn resolve_delete_edit_keep_delete(&mut self, stable_file_id: &str) -> Result<()> {
        let file_obj = self.file_obj(stable_file_id)?;
        let text_doc_id = self.required_string(&file_obj, FIELD_TEXT_DOC_ID)?;
        let current_content = self
            .text_docs
            .get_mut(&text_doc_id)
            .map(TextDocument::content)
            .transpose()?
            .unwrap_or_default();
        self.manifest
            .put(&file_obj, FIELD_STATE, FileState::Tombstoned.as_str())?;
        self.manifest
            .put(&file_obj, FIELD_TOMBSTONE_CONTENT, current_content)?;
        self.manifest.commit();
        Ok(())
    }

    pub fn resolve_delete_edit_restore_edited(&mut self, stable_file_id: &str) -> Result<()> {
        let file_obj = self.file_obj(stable_file_id)?;
        self.manifest
            .put(&file_obj, FIELD_STATE, FileState::Active.as_str())?;
        self.manifest.commit();
        Ok(())
    }

    pub fn add_known_blob(&mut self, blob_ref: impl Into<String>) {
        self.known_blobs.insert(blob_ref.into());
    }

    pub fn merge_from(&mut self, other: &mut Self) -> Result<()> {
        self.manifest.merge(&mut other.manifest)?;
        for (doc_id, other_text_doc) in &mut other.text_docs {
            if let Some(local_text_doc) = self.text_docs.get_mut(doc_id) {
                local_text_doc.merge_from(other_text_doc)?;
            } else {
                self.text_docs.insert(
                    doc_id.clone(),
                    other_text_doc.fork_for_actor(self.actor.as_slice())?,
                );
            }
        }
        self.known_blobs.extend(other.known_blobs.iter().cloned());
        Ok(())
    }

    pub fn materialize(&mut self) -> Result<MaterializedVault> {
        let mut files = BTreeMap::new();
        let mut issues = Vec::new();
        let files_obj = self.files_by_id_obj()?;

        for item in self.manifest.map_range(&files_obj, ..) {
            let file_id = item.key.to_string();
            let value = self.manifest.get(&files_obj, file_id.as_str())?.unwrap().0;
            let file_obj = item.id();
            if !matches!(value, Value::Object(ObjType::Map)) {
                issues.push(MaterializeIssue::ScalarConflict {
                    file_id: file_id.clone(),
                    field: FILES_BY_ID.to_owned(),
                    values: vec![value.to_string()],
                });
                continue;
            }

            for field in manifest_scalar_fields() {
                let values = self.conflicting_values(&file_obj, field)?;
                if values.len() > 1 {
                    issues.push(MaterializeIssue::ScalarConflict {
                        file_id: file_id.clone(),
                        field: field.to_string(),
                        values,
                    });
                }
            }

            let stable_file_id = self
                .string_or_default(&file_obj, FIELD_STABLE_FILE_ID)?
                .unwrap_or_else(|| file_id.to_string());
            let incarnation_id = self
                .string_or_default(&file_obj, FIELD_INCARNATION_ID)?
                .unwrap_or_default();
            let display_path = self
                .string_or_default(&file_obj, FIELD_DISPLAY_PATH)?
                .unwrap_or_default();
            let normalized_path = self
                .string_or_default(&file_obj, FIELD_NORMALIZED_PATH)?
                .unwrap_or_else(|| normalize_path(&display_path));
            let state = self
                .string_or_default(&file_obj, FIELD_STATE)?
                .as_deref()
                .map(FileState::from_str)
                .unwrap_or(FileState::Active);
            let text_doc_id = self
                .string_or_default(&file_obj, FIELD_TEXT_DOC_ID)?
                .unwrap_or_default();
            let blob_ref = self.string_or_default(&file_obj, FIELD_BLOB_REF)?;
            let tombstone_content = if state == FileState::Tombstoned {
                Some(
                    self.string_or_default(&file_obj, FIELD_TOMBSTONE_CONTENT)?
                        .unwrap_or_default(),
                )
            } else {
                None
            };

            let content = match self.text_docs.get_mut(&text_doc_id) {
                Some(text_doc) => Some(text_doc.content()?),
                None if !text_doc_id.is_empty() => {
                    issues.push(MaterializeIssue::MissingTextDoc {
                        file_id: stable_file_id.clone(),
                        text_doc_id: text_doc_id.clone(),
                    });
                    None
                }
                None => None,
            };

            if let Some(blob_ref) = &blob_ref {
                if !self.known_blobs.contains(blob_ref) {
                    issues.push(MaterializeIssue::MissingBlob {
                        file_id: stable_file_id.clone(),
                        blob_ref: blob_ref.clone(),
                    });
                }
            }

            if state == FileState::Tombstoned {
                if let Some(current_content) = &content {
                    let tombstone_content = tombstone_content.clone().unwrap_or_default();
                    if current_content != &tombstone_content {
                        issues.push(MaterializeIssue::DeleteEditConflict {
                            file_id: stable_file_id.clone(),
                            display_path: display_path.clone(),
                            text_doc_id: text_doc_id.clone(),
                            tombstone_content,
                            current_content: current_content.clone(),
                        });
                    }
                }
            }

            files.insert(
                stable_file_id.clone(),
                MaterializedFile {
                    stable_file_id,
                    incarnation_id,
                    display_path,
                    normalized_path,
                    state,
                    text_doc_id,
                    blob_ref,
                    content,
                    tombstone_content,
                },
            );
        }

        issues.extend(path_conflicts(&files));
        let projection_plan = build_projection_plan(&files, &issues);

        Ok(MaterializedVault {
            files,
            issues,
            projection_plan,
        })
    }

    pub(crate) fn text_doc_ids_from_manifest(&self) -> Result<BTreeSet<String>> {
        let mut doc_ids = BTreeSet::new();
        let files_obj = self.files_by_id_obj()?;
        for item in self.manifest.map_range(&files_obj, ..) {
            let file_obj = item.id();
            if let Some(text_doc_id) = self.string_or_default(&file_obj, FIELD_TEXT_DOC_ID)? {
                if !text_doc_id.is_empty() {
                    doc_ids.insert(text_doc_id);
                }
            }
        }
        Ok(doc_ids)
    }

    pub(crate) fn files_by_id_obj(&self) -> Result<ObjId> {
        match self.manifest.get(&ROOT, FILES_BY_ID)? {
            Some((Value::Object(ObjType::Map), obj)) => Ok(obj),
            Some(_) => Err(SyncCoreError::ExpectedObject { field: FILES_BY_ID }),
            None => Err(SyncCoreError::MissingFilesById),
        }
    }

    fn file_obj(&self, stable_file_id: &str) -> Result<ObjId> {
        let files_obj = self.files_by_id_obj()?;
        match self.manifest.get(&files_obj, stable_file_id)? {
            Some((Value::Object(ObjType::Map), obj)) => Ok(obj),
            Some(_) => Err(SyncCoreError::ExpectedObject {
                field: FIELD_STABLE_FILE_ID,
            }),
            None => Err(SyncCoreError::MissingFile(stable_file_id.to_owned())),
        }
    }

    fn required_string(&self, obj: &ObjId, field: &'static str) -> Result<String> {
        self.string_or_default(obj, field)?
            .ok_or(SyncCoreError::ExpectedString { field })
    }

    pub(crate) fn string_or_default(
        &self,
        obj: &ObjId,
        field: &'static str,
    ) -> Result<Option<String>> {
        let Some((value, _)) = self.manifest.get(obj, field)? else {
            return Ok(None);
        };
        scalar_string(value).map(Some)
    }

    fn conflicting_values(&self, obj: &ObjId, field: &'static str) -> Result<Vec<String>> {
        let values = self.manifest.get_all(obj, field)?;
        values
            .into_iter()
            .map(|(value, _)| scalar_string(value))
            .collect()
    }
}

fn manifest_scalar_fields() -> &'static [&'static str] {
    &[
        FIELD_STABLE_FILE_ID,
        FIELD_INCARNATION_ID,
        FIELD_DISPLAY_PATH,
        FIELD_NORMALIZED_PATH,
        FIELD_STATE,
        FIELD_TEXT_DOC_ID,
        FIELD_BLOB_REF,
        FIELD_TOMBSTONE_CONTENT,
    ]
}

fn scalar_string(value: Value<'_>) -> Result<String> {
    match value {
        Value::Scalar(value) => match value.as_ref() {
            ScalarValue::Str(value) => Ok(value.to_string()),
            ScalarValue::Boolean(value) => Ok(value.to_string()),
            ScalarValue::Int(value) => Ok(value.to_string()),
            ScalarValue::Uint(value) => Ok(value.to_string()),
            ScalarValue::Null => Ok(String::new()),
            other => Ok(other.to_string()),
        },
        Value::Object(_) => Err(SyncCoreError::ExpectedString { field: "value" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ProjectionStep;

    fn create_note(
        core: &mut VaultCore,
        file_id: &str,
        incarnation_id: &str,
        path: &str,
        text_doc_id: &str,
        content: &str,
    ) {
        core.create_markdown(FileCreate {
            stable_file_id: file_id.to_owned(),
            incarnation_id: incarnation_id.to_owned(),
            display_path: path.to_owned(),
            text_doc_id: text_doc_id.to_owned(),
            blob_ref: None,
            content: content.to_owned(),
        })
        .unwrap();
    }

    fn issue_kinds(vault: &MaterializedVault) -> Vec<&'static str> {
        vault
            .issues
            .iter()
            .map(|issue| match issue {
                MaterializeIssue::PathConflict { .. } => "path",
                MaterializeIssue::CaseConflict { .. } => "case",
                MaterializeIssue::DeleteEditConflict { .. } => "delete_edit",
                MaterializeIssue::MissingTextDoc { .. } => "missing_text",
                MaterializeIssue::MissingBlob { .. } => "missing_blob",
                MaterializeIssue::ScalarConflict { .. } => "scalar",
            })
            .collect()
    }

    #[test]
    fn create_markdown_file_materializes_write_plan() {
        let mut core = VaultCore::new(b"a").unwrap();
        create_note(
            &mut core,
            "file-1",
            "inc-1",
            "Notes/A.md",
            "text-1",
            "# A\n",
        );

        let vault = core.materialize().unwrap();

        assert_eq!(vault.issues, vec![]);
        assert_eq!(
            vault.files.get("file-1").unwrap().content.as_deref(),
            Some("# A\n")
        );
        assert_eq!(
            vault.projection_plan.steps,
            vec![ProjectionStep::Write {
                file_id: "file-1".to_owned(),
                path: "Notes/A.md".to_owned(),
                normalized_path: "notes/a.md".to_owned(),
                text_doc_id: "text-1".to_owned(),
                content: "# A\n".to_owned(),
            }]
        );
    }

    #[test]
    fn edit_markdown_content_updates_materialized_tree() {
        let mut core = VaultCore::new(b"a").unwrap();
        create_note(&mut core, "file-1", "inc-1", "a.md", "text-1", "old");

        core.edit_markdown("text-1", "new").unwrap();
        let vault = core.materialize().unwrap();

        assert_eq!(
            vault.files.get("file-1").unwrap().content.as_deref(),
            Some("new")
        );
    }

    #[test]
    fn two_devices_edit_different_paragraphs_of_same_markdown() {
        let mut base = VaultCore::new(b"base").unwrap();
        create_note(
            &mut base,
            "file-1",
            "inc-1",
            "note.md",
            "text-1",
            "alpha\n\nbeta\n",
        );
        let mut a = base.fork_for_actor(b"a").unwrap();
        let mut b = base.fork_for_actor(b"b").unwrap();

        a.edit_markdown("text-1", "alpha edited\n\nbeta\n").unwrap();
        b.edit_markdown("text-1", "alpha\n\nbeta edited\n").unwrap();
        a.merge_from(&mut b).unwrap();

        let content = a
            .materialize()
            .unwrap()
            .files
            .get("file-1")
            .unwrap()
            .content
            .clone()
            .unwrap();
        assert!(content.contains("alpha edited"));
        assert!(content.contains("beta edited"));
    }

    #[test]
    fn rename_while_another_device_edits_content_preserves_content() {
        let mut base = VaultCore::new(b"base").unwrap();
        create_note(&mut base, "file-1", "inc-1", "old.md", "text-1", "body");
        let mut a = base.fork_for_actor(b"a").unwrap();
        let mut b = base.fork_for_actor(b"b").unwrap();

        a.rename_file("file-1", "new.md").unwrap();
        b.edit_markdown("text-1", "body edited").unwrap();
        a.merge_from(&mut b).unwrap();

        let vault = a.materialize().unwrap();
        let file = vault.files.get("file-1").unwrap();
        assert_eq!(file.display_path, "new.md");
        assert_eq!(file.content.as_deref(), Some("body edited"));
        assert_eq!(vault.issues, vec![]);
    }

    #[test]
    fn delete_while_another_device_edits_content_is_visible_conflict() {
        let mut base = VaultCore::new(b"base").unwrap();
        create_note(&mut base, "file-1", "inc-1", "note.md", "text-1", "base");
        let mut a = base.fork_for_actor(b"a").unwrap();
        let mut b = base.fork_for_actor(b"b").unwrap();

        a.tombstone_file("file-1").unwrap();
        b.edit_markdown("text-1", "edited after delete").unwrap();
        a.merge_from(&mut b).unwrap();

        let vault = a.materialize().unwrap();
        assert!(issue_kinds(&vault).contains(&"delete_edit"));
        assert!(vault.projection_plan.blocked);
    }

    #[test]
    fn delete_edit_conflict_can_keep_delete() {
        let mut base = VaultCore::new(b"base").unwrap();
        create_note(&mut base, "file-1", "inc-1", "note.md", "text-1", "base");
        let mut a = base.fork_for_actor(b"a").unwrap();
        let mut b = base.fork_for_actor(b"b").unwrap();

        a.tombstone_file("file-1").unwrap();
        b.edit_markdown("text-1", "edited after delete").unwrap();
        a.merge_from(&mut b).unwrap();
        a.resolve_delete_edit_keep_delete("file-1").unwrap();

        let vault = a.materialize().unwrap();
        assert_eq!(
            vault.files.get("file-1").unwrap().state,
            FileState::Tombstoned
        );
        assert!(!issue_kinds(&vault).contains(&"delete_edit"));
        assert!(!vault.projection_plan.blocked);
    }

    #[test]
    fn delete_edit_conflict_can_restore_edited_version() {
        let mut base = VaultCore::new(b"base").unwrap();
        create_note(&mut base, "file-1", "inc-1", "note.md", "text-1", "base");
        let mut a = base.fork_for_actor(b"a").unwrap();
        let mut b = base.fork_for_actor(b"b").unwrap();

        a.tombstone_file("file-1").unwrap();
        b.edit_markdown("text-1", "edited after delete").unwrap();
        a.merge_from(&mut b).unwrap();
        a.resolve_delete_edit_restore_edited("file-1").unwrap();

        let vault = a.materialize().unwrap();
        let file = vault.files.get("file-1").unwrap();
        assert_eq!(file.state, FileState::Active);
        assert_eq!(file.content.as_deref(), Some("edited after delete"));
        assert!(!issue_kinds(&vault).contains(&"delete_edit"));
        assert!(!vault.projection_plan.blocked);
    }

    #[test]
    fn same_path_create_on_two_devices_is_path_conflict() {
        let mut base = VaultCore::new(b"base").unwrap();
        let mut a = base.fork_for_actor(b"a").unwrap();
        let mut b = base.fork_for_actor(b"b").unwrap();

        create_note(&mut a, "file-a", "inc-a", "same.md", "text-a", "a");
        create_note(&mut b, "file-b", "inc-b", "same.md", "text-b", "b");
        a.merge_from(&mut b).unwrap();

        let vault = a.materialize().unwrap();
        assert!(issue_kinds(&vault).contains(&"path"));
        assert!(vault.projection_plan.blocked);
    }

    #[test]
    fn delete_old_file_and_create_same_path_keeps_old_and_new_identity_separate() {
        let mut base = VaultCore::new(b"base").unwrap();
        create_note(
            &mut base, "old-file", "old-inc", "same.md", "old-text", "old",
        );
        let mut a = base.fork_for_actor(b"a").unwrap();
        let mut b = base.fork_for_actor(b"b").unwrap();

        a.tombstone_file("old-file").unwrap();
        create_note(&mut a, "new-file", "new-inc", "same.md", "new-text", "new");
        b.edit_markdown("old-text", "old edited").unwrap();
        a.merge_from(&mut b).unwrap();

        let vault = a.materialize().unwrap();
        assert_eq!(
            vault.files.get("old-file").unwrap().state,
            FileState::Tombstoned
        );
        assert_eq!(
            vault.files.get("new-file").unwrap().state,
            FileState::Active
        );
        assert!(issue_kinds(&vault).contains(&"delete_edit"));
        assert!(!issue_kinds(&vault).contains(&"path"));
    }

    #[test]
    fn case_only_path_conflict_blocks_projection() {
        let mut base = VaultCore::new(b"base").unwrap();
        let mut a = base.fork_for_actor(b"a").unwrap();
        let mut b = base.fork_for_actor(b"b").unwrap();

        create_note(&mut a, "file-a", "inc-a", "Notes/A.md", "text-a", "a");
        create_note(&mut b, "file-b", "inc-b", "notes/a.md", "text-b", "b");
        a.merge_from(&mut b).unwrap();

        let vault = a.materialize().unwrap();
        assert!(issue_kinds(&vault).contains(&"case"));
        assert!(vault.projection_plan.blocked);
    }

    #[test]
    fn manifest_reference_to_missing_text_doc_blocks_projection() {
        let mut core = VaultCore::new(b"a").unwrap();
        create_note(&mut core, "file-1", "inc-1", "a.md", "text-1", "a");
        core.text_docs.remove("text-1");

        let vault = core.materialize().unwrap();

        assert!(issue_kinds(&vault).contains(&"missing_text"));
        assert!(vault.projection_plan.blocked);
    }

    #[test]
    fn manifest_reference_to_missing_blob_blocks_projection() {
        let mut core = VaultCore::new(b"a").unwrap();
        core.create_markdown(FileCreate {
            stable_file_id: "file-1".to_owned(),
            incarnation_id: "inc-1".to_owned(),
            display_path: "a.md".to_owned(),
            text_doc_id: "text-1".to_owned(),
            blob_ref: Some("blob-1".to_owned()),
            content: "a".to_owned(),
        })
        .unwrap();

        let vault = core.materialize().unwrap();

        assert!(issue_kinds(&vault).contains(&"missing_blob"));
        assert!(vault.projection_plan.blocked);
    }

    #[test]
    fn known_blob_reference_allows_projection() {
        let mut core = VaultCore::new(b"a").unwrap();
        core.add_known_blob("blob-1");
        core.create_markdown(FileCreate {
            stable_file_id: "file-1".to_owned(),
            incarnation_id: "inc-1".to_owned(),
            display_path: "a.md".to_owned(),
            text_doc_id: "text-1".to_owned(),
            blob_ref: Some("blob-1".to_owned()),
            content: "a".to_owned(),
        })
        .unwrap();

        let vault = core.materialize().unwrap();

        assert_eq!(vault.issues, vec![]);
        assert!(!vault.projection_plan.blocked);
    }

    #[test]
    fn unicode_normalized_path_collision_blocks_projection() {
        let mut base = VaultCore::new(b"base").unwrap();
        let mut a = base.fork_for_actor(b"a").unwrap();
        let mut b = base.fork_for_actor(b"b").unwrap();

        create_note(&mut a, "file-a", "inc-a", "Cafe\u{301}.md", "text-a", "a");
        create_note(&mut b, "file-b", "inc-b", "Café.md", "text-b", "b");
        a.merge_from(&mut b).unwrap();

        let vault = a.materialize().unwrap();
        assert!(issue_kinds(&vault).contains(&"case"));
        assert!(issue_kinds(&vault).contains(&"path"));
        assert!(vault.projection_plan.blocked);
    }

    #[test]
    fn scalar_conflict_set_is_exposed_instead_of_only_winner() {
        let mut base = VaultCore::new(b"base").unwrap();
        create_note(&mut base, "file-1", "inc-1", "old.md", "text-1", "body");
        let mut a = base.fork_for_actor(b"a").unwrap();
        let mut b = base.fork_for_actor(b"b").unwrap();

        a.rename_file("file-1", "a.md").unwrap();
        b.rename_file("file-1", "b.md").unwrap();
        a.merge_from(&mut b).unwrap();

        let vault = a.materialize().unwrap();
        let conflict = vault
            .issues
            .iter()
            .find(|issue| {
                matches!(
                    issue,
                    MaterializeIssue::ScalarConflict { field, .. }
                    if field == FIELD_DISPLAY_PATH
                )
            })
            .expect("display_path conflict should be visible");
        if let MaterializeIssue::ScalarConflict { values, .. } = conflict {
            assert!(values.iter().any(|value| value == "a.md"));
            assert!(values.iter().any(|value| value == "b.md"));
        }
    }
}
