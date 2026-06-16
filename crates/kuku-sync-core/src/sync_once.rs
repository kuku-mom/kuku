use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::error::SyncCoreError;
use crate::model::MaterializeIssue;
use crate::object::{
    EncryptedObjectCodec, ObjectStore, ObjectStoreError, PointerPublishResult,
    load_vault_from_objects, publish_root_with_barrier, upload_vault_objects,
};
use crate::projection::{GuardedProjectionPlan, ProjectedSnapshot, preflight_projection_plan};
use crate::review::{ReviewQueueSnapshot, review_queue_from_imports_and_projection};
use crate::store::{JournalEntry, JournalEntryKind, LocalStore, StoreError};
use crate::vault::VaultCore;

#[derive(Debug, Error)]
pub enum SyncOnceError {
    #[error("sync core operation failed: {0}")]
    Core(#[from] SyncCoreError),
    #[error("local store operation failed: {0}")]
    Store(#[from] StoreError),
    #[error("object store operation failed: {0}")]
    Object(#[from] ObjectStoreError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncReason {
    Manual,
    Automatic,
    Startup,
    ExternalEvent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncPhase {
    Idle,
    Planning,
    Importing,
    LoadingRemote,
    Merging,
    Uploading,
    Publishing,
    Projecting,
    Acknowledging,
    Blocked,
    Backoff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncFailureClass {
    Network,
    Auth,
    Key,
    Quota,
    Decrypt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncFailure {
    pub phase: SyncPhase,
    pub class: SyncFailureClass,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncOnceRequest {
    pub reason: SyncReason,
    pub workspace_id: String,
    pub head_pointer: String,
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<i64>,
    #[serde(default)]
    pub current_disk: Vec<ProjectedSnapshot>,
    #[serde(default)]
    pub last_projected: Vec<ProjectedSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crash_after_phase: Option<SyncPhase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fail_with: Option<SyncFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncRunStatus {
    pub active: bool,
    pub phase: SyncPhase,
    pub run_requested: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_class: Option<SyncFailureClass>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_retry_at_ms: Option<i64>,
}

impl Default for SyncRunStatus {
    fn default() -> Self {
        Self {
            active: false,
            phase: SyncPhase::Idle,
            run_requested: false,
            last_error: None,
            blocked_class: None,
            next_retry_at_ms: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SyncRunStart {
    Started,
    AlreadyRunning { run_requested: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SyncOnceOutcome {
    Noop,
    Completed {
        phases: Vec<SyncPhase>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        published_head: Option<String>,
        projection_plan: GuardedProjectionPlan,
        run_requested: bool,
    },
    AlreadyRunning {
        run_requested: bool,
    },
    Backoff {
        class: SyncFailureClass,
        message: String,
    },
    Blocked {
        class: SyncFailureClass,
        message: String,
    },
    ProjectionBlocked {
        issues: Vec<MaterializeIssue>,
        projection_plan: GuardedProjectionPlan,
        review_queue: ReviewQueueSnapshot,
    },
    Interrupted {
        phase: SyncPhase,
    },
}

pub struct SyncOnceContext<'a, S, R>
where
    S: LocalStore,
    R: ObjectStore,
{
    pub core: &'a mut VaultCore,
    pub local_store: &'a mut S,
    pub remote: &'a mut R,
    pub codec: &'a EncryptedObjectCodec,
}

#[derive(Default)]
pub struct SyncCoordinator {
    status: SyncRunStatus,
    next_run_id: u64,
}

impl SyncCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self) -> &SyncRunStatus {
        &self.status
    }

    pub fn begin_run(&mut self, _reason: SyncReason) -> SyncRunStart {
        if self.status.active {
            self.status.run_requested = true;
            return SyncRunStart::AlreadyRunning {
                run_requested: true,
            };
        }
        self.status.active = true;
        self.status.phase = SyncPhase::Planning;
        self.status.last_error = None;
        self.status.blocked_class = None;
        self.status.next_retry_at_ms = None;
        SyncRunStart::Started
    }

    pub fn finish_run(&mut self) {
        self.status.active = false;
        self.status.phase = SyncPhase::Idle;
    }

    pub fn sync_once<S, R>(
        &mut self,
        ctx: SyncOnceContext<'_, S, R>,
        request: SyncOnceRequest,
    ) -> Result<SyncOnceOutcome, SyncOnceError>
    where
        S: LocalStore,
        R: ObjectStore,
    {
        if let SyncRunStart::AlreadyRunning { run_requested } = self.begin_run(request.reason) {
            return Ok(SyncOnceOutcome::AlreadyRunning { run_requested });
        }

        self.next_run_id += 1;
        let run_id = self.next_run_id;
        let result = self.sync_once_inner(ctx, &request, run_id);
        if !matches!(
            result,
            Ok(SyncOnceOutcome::Backoff { .. })
                | Ok(SyncOnceOutcome::Blocked { .. })
                | Ok(SyncOnceOutcome::ProjectionBlocked { .. })
                | Ok(SyncOnceOutcome::Interrupted { .. })
        ) {
            self.finish_run();
        } else {
            self.status.active = false;
        }
        result
    }

    fn sync_once_inner<S, R>(
        &mut self,
        ctx: SyncOnceContext<'_, S, R>,
        request: &SyncOnceRequest,
        run_id: u64,
    ) -> Result<SyncOnceOutcome, SyncOnceError>
    where
        S: LocalStore,
        R: ObjectStore,
    {
        let mut phases = Vec::new();
        let mut remote_head = None;

        for phase in [
            SyncPhase::Planning,
            SyncPhase::Importing,
            SyncPhase::LoadingRemote,
            SyncPhase::Merging,
        ] {
            if let Some(outcome) =
                self.enter_phase(ctx.local_store, request, run_id, phase, &mut phases)?
            {
                return Ok(outcome);
            }
            if phase == SyncPhase::LoadingRemote {
                remote_head = ctx.remote.get_pointer(&request.head_pointer)?;
                if let Some(head) = &remote_head {
                    let object_ids = object_ids_for_head(ctx.remote, head)?;
                    let load = load_vault_from_objects(
                        ctx.core.actor_id(),
                        ctx.remote,
                        ctx.codec,
                        &object_ids,
                    )?;
                    if !load.quarantined_objects.is_empty() {
                        return Ok(self.blocked(
                            SyncFailureClass::Decrypt,
                            "remote object failed to decrypt".to_owned(),
                        ));
                    }
                    if let Some(mut remote_core) = load.stored.core {
                        ctx.core.merge_from(&mut remote_core)?;
                    }
                }
            }
        }

        if remote_head.is_none() && ctx.core.materialize()?.files.is_empty() {
            self.finish_run();
            return Ok(SyncOnceOutcome::Noop);
        }

        if let Some(outcome) = self.enter_phase(
            ctx.local_store,
            request,
            run_id,
            SyncPhase::Uploading,
            &mut phases,
        )? {
            return Ok(outcome);
        }
        let pack = upload_vault_objects(
            ctx.core,
            ctx.remote,
            ctx.codec,
            &request.workspace_id,
            request.generation,
        )?;

        if let Some(outcome) = self.enter_phase(
            ctx.local_store,
            request,
            run_id,
            SyncPhase::Publishing,
            &mut phases,
        )? {
            return Ok(outcome);
        }
        let publish = publish_root_with_barrier(
            ctx.remote,
            &request.head_pointer,
            remote_head.as_deref(),
            &pack.root_object_id,
            &pack.object_ids,
        )?;
        let published_head = match publish {
            PointerPublishResult::Published { object_id, .. }
            | PointerPublishResult::AlreadyPublished { object_id, .. } => Some(object_id),
            PointerPublishResult::MissingObjects { object_ids } => {
                return Ok(self.blocked(
                    SyncFailureClass::Decrypt,
                    format!("missing objects before publish: {object_ids:?}"),
                ));
            }
            PointerPublishResult::Conflict { current } => {
                return Ok(self.backoff(
                    SyncFailureClass::Network,
                    format!("pointer conflict: {current:?}"),
                ));
            }
        };

        if let Some(outcome) = self.enter_phase(
            ctx.local_store,
            request,
            run_id,
            SyncPhase::Projecting,
            &mut phases,
        )? {
            return Ok(outcome);
        }
        let vault = ctx.core.materialize()?;
        let projection_plan = preflight_projection_plan(
            &vault.projection_plan,
            &request.current_disk,
            &request.last_projected,
        );
        if projection_plan.blocked {
            let review_queue =
                review_queue_from_imports_and_projection(&[], Some(&projection_plan));
            self.status.phase = SyncPhase::Blocked;
            return Ok(SyncOnceOutcome::ProjectionBlocked {
                issues: vault.issues,
                projection_plan,
                review_queue,
            });
        }

        if let Some(outcome) = self.enter_phase(
            ctx.local_store,
            request,
            run_id,
            SyncPhase::Acknowledging,
            &mut phases,
        )? {
            return Ok(outcome);
        }
        ctx.core.save_to_store(ctx.local_store)?;
        self.finish_run();

        Ok(SyncOnceOutcome::Completed {
            phases,
            published_head,
            projection_plan,
            run_requested: self.status.run_requested,
        })
    }

    fn enter_phase(
        &mut self,
        store: &mut impl LocalStore,
        request: &SyncOnceRequest,
        run_id: u64,
        phase: SyncPhase,
        phases: &mut Vec<SyncPhase>,
    ) -> Result<Option<SyncOnceOutcome>, SyncOnceError> {
        self.status.phase = phase;
        phases.push(phase);
        store.append_journal_entry(JournalEntry {
            entry_id: format!("sync-run-{run_id}-{phase:?}"),
            kind: JournalEntryKind::SyncRun,
            payload: serde_json::to_string(&SyncRunJournalRecord {
                run_id,
                reason: request.reason,
                phase,
            })
            .expect("sync run journal record should serialize"),
            created_at_ms: request.deadline_ms.unwrap_or_default(),
        })?;

        if request.crash_after_phase == Some(phase) {
            return Ok(Some(SyncOnceOutcome::Interrupted { phase }));
        }
        if let Some(failure) = &request.fail_with {
            if failure.phase == phase {
                return Ok(Some(self.classify_injected_failure(failure)));
            }
        }
        Ok(None)
    }

    fn backoff(&mut self, class: SyncFailureClass, message: String) -> SyncOnceOutcome {
        self.status.phase = SyncPhase::Backoff;
        self.status.last_error = Some(message.clone());
        self.status.next_retry_at_ms = Some(1);
        SyncOnceOutcome::Backoff { class, message }
    }

    fn blocked(&mut self, class: SyncFailureClass, message: String) -> SyncOnceOutcome {
        self.status.phase = SyncPhase::Blocked;
        self.status.last_error = Some(message.clone());
        self.status.blocked_class = Some(class);
        SyncOnceOutcome::Blocked { class, message }
    }
}

#[derive(Serialize)]
struct SyncRunJournalRecord {
    run_id: u64,
    reason: SyncReason,
    phase: SyncPhase,
}

fn object_ids_for_head(
    remote: &impl ObjectStore,
    head: &str,
) -> Result<Vec<String>, SyncOnceError> {
    let Some(root) = remote.get_object(head)? else {
        return Err(ObjectStoreError::MissingObject(head.to_owned()).into());
    };
    let mut ids = remote
        .list_prefix("obj_")?
        .into_iter()
        .filter(|summary| {
            summary.workspace_id == root.workspace_id && summary.generation == root.generation
        })
        .map(|summary| summary.object_id)
        .collect::<Vec<_>>();
    ids.sort();
    Ok(ids)
}

impl SyncCoordinator {
    fn classify_injected_failure(&mut self, failure: &SyncFailure) -> SyncOnceOutcome {
        match failure.class {
            SyncFailureClass::Network => self.backoff(failure.class, failure.message.clone()),
            SyncFailureClass::Auth
            | SyncFailureClass::Key
            | SyncFailureClass::Quota
            | SyncFailureClass::Decrypt => self.blocked(failure.class, failure.message.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::FileCreate;
    use crate::object::{EncryptedObjectCodec, MemoryObjectStore, ObjectCryptoKey};
    use crate::store::MemoryLocalStore;

    fn codec() -> EncryptedObjectCodec {
        EncryptedObjectCodec::new(ObjectCryptoKey::from_seed(b"sync-once-test"))
    }

    fn request() -> SyncOnceRequest {
        SyncOnceRequest {
            reason: SyncReason::Manual,
            workspace_id: "workspace-1".to_owned(),
            head_pointer: "workspace/head".to_owned(),
            generation: 1,
            deadline_ms: Some(1),
            current_disk: vec![],
            last_projected: vec![],
            crash_after_phase: None,
            fail_with: None,
        }
    }

    fn create_note(core: &mut VaultCore, content: &str) {
        core.create_markdown(FileCreate {
            stable_file_id: "file-1".to_owned(),
            incarnation_id: "inc-1".to_owned(),
            display_path: "note.md".to_owned(),
            text_doc_id: "text-1".to_owned(),
            blob_ref: None,
            content: content.to_owned(),
        })
        .unwrap();
    }

    #[test]
    fn clean_noop_sync_finishes_without_remote_publish() {
        let mut coordinator = SyncCoordinator::new();
        let mut core = VaultCore::new(b"a").unwrap();
        let mut local_store = MemoryLocalStore::new();
        let mut remote = MemoryObjectStore::new();
        let codec = codec();

        let outcome = coordinator
            .sync_once(
                SyncOnceContext {
                    core: &mut core,
                    local_store: &mut local_store,
                    remote: &mut remote,
                    codec: &codec,
                },
                request(),
            )
            .unwrap();

        assert_eq!(outcome, SyncOnceOutcome::Noop);
        assert_eq!(remote.get_pointer("workspace/head").unwrap(), None);
    }

    #[test]
    fn local_only_change_uploads_publishes_and_projects() {
        let mut coordinator = SyncCoordinator::new();
        let mut core = VaultCore::new(b"a").unwrap();
        create_note(&mut core, "local");
        let mut local_store = MemoryLocalStore::new();
        let mut remote = MemoryObjectStore::new();
        let codec = codec();

        let outcome = coordinator
            .sync_once(
                SyncOnceContext {
                    core: &mut core,
                    local_store: &mut local_store,
                    remote: &mut remote,
                    codec: &codec,
                },
                request(),
            )
            .unwrap();

        match outcome {
            SyncOnceOutcome::Completed {
                published_head,
                projection_plan,
                ..
            } => {
                assert!(published_head.is_some());
                assert!(!projection_plan.blocked);
            }
            other => panic!("expected completed sync, got {other:?}"),
        }
        assert!(remote.get_pointer("workspace/head").unwrap().is_some());
    }

    #[test]
    fn remote_only_change_loads_merges_and_projects() {
        let codec = codec();
        let mut remote = MemoryObjectStore::new();
        let mut remote_core = VaultCore::new(b"remote").unwrap();
        create_note(&mut remote_core, "remote");
        let pack =
            upload_vault_objects(&mut remote_core, &mut remote, &codec, "workspace-1", 1).unwrap();
        publish_root_with_barrier(
            &mut remote,
            "workspace/head",
            None,
            &pack.root_object_id,
            &pack.object_ids,
        )
        .unwrap();

        let mut coordinator = SyncCoordinator::new();
        let mut local_core = VaultCore::new(b"local").unwrap();
        let mut local_store = MemoryLocalStore::new();

        coordinator
            .sync_once(
                SyncOnceContext {
                    core: &mut local_core,
                    local_store: &mut local_store,
                    remote: &mut remote,
                    codec: &codec,
                },
                request(),
            )
            .unwrap();

        assert_eq!(
            local_core
                .materialize()
                .unwrap()
                .files
                .get("file-1")
                .unwrap()
                .content
                .as_deref(),
            Some("remote")
        );
    }

    #[test]
    fn local_and_remote_concurrent_text_edits_merge() {
        let codec = codec();
        let mut remote = MemoryObjectStore::new();
        let mut base = VaultCore::new(b"base").unwrap();
        create_note(&mut base, "alpha\n\nbeta\n");
        let pack = upload_vault_objects(&mut base, &mut remote, &codec, "workspace-1", 1).unwrap();
        let base_head = pack.root_object_id.clone();
        publish_root_with_barrier(
            &mut remote,
            "workspace/head",
            None,
            &pack.root_object_id,
            &pack.object_ids,
        )
        .unwrap();

        let mut local = base.fork_for_actor(b"local").unwrap();
        let mut other = base.fork_for_actor(b"remote").unwrap();
        local
            .edit_markdown("text-1", "alpha local\n\nbeta\n")
            .unwrap();
        other
            .edit_markdown("text-1", "alpha\n\nbeta remote\n")
            .unwrap();
        let pack = upload_vault_objects(&mut other, &mut remote, &codec, "workspace-1", 2).unwrap();
        publish_root_with_barrier(
            &mut remote,
            "workspace/head",
            Some(&base_head),
            &pack.root_object_id,
            &pack.object_ids,
        )
        .unwrap();

        let mut coordinator = SyncCoordinator::new();
        let mut local_store = MemoryLocalStore::new();
        let mut req = request();
        req.generation = 3;
        coordinator
            .sync_once(
                SyncOnceContext {
                    core: &mut local,
                    local_store: &mut local_store,
                    remote: &mut remote,
                    codec: &codec,
                },
                req,
            )
            .unwrap();
        let content = local
            .materialize()
            .unwrap()
            .files
            .get("file-1")
            .unwrap()
            .content
            .clone()
            .unwrap();

        assert!(content.contains("alpha local"));
        assert!(content.contains("beta remote"));
    }

    #[test]
    fn second_trigger_during_run_sets_run_requested() {
        let mut coordinator = SyncCoordinator::new();
        assert_eq!(
            coordinator.begin_run(SyncReason::Manual),
            SyncRunStart::Started
        );

        let second = coordinator.begin_run(SyncReason::Automatic);

        assert_eq!(
            second,
            SyncRunStart::AlreadyRunning {
                run_requested: true
            }
        );
        assert!(coordinator.status().run_requested);
    }

    #[test]
    fn network_failure_enters_backoff() {
        let mut coordinator = SyncCoordinator::new();
        let mut core = VaultCore::new(b"a").unwrap();
        create_note(&mut core, "local");
        let mut local_store = MemoryLocalStore::new();
        let mut remote = MemoryObjectStore::new();
        let codec = codec();
        let mut req = request();
        req.fail_with = Some(SyncFailure {
            phase: SyncPhase::LoadingRemote,
            class: SyncFailureClass::Network,
            message: "offline".to_owned(),
        });

        let outcome = coordinator
            .sync_once(
                SyncOnceContext {
                    core: &mut core,
                    local_store: &mut local_store,
                    remote: &mut remote,
                    codec: &codec,
                },
                req,
            )
            .unwrap();

        assert_eq!(
            outcome,
            SyncOnceOutcome::Backoff {
                class: SyncFailureClass::Network,
                message: "offline".to_owned(),
            }
        );
        assert_eq!(coordinator.status().phase, SyncPhase::Backoff);
    }

    #[test]
    fn user_actionable_failures_enter_blocked_state() {
        for class in [
            SyncFailureClass::Auth,
            SyncFailureClass::Key,
            SyncFailureClass::Quota,
            SyncFailureClass::Decrypt,
        ] {
            let mut coordinator = SyncCoordinator::new();
            let mut core = VaultCore::new(b"a").unwrap();
            create_note(&mut core, "local");
            let mut local_store = MemoryLocalStore::new();
            let mut remote = MemoryObjectStore::new();
            let codec = codec();
            let mut req = request();
            req.fail_with = Some(SyncFailure {
                phase: SyncPhase::LoadingRemote,
                class,
                message: format!("{class:?} blocked"),
            });

            let outcome = coordinator
                .sync_once(
                    SyncOnceContext {
                        core: &mut core,
                        local_store: &mut local_store,
                        remote: &mut remote,
                        codec: &codec,
                    },
                    req,
                )
                .unwrap();

            assert!(matches!(outcome, SyncOnceOutcome::Blocked { class: c, .. } if c == class));
            assert_eq!(coordinator.status().phase, SyncPhase::Blocked);
            assert_eq!(coordinator.status().blocked_class, Some(class));
        }
    }

    #[test]
    fn crash_at_each_phase_records_journal_and_next_run_resumes() {
        for phase in [
            SyncPhase::Planning,
            SyncPhase::Importing,
            SyncPhase::LoadingRemote,
            SyncPhase::Merging,
            SyncPhase::Uploading,
            SyncPhase::Publishing,
            SyncPhase::Projecting,
            SyncPhase::Acknowledging,
        ] {
            let mut coordinator = SyncCoordinator::new();
            let mut core = VaultCore::new(b"a").unwrap();
            create_note(&mut core, "local");
            let mut local_store = MemoryLocalStore::new();
            let mut remote = MemoryObjectStore::new();
            let codec = codec();
            let mut req = request();
            req.crash_after_phase = Some(phase);

            let interrupted = coordinator
                .sync_once(
                    SyncOnceContext {
                        core: &mut core,
                        local_store: &mut local_store,
                        remote: &mut remote,
                        codec: &codec,
                    },
                    req,
                )
                .unwrap();
            assert_eq!(interrupted, SyncOnceOutcome::Interrupted { phase });
            assert!(!local_store.read_journal().unwrap().is_empty());

            let mut retry = request();
            retry.generation = 2;
            let resumed = coordinator
                .sync_once(
                    SyncOnceContext {
                        core: &mut core,
                        local_store: &mut local_store,
                        remote: &mut remote,
                        codec: &codec,
                    },
                    retry,
                )
                .unwrap();
            assert!(matches!(resumed, SyncOnceOutcome::Completed { .. }));
        }
    }

    #[test]
    fn projection_block_prevents_fully_synced_completion() {
        let mut coordinator = SyncCoordinator::new();
        let mut core = VaultCore::new(b"a").unwrap();
        create_note(&mut core, "local");
        let mut local_store = MemoryLocalStore::new();
        let mut remote = MemoryObjectStore::new();
        let codec = codec();
        let mut req = request();
        req.current_disk = vec![ProjectedSnapshot {
            file_id: "file-1".to_owned(),
            normalized_path: "note.md".to_owned(),
            content_hash: "external".to_owned(),
            mtime_ms: 2,
            size: 8,
            projection_generation: 2,
        }];

        let outcome = coordinator
            .sync_once(
                SyncOnceContext {
                    core: &mut core,
                    local_store: &mut local_store,
                    remote: &mut remote,
                    codec: &codec,
                },
                req,
            )
            .unwrap();

        match outcome {
            SyncOnceOutcome::ProjectionBlocked {
                projection_plan,
                review_queue,
                ..
            } => {
                assert!(projection_plan.blocked);
                assert!(review_queue.blocks_fully_synced);
                assert!(!review_queue.items.is_empty());
            }
            other => panic!("expected projection blocked, got {other:?}"),
        }
        assert_eq!(coordinator.status().phase, SyncPhase::Blocked);
    }
}
