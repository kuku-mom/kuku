use std::collections::{BTreeMap, BTreeSet};

use automerge::{ActorId, AutoCommit};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::text_doc::TextDocument;
use crate::vault::VaultCore;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortableVaultSnapshot {
    pub manifest: Vec<u8>,
    pub text_docs: BTreeMap<String, Vec<u8>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub known_blobs: Vec<String>,
}

impl VaultCore {
    pub fn export_portable_snapshot(&mut self) -> PortableVaultSnapshot {
        let text_docs = self
            .text_docs
            .iter_mut()
            .map(|(doc_id, text_doc)| (doc_id.clone(), text_doc.save()))
            .collect();

        PortableVaultSnapshot {
            manifest: self.manifest.save(),
            text_docs,
            known_blobs: self.known_blobs.iter().cloned().collect(),
        }
    }

    pub fn load_portable_snapshot(
        actor: impl AsRef<[u8]>,
        snapshot: PortableVaultSnapshot,
    ) -> Result<Self> {
        let actor = actor.as_ref().to_vec();
        let mut manifest = AutoCommit::load(&snapshot.manifest)?;
        manifest.set_actor(ActorId::from(actor.as_slice()));

        let mut text_docs = BTreeMap::new();
        for (doc_id, bytes) in snapshot.text_docs {
            text_docs.insert(
                doc_id.clone(),
                TextDocument::load(actor.as_slice(), doc_id, &bytes)?,
            );
        }

        Ok(Self {
            actor,
            manifest,
            text_docs,
            known_blobs: snapshot.known_blobs.into_iter().collect::<BTreeSet<_>>(),
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::model::{FileCreate, FileState};
    use crate::recovery::{RecoverySnapshotKind, recovery_snapshot_set};

    use super::*;

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

    #[test]
    fn portable_snapshot_roundtrips_materialized_vault() {
        let mut core = VaultCore::new(b"a").unwrap();
        create_note(&mut core, "file-1", "inc-1", "note.md", "text-1", "body");
        core.edit_markdown("text-1", "updated").unwrap();

        let snapshot = core.export_portable_snapshot();
        let mut loaded = VaultCore::load_portable_snapshot(b"b", snapshot).unwrap();

        let file = loaded
            .materialize()
            .unwrap()
            .files
            .remove("file-1")
            .unwrap();
        assert_eq!(file.state, FileState::Active);
        assert_eq!(file.content.as_deref(), Some("updated"));
    }

    #[test]
    fn portable_snapshot_preserves_tombstone_recovery_content() {
        let mut core = VaultCore::new(b"a").unwrap();
        create_note(
            &mut core,
            "file-1",
            "inc-1",
            "note.md",
            "text-1",
            "deleted body",
        );
        core.tombstone_file("file-1").unwrap();

        let snapshot = core.export_portable_snapshot();
        let mut loaded = VaultCore::load_portable_snapshot(b"b", snapshot).unwrap();
        let recovery = recovery_snapshot_set(&loaded.materialize().unwrap());

        assert_eq!(recovery.snapshots.len(), 1);
        assert_eq!(recovery.snapshots[0].kind, RecoverySnapshotKind::Tombstone);
        assert_eq!(recovery.snapshots[0].content, "deleted body");
    }
}
