package sync

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	syncv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1"

	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

func TestServiceIntegrationConservativeGCPreservesReachableAndDeletesExpiredOrphans(t *testing.T) {
	f := newPublishFixture(t)
	now := time.Date(2026, 5, 7, 4, 45, 0, 0, time.UTC)
	f.service.now = func() time.Time { return now }

	genesisBody := f.reserveAndUploadObject(t, "genesis-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("genesis body"))
	genesisPack := f.reserveAndUploadObject(t, "genesis-pack", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CHECKPOINT_PACK, []byte("genesis checkpoint pack"))
	genesis := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_CHECKPOINT,
		"",
		nil,
		1,
		genesisBody,
		genesisPack,
	))
	if _, err := f.service.PublishCommit(f.ctx, f.user.ID, genesis); err != nil {
		t.Fatal(err)
	}

	incrementalBody := f.reserveAndUploadObject(t, "incremental-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("incremental body"))
	incrementalPack := f.reserveAndUploadObject(t, "incremental-pack", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK, []byte("incremental pack"))
	incremental := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL,
		genesis.CommitID,
		[]string{genesis.CommitID},
		2,
		incrementalBody,
		incrementalPack,
	))
	if _, err := f.service.PublishCommit(f.ctx, f.user.ID, incremental); err != nil {
		t.Fatal(err)
	}

	latestBody := f.reserveAndUploadObject(t, "latest-checkpoint-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("latest checkpoint body"))
	latestPack := f.reserveAndUploadObject(t, "latest-checkpoint-pack", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CHECKPOINT_PACK, []byte("latest checkpoint pack"))
	latest := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_CHECKPOINT,
		incremental.CommitID,
		[]string{incremental.CommitID},
		3,
		latestBody,
		latestPack,
	))
	if _, err := f.service.PublishCommit(f.ctx, f.user.ID, latest); err != nil {
		t.Fatal(err)
	}

	reservedOrphan := f.reserveExpiredReservedObject(t, "reserved-orphan", now.Add(-time.Hour))
	pendingOrphan := f.reserveExpiredPendingObject(t, "pending-orphan", []byte("pending orphan payload"), now.Add(-time.Hour))
	failedOrphan := f.reserveExpiredFailedObject(t, "failed-orphan", []byte("failed orphan payload"), now.Add(-time.Hour))

	dryRun, err := f.service.RunWorkspaceGC(f.ctx, f.user.ID, f.workspace.ID, SyncGCOptions{
		DryRun: true,
		Now:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !dryRun.DryRun || len(dryRun.DeletedOrphans) != 0 {
		t.Fatalf("dry-run report = %+v", dryRun)
	}
	if dryRun.LatestCheckpoint.CommitID != latest.CommitID || !dryRun.HasLatestCheckpoint {
		t.Fatalf("latest checkpoint = %+v", dryRun.LatestCheckpoint)
	}
	if dryRun.ReachableCommitCount != 3 || dryRun.ReachableObjectCount != 6 {
		t.Fatalf("reachable counts = commits %d objects %d, want 3/6", dryRun.ReachableCommitCount, dryRun.ReachableObjectCount)
	}
	if len(dryRun.OrphanCandidates) != 3 {
		t.Fatalf("dry-run orphan candidates = %+v, want 3", dryRun.OrphanCandidates)
	}
	if len(dryRun.OldReachableHistoryCandidates) != 2 {
		t.Fatalf("old history candidates = %+v, want 2", dryRun.OldReachableHistoryCandidates)
	}
	f.requireObjectNotDeleted(t, reservedOrphan.ObjectID)
	f.requireObjectNotDeleted(t, pendingOrphan.ObjectID)
	f.requireObjectNotDeleted(t, failedOrphan.ObjectID)

	report, err := f.service.RunWorkspaceGC(f.ctx, f.user.ID, f.workspace.ID, SyncGCOptions{Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if report.DryRun || len(report.DeletedOrphans) != 3 {
		t.Fatalf("gc report = %+v", report)
	}
	if report.UsageAfter.Workspace.PendingUploadBytes != 0 {
		t.Fatalf("pending usage after gc = %d, want 0", report.UsageAfter.Workspace.PendingUploadBytes)
	}
	if report.UsageAfter.Workspace.StorageBytes != report.UsageBefore.Workspace.StorageBytes {
		t.Fatalf("storage usage changed from %d to %d", report.UsageBefore.Workspace.StorageBytes, report.UsageAfter.Workspace.StorageBytes)
	}
	f.requireObjectDeleted(t, reservedOrphan.ObjectID)
	f.requireObjectDeleted(t, pendingOrphan.ObjectID)
	f.requireObjectDeleted(t, failedOrphan.ObjectID)
	f.requireLocalObjectMissing(t, pendingOrphan.StorageKey)
	f.requireLocalObjectMissing(t, failedOrphan.StorageKey)
	for _, object := range []sqlc.KukuSyncObject{genesisBody, genesisPack, incrementalBody, incrementalPack, latestBody, latestPack} {
		f.requireObjectNotDeleted(t, object.ObjectID)
	}
}

func TestSyncGCReportDoesNotExposePlaintextMarkers(t *testing.T) {
	object := sqlc.KukuSyncObject{
		ObjectID:    "obj_abc123",
		ObjectKind:  sqlc.KukuSyncObjectKindContentPack,
		UploadState: sqlc.KukuSyncObjectStatePending,
		SizeBytes:   12,
		StorageKey:  "sync/test/objects/obj_abc123",
	}
	rendered := fmt.Sprintf("%+v", objectCandidate(object))
	for _, marker := range []string{"notes.md", "workspace", "plaintext", "storage_key", object.StorageKey} {
		if strings.Contains(rendered, marker) {
			t.Fatalf("gc candidate report %q leaked marker %q", rendered, marker)
		}
	}
}

func (f publishFixture) reserveExpiredReservedObject(t *testing.T, ref string, expiresAt time.Time) sqlc.KukuSyncObject {
	t.Helper()
	object := f.reserveObject(t, ref, syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK)
	if _, err := f.pool.Exec(f.ctx, `
UPDATE kuku.sync_objects
SET expires_at = $3, updated_at = now()
WHERE workspace_id = $1 AND object_id = $2
`, f.workspace.ID, object.ObjectID, database.Timestamptz(expiresAt)); err != nil {
		t.Fatal(err)
	}
	return f.getObjectIncludingDeleted(t, object.ObjectID)
}

func (f publishFixture) reserveExpiredPendingObject(t *testing.T, ref string, payload []byte, expiresAt time.Time) sqlc.KukuSyncObject {
	t.Helper()
	object := f.reserveObject(t, ref, syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK)
	sha, size := objectMetadata(payload)
	if err := f.service.store.Put(f.ctx, object.StorageKey, payload); err != nil {
		t.Fatal(err)
	}
	pending, err := f.queries.MarkSyncObjectPending(f.ctx, sqlc.MarkSyncObjectPendingParams{
		WorkspaceID:      f.workspace.ID,
		ObjectID:         object.ObjectID,
		CiphertextSha256: sha,
		SizeBytes:        size,
		ExpiresAt:        database.Timestamptz(expiresAt),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.queries.AddSyncUsagePendingBytes(f.ctx, sqlc.AddSyncUsagePendingBytesParams{
		WorkspaceID:        f.workspace.ID,
		PendingUploadBytes: size,
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.queries.AddSyncUsageAccountPendingBytes(f.ctx, sqlc.AddSyncUsageAccountPendingBytesParams{
		UserID:             f.user.ID,
		PendingUploadBytes: size,
	}); err != nil {
		t.Fatal(err)
	}
	return pending
}

func (f publishFixture) reserveExpiredFailedObject(t *testing.T, ref string, payload []byte, expiresAt time.Time) sqlc.KukuSyncObject {
	t.Helper()
	object := f.reserveObject(t, ref, syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK)
	sha, size := objectMetadata(payload)
	if err := f.service.store.Put(f.ctx, object.StorageKey, payload); err != nil {
		t.Fatal(err)
	}
	pending, err := f.queries.MarkSyncObjectPending(f.ctx, sqlc.MarkSyncObjectPendingParams{
		WorkspaceID:      f.workspace.ID,
		ObjectID:         object.ObjectID,
		CiphertextSha256: sha,
		SizeBytes:        size,
		ExpiresAt:        database.Timestamptz(expiresAt),
	})
	if err != nil {
		t.Fatal(err)
	}
	failed, err := f.queries.MarkSyncObjectFailed(f.ctx, sqlc.MarkSyncObjectFailedParams{
		WorkspaceID: f.workspace.ID,
		ObjectID:    pending.ObjectID,
		ErrorReason: sqlc.NullKukuSyncObjectErrorReason{
			KukuSyncObjectErrorReason: sqlc.KukuSyncObjectErrorReasonStorageProviderError,
			Valid:                     true,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return failed
}

func (f publishFixture) requireObjectDeleted(t *testing.T, objectID string) {
	t.Helper()
	object := f.getObjectIncludingDeleted(t, objectID)
	if object.UploadState != sqlc.KukuSyncObjectStateDeleted || !object.DeletedAt.Valid {
		t.Fatalf("object %s state=%s deleted_at=%v, want deleted", objectID, object.UploadState, object.DeletedAt)
	}
}

func (f publishFixture) requireObjectNotDeleted(t *testing.T, objectID string) {
	t.Helper()
	object := f.getObjectIncludingDeleted(t, objectID)
	if object.UploadState == sqlc.KukuSyncObjectStateDeleted || object.DeletedAt.Valid {
		t.Fatalf("object %s state=%s deleted_at=%v, want not deleted", objectID, object.UploadState, object.DeletedAt)
	}
}

func (f publishFixture) getObjectIncludingDeleted(t *testing.T, objectID string) sqlc.KukuSyncObject {
	t.Helper()
	var object sqlc.KukuSyncObject
	if err := f.pool.QueryRow(f.ctx, `
SELECT workspace_id, object_id, object_kind, storage_provider, storage_key, ciphertext_sha256, size_bytes, upload_state, error_reason, created_by_device_id, created_at, updated_at, available_at, expires_at, deleted_at
FROM kuku.sync_objects
WHERE workspace_id = $1 AND object_id = $2
`, f.workspace.ID, objectID).Scan(
		&object.WorkspaceID,
		&object.ObjectID,
		&object.ObjectKind,
		&object.StorageProvider,
		&object.StorageKey,
		&object.CiphertextSha256,
		&object.SizeBytes,
		&object.UploadState,
		&object.ErrorReason,
		&object.CreatedByDeviceID,
		&object.CreatedAt,
		&object.UpdatedAt,
		&object.AvailableAt,
		&object.ExpiresAt,
		&object.DeletedAt,
	); err != nil {
		t.Fatal(err)
	}
	return object
}

func (f publishFixture) requireLocalObjectMissing(t *testing.T, storageKey string) {
	t.Helper()
	if _, err := f.service.store.Get(f.ctx, storageKey); !errors.Is(err, ErrObjectStoreNotFound) {
		t.Fatalf("Get(%q) error = %v, want ErrObjectStoreNotFound", storageKey, err)
	}
}
