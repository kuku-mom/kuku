mod error;
mod import;
mod materialize;
mod model;
mod object;
mod path;
mod projection;
mod recovery;
mod review;
mod scheduler;
mod snapshot;
mod store;
mod sync_once;
mod text_doc;
mod vault;

pub use error::{Result, SyncCoreError};
pub use import::{
    ExpectedMutation, ImportAutoReason, ImportCandidate, ImportCandidateInput, ImportConfidence,
    ImportReviewReason, classify_import_candidate,
};
pub use model::{
    FileCreate, FileState, MaterializeIssue, MaterializedFile, MaterializedVault, ProjectionPlan,
    ProjectionStep,
};
pub use object::{
    EncryptedObjectCodec, EncryptedObjectEnvelope, EncryptedObjectKind, MemoryObjectStore,
    ObjectCryptoKey, ObjectStore, ObjectStoreError, ObjectStoreResult, ObjectSummary,
    ObjectVaultLoad, PointerPublishResult, QuarantinedObject, VaultObjectPack,
    load_vault_from_objects, publish_root_with_barrier, upload_vault_objects,
};
pub use path::normalize_path;
pub use projection::{
    GuardedProjectionPlan, GuardedProjectionStep, ProjectedSnapshot, ProjectedSnapshotUpdate,
    ProjectionApplyResult, ProjectionConfirmation, ProjectionOperation,
    ProjectionPreflightDecision, ProjectionPreflightStatus, confirm_projection_result,
    preflight_projection, preflight_projection_plan,
};
pub use recovery::{
    RecoveryRestoreInput, RecoverySnapshot, RecoverySnapshotKind, RecoverySnapshotReason,
    RecoverySnapshotSet, RecoveryUnavailable, RecoveryUnavailableReason, recovery_snapshot_set,
};
pub use review::{
    ReviewQueueSnapshot, ReviewResolutionCommand, ReviewResolutionRecord, SyncReviewItem,
    filter_resolved_review_items, import_review_item, materialize_review_item,
    projection_review_items, review_item_fingerprint, review_item_id,
    review_queue_from_imports_and_projection,
};
pub use scheduler::{
    AutoSyncDecision, AutoSyncPolicy, AutoSyncScheduler, AutoSyncStatus, AutoSyncTrigger,
};
pub use snapshot::PortableVaultSnapshot;
pub use store::{
    FileLocalStore, JournalEntry, JournalEntryKind, LocalStore, MemoryLocalStore, StoreDiagnostic,
    StoreError, StoreResult, StoredVaultLoad, WriterLockLease,
};
pub use sync_once::{
    SyncCoordinator, SyncFailure, SyncFailureClass, SyncOnceContext, SyncOnceError,
    SyncOnceOutcome, SyncOnceRequest, SyncPhase, SyncReason, SyncRunStart, SyncRunStatus,
};
pub use vault::VaultCore;
