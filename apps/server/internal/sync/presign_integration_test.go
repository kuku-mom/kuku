package sync

import (
	"context"
	"crypto/ed25519"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	syncv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1"

	"github.com/kuku-mom/kuku/apps/server/internal/config"
	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

func TestServiceIntegrationPresignedTransferRoundTrip(t *testing.T) {
	f := newTransferFixture(t, nil)
	object := f.reserveObject(t, "content-pack", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK)
	sha, size := objectMetadata([]byte("encrypted pack"))

	targets, err := f.service.CreateObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "attempt-1", []UploadObjectRequest{{
		ObjectID:         object.ObjectID,
		Kind:             syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 1 || targets[0].ObjectID != object.ObjectID {
		t.Fatalf("targets = %+v", targets)
	}
	if !strings.Contains(targets[0].PutURL, object.StorageKey) {
		t.Fatalf("put url %q does not contain storage key %q", targets[0].PutURL, object.StorageKey)
	}
	if targets[0].RequiredHeaders["Content-Type"] != EncryptedObjectContentType {
		t.Fatalf("required headers = %+v", targets[0].RequiredHeaders)
	}
	retryTargets, err := f.service.CreateObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "attempt-1", []UploadObjectRequest{{
		ObjectID:         object.ObjectID,
		Kind:             syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(retryTargets) != 1 || retryTargets[0].ObjectID != object.ObjectID {
		t.Fatalf("retry targets = %+v", retryTargets)
	}
	f.requireUsage(t, 0, size)
	f.store.head[object.StorageKey] = ObjectStoreMetadata{SizeBytes: size, CiphertextSHA256: sha}

	results, err := f.service.CompleteObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "attempt-1", []CompletedObjectUploadRequest{{
		ObjectID:         object.ObjectID,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Object.UploadState != sqlc.KukuSyncObjectStateAvailable || results[0].ErrorReason.Valid {
		t.Fatalf("completion results = %+v", results)
	}
	f.requireUsage(t, size, 0)

	downloads, err := f.service.CreateObjectDownloadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, []string{object.ObjectID})
	if err != nil {
		t.Fatal(err)
	}
	if len(downloads) != 1 || downloads[0].Object.ObjectID != object.ObjectID {
		t.Fatalf("downloads = %+v", downloads)
	}
	if downloads[0].Object.CiphertextSha256 != sha || downloads[0].Object.SizeBytes != size {
		t.Fatalf("download metadata = %+v", downloads[0].Object)
	}
}

func TestServiceIntegrationDeletedWorkspaceCleanupDeletesBlobsAndRows(t *testing.T) {
	f := newTransferFixture(t, nil)
	object := f.reserveObject(t, "content-pack", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK)
	f.completePresignedObject(t, object, []byte("encrypted pack"), "attempt-cleanup")
	if _, ok := f.store.head[object.StorageKey]; !ok {
		t.Fatalf("object %q was not present in fake store", object.StorageKey)
	}

	if err := f.queries.MarkSyncObjectsDeletedByOwner(f.ctx, f.user.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.queries.SoftDeleteSyncWorkspacesByOwner(f.ctx, f.user.ID); err != nil {
		t.Fatal(err)
	}

	report, err := f.service.RunDeletedWorkspaceCleanup(f.ctx, DeletedWorkspaceCleanupOptions{
		Now:            time.Now().UTC(),
		WorkspaceLimit: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.DeletedWorkspaces) != 1 || report.DeletedWorkspaces[0] != f.workspace.ID || report.DeletedObjectKeys != 1 {
		t.Fatalf("cleanup report = %+v", report)
	}
	if _, ok := f.store.head[object.StorageKey]; ok {
		t.Fatalf("object %q still present in fake store", object.StorageKey)
	}

	var workspaceRows int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*)::INTEGER FROM kuku.sync_workspaces WHERE id = $1`, f.workspace.ID).Scan(&workspaceRows); err != nil {
		t.Fatal(err)
	}
	if workspaceRows != 0 {
		t.Fatalf("workspace rows = %d, want 0", workspaceRows)
	}
}

func TestServiceIntegrationPresignedCompleteMismatchReleasesPendingQuota(t *testing.T) {
	f := newTransferFixture(t, nil)
	object := f.reserveObject(t, "content-pack", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK)
	sha, size := objectMetadata([]byte("encrypted pack"))
	if _, err := f.service.CreateObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "attempt-1", []UploadObjectRequest{{
		ObjectID:         object.ObjectID,
		Kind:             syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}}); err != nil {
		t.Fatal(err)
	}
	f.requireUsage(t, 0, size)
	f.store.head[object.StorageKey] = ObjectStoreMetadata{SizeBytes: size + 1, CiphertextSHA256: sha}

	results, err := f.service.CompleteObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "attempt-1", []CompletedObjectUploadRequest{{
		ObjectID:         object.ObjectID,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !results[0].ErrorReason.Valid || results[0].ErrorReason.KukuSyncObjectErrorReason != sqlc.KukuSyncObjectErrorReasonSizeMismatch {
		t.Fatalf("completion results = %+v", results)
	}
	f.requireUsage(t, 0, 0)
}

func TestServiceIntegrationPresignedCompleteChecksumMismatchReleasesPendingQuota(t *testing.T) {
	f := newTransferFixture(t, nil)
	object := f.reserveObject(t, "content-pack", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK)
	sha, size := objectMetadata([]byte("encrypted pack"))
	if _, err := f.service.CreateObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "attempt-1", []UploadObjectRequest{{
		ObjectID:         object.ObjectID,
		Kind:             syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}}); err != nil {
		t.Fatal(err)
	}
	f.store.head[object.StorageKey] = ObjectStoreMetadata{SizeBytes: size, CiphertextSHA256: strings.Repeat("0", 64)}

	results, err := f.service.CompleteObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "attempt-1", []CompletedObjectUploadRequest{{
		ObjectID:         object.ObjectID,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !results[0].ErrorReason.Valid || results[0].ErrorReason.KukuSyncObjectErrorReason != sqlc.KukuSyncObjectErrorReasonChecksumMismatch {
		t.Fatalf("completion results = %+v", results)
	}
	f.requireUsage(t, 0, 0)
}

func TestServiceIntegrationPresignedQuotaAndAuthorization(t *testing.T) {
	f := newTransferFixture(t, func(cfg *config.Config) {
		cfg.SyncMaxPendingUploadBytes = 8
	})
	object := f.reserveObject(t, "content-pack", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK)
	sha, size := objectMetadata([]byte("encrypted pack"))

	_, err := f.service.CreateObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "attempt-1", []UploadObjectRequest{{
		ObjectID:         object.ObjectID,
		Kind:             syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}})
	var quota *QuotaError
	if !errors.As(err, &quota) || quota.Limit != syncv1.SyncQuotaLimit_SYNC_QUOTA_LIMIT_PENDING_UPLOAD_BYTES {
		t.Fatalf("error = %v, want pending quota", err)
	}

	_, err = f.service.CreateObjectUploadBatch(f.ctx, f.otherUser.ID, f.workspace.ID, f.device.ID, "attempt-2", []UploadObjectRequest{{
		ObjectID:         object.ObjectID,
		Kind:             syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK,
		CiphertextSHA256: sha,
		SizeBytes:        1,
	}})
	requireErrorIs(t, err, ErrPermissionDenied)
}

func TestServiceIntegrationWorkspaceCountQuota(t *testing.T) {
	f := newTransferFixture(t, func(cfg *config.Config) {
		cfg.SyncMaxWorkspacesPerUser = 1
	})
	_, err := f.service.CreateWorkspace(f.ctx, f.user.ID, "kuku-sync-v1")
	var quota *QuotaError
	if !errors.As(err, &quota) || quota.Limit != syncv1.SyncQuotaLimit_SYNC_QUOTA_LIMIT_WORKSPACE_COUNT {
		t.Fatalf("error = %v, want workspace count quota", err)
	}
}

func TestServiceIntegrationPresignedSingleBlobTooLarge(t *testing.T) {
	f := newTransferFixture(t, func(cfg *config.Config) {
		cfg.SyncMaxSingleBlobBytes = 8
	})
	object := f.reserveObject(t, "content-pack", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK)
	sha, size := objectMetadata([]byte("encrypted pack"))

	_, err := f.service.CreateObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "attempt-1", []UploadObjectRequest{{
		ObjectID:         object.ObjectID,
		Kind:             syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}})
	var quota *QuotaError
	if !errors.As(err, &quota) || quota.Limit != syncv1.SyncQuotaLimit_SYNC_QUOTA_LIMIT_SINGLE_BLOB_BYTES {
		t.Fatalf("error = %v, want single blob quota", err)
	}
}

func TestServiceIntegrationPresignedUserTotalStorageQuota(t *testing.T) {
	f := newTransferFixture(t, func(cfg *config.Config) {
		cfg.SyncMaxTotalStorageBytesPerUser = 20
		cfg.SyncMaxStorageBytesPerWorkspace = 1024
	})
	payload := []byte("encrypted pack")
	f.completePresignedObject(t, f.reserveObject(t, "content-pack-1", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK), payload, "attempt-1")

	object := f.reserveObject(t, "content-pack-2", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK)
	sha, size := objectMetadata(payload)
	_, err := f.service.CreateObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "attempt-2", []UploadObjectRequest{{
		ObjectID:         object.ObjectID,
		Kind:             syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}})
	var quota *QuotaError
	if !errors.As(err, &quota) || quota.Limit != syncv1.SyncQuotaLimit_SYNC_QUOTA_LIMIT_USER_TOTAL_STORAGE_BYTES {
		t.Fatalf("error = %v, want user total storage quota", err)
	}
}

func TestServiceIntegrationPresignedWorkspaceStorageQuota(t *testing.T) {
	f := newTransferFixture(t, func(cfg *config.Config) {
		cfg.SyncMaxTotalStorageBytesPerUser = 1024
		cfg.SyncMaxStorageBytesPerWorkspace = 20
	})
	payload := []byte("encrypted pack")
	f.completePresignedObject(t, f.reserveObject(t, "content-pack-1", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK), payload, "attempt-1")

	object := f.reserveObject(t, "content-pack-2", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK)
	sha, size := objectMetadata(payload)
	_, err := f.service.CreateObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "attempt-2", []UploadObjectRequest{{
		ObjectID:         object.ObjectID,
		Kind:             syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}})
	var quota *QuotaError
	if !errors.As(err, &quota) || quota.Limit != syncv1.SyncQuotaLimit_SYNC_QUOTA_LIMIT_WORKSPACE_STORAGE_BYTES {
		t.Fatalf("error = %v, want workspace storage quota", err)
	}
}

func TestServiceIntegrationPresignedCompleteExpiredUpload(t *testing.T) {
	f := newTransferFixture(t, func(cfg *config.Config) {
		cfg.SyncMaxPendingUploadAge = time.Hour
	})
	start := time.Date(2026, 5, 7, 1, 0, 0, 0, time.UTC)
	f.service.now = func() time.Time { return start }
	object := f.reserveObject(t, "content-pack", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK)
	sha, size := objectMetadata([]byte("encrypted pack"))
	if _, err := f.service.CreateObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "attempt-1", []UploadObjectRequest{{
		ObjectID:         object.ObjectID,
		Kind:             syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}}); err != nil {
		t.Fatal(err)
	}
	f.store.head[object.StorageKey] = ObjectStoreMetadata{SizeBytes: size, CiphertextSHA256: sha}
	f.service.now = func() time.Time { return start.Add(2 * time.Hour) }

	results, err := f.service.CompleteObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "attempt-1", []CompletedObjectUploadRequest{{
		ObjectID:         object.ObjectID,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !results[0].ErrorReason.Valid || results[0].ErrorReason.KukuSyncObjectErrorReason != sqlc.KukuSyncObjectErrorReasonUploadExpired {
		t.Fatalf("completion results = %+v", results)
	}
	f.requireUsage(t, 0, 0)
}

func TestServiceIntegrationConcurrentUploadBatchesCannotBypassQuota(t *testing.T) {
	f := newTransferFixture(t, func(cfg *config.Config) {
		cfg.SyncMaxPendingUploadBytes = 20
	})
	payload := []byte("encrypted pack")
	sha, size := objectMetadata(payload)
	if size*2 <= f.service.cfg.SyncMaxPendingUploadBytes {
		t.Fatalf("test payload size %d is too small for quota %d", size, f.service.cfg.SyncMaxPendingUploadBytes)
	}
	objects := []sqlc.KukuSyncObject{
		f.reserveObject(t, "content-pack-1", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK),
		f.reserveObject(t, "content-pack-2", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK),
	}

	start := make(chan struct{})
	errs := make([]error, len(objects))
	var wg sync.WaitGroup
	for idx, object := range objects {
		wg.Add(1)
		go func(idx int, object sqlc.KukuSyncObject) {
			defer wg.Done()
			<-start
			_, errs[idx] = f.service.CreateObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, "attempt-concurrent-"+object.ObjectID, []UploadObjectRequest{{
				ObjectID:         object.ObjectID,
				Kind:             syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK,
				CiphertextSHA256: sha,
				SizeBytes:        size,
			}})
		}(idx, object)
	}
	close(start)
	wg.Wait()

	successes := 0
	quotaErrors := 0
	for _, err := range errs {
		if err == nil {
			successes++
			continue
		}
		var quota *QuotaError
		if errors.As(err, &quota) && quota.Limit == syncv1.SyncQuotaLimit_SYNC_QUOTA_LIMIT_PENDING_UPLOAD_BYTES {
			quotaErrors++
			continue
		}
		t.Fatalf("unexpected concurrent upload error: %v", err)
	}
	if successes != 1 || quotaErrors != 1 {
		t.Fatalf("concurrent upload outcomes successes=%d quota=%d, want 1/1", successes, quotaErrors)
	}
	f.requireUsage(t, 0, size)
}

type transferFixture struct {
	ctx       context.Context
	pool      *pgxpool.Pool
	queries   *sqlc.Queries
	service   *Service
	store     *fakePresignStore
	user      sqlc.AuthUser
	otherUser sqlc.AuthUser
	workspace sqlc.KukuSyncWorkspace
	device    sqlc.KukuSyncDevice
}

func newTransferFixture(t *testing.T, configure func(*config.Config)) transferFixture {
	t.Helper()
	databaseURL := os.Getenv("KUKU_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("KUKU_TEST_DATABASE_URL is not set")
	}

	ctx := context.Background()
	pool, err := database.NewPool(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	migrationsDir := filepath.Join("..", "..", "sql", "migrations")
	if err := database.RunMigrations(ctx, pool, migrationsDir); err != nil {
		t.Fatal(err)
	}
	queries := sqlc.New(pool)
	user, err := queries.CreateUser(ctx, sqlc.CreateUserParams{
		Email:            "sync-transfer-" + uuid.NewString() + "@example.com",
		Name:             "Sync Transfer Test",
		EmailConfirmedAt: database.Timestamptz(time.Now().UTC()),
	})
	if err != nil {
		t.Fatal(err)
	}
	otherUser, err := queries.CreateUser(ctx, sqlc.CreateUserParams{
		Email:            "sync-transfer-other-" + uuid.NewString() + "@example.com",
		Name:             "Other Sync Transfer Test",
		EmailConfirmedAt: database.Timestamptz(time.Now().UTC()),
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{
		Env:                             "test",
		SyncObjectStoreDriver:           "s3_compatible",
		SyncS3Endpoint:                  "https://objects.example",
		SyncS3Region:                    "auto",
		SyncS3Bucket:                    "kuku-sync-test",
		SyncPresignTTL:                  10 * time.Minute,
		SyncMaxWorkspacesPerUser:        5,
		SyncMaxTotalStorageBytesPerUser: 1024 * 1024,
		SyncMaxStorageBytesPerWorkspace: 1024 * 1024,
		SyncMaxSingleBlobBytes:          1024 * 1024,
		SyncMaxPendingUploadBytes:       1024 * 1024,
		SyncMaxPendingUploadAge:         24 * time.Hour,
	}
	if configure != nil {
		configure(cfg)
	}
	store := &fakePresignStore{head: make(map[string]ObjectStoreMetadata)}
	service := NewService(pool, queries, cfg, store)
	workspace, err := service.CreateWorkspace(ctx, user.ID, "kuku-sync-v1")
	if err != nil {
		t.Fatal(err)
	}
	public, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	device, err := service.RegisterDevice(ctx, user.ID, workspace.ID, public, nil, []byte("encrypted-device-name"))
	if err != nil {
		t.Fatal(err)
	}
	return transferFixture{
		ctx:       ctx,
		pool:      pool,
		queries:   queries,
		service:   service,
		store:     store,
		user:      user,
		otherUser: otherUser,
		workspace: workspace,
		device:    device,
	}
}

func (f transferFixture) reserveObject(t *testing.T, ref string, kind syncv1.SyncObjectKind) sqlc.KukuSyncObject {
	t.Helper()
	reserved, err := f.service.ReserveObjectIDs(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, []ObjectReservationRequest{{
		ClientObjectRef: ref,
		Kind:            kind,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(reserved) != 1 {
		t.Fatalf("reserved count = %d, want 1", len(reserved))
	}
	return reserved[0].Object
}

func (f transferFixture) completePresignedObject(t *testing.T, object sqlc.KukuSyncObject, payload []byte, uploadAttemptID string) {
	t.Helper()
	sha, size := objectMetadata(payload)
	if _, err := f.service.CreateObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, uploadAttemptID, []UploadObjectRequest{{
		ObjectID:         object.ObjectID,
		Kind:             syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}}); err != nil {
		t.Fatal(err)
	}
	f.store.head[object.StorageKey] = ObjectStoreMetadata{SizeBytes: size, CiphertextSHA256: sha}
	results, err := f.service.CompleteObjectUploadBatch(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, uploadAttemptID, []CompletedObjectUploadRequest{{
		ObjectID:         object.ObjectID,
		CiphertextSHA256: sha,
		SizeBytes:        size,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Object.UploadState != sqlc.KukuSyncObjectStateAvailable || results[0].ErrorReason.Valid {
		t.Fatalf("completion results = %+v", results)
	}
}

func (f transferFixture) requireUsage(t *testing.T, storageBytes, pendingBytes int64) {
	t.Helper()
	usage, err := f.queries.GetSyncUsageWorkspaceForUpdate(f.ctx, f.workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if usage.StorageBytes != storageBytes || usage.PendingUploadBytes != pendingBytes {
		t.Fatalf("usage storage=%d pending=%d, want %d/%d", usage.StorageBytes, usage.PendingUploadBytes, storageBytes, pendingBytes)
	}
}

type fakePresignStore struct {
	head map[string]ObjectStoreMetadata
}

func (s *fakePresignStore) Provider() sqlc.KukuSyncStorageProvider {
	return sqlc.KukuSyncStorageProviderS3Compatible
}

func (s *fakePresignStore) Put(context.Context, string, []byte) error {
	return ErrDevBytesDisabled
}

func (s *fakePresignStore) Get(context.Context, string) ([]byte, error) {
	return nil, ErrDevBytesDisabled
}

func (s *fakePresignStore) Delete(_ context.Context, storageKey string) error {
	delete(s.head, storageKey)
	return nil
}

func (s *fakePresignStore) PresignPut(_ context.Context, storageKey, ciphertextSHA256 string, _ int64, ttl time.Duration) (PresignedObjectURL, error) {
	return PresignedObjectURL{
		URL: "https://objects.example/upload/" + storageKey,
		RequiredHeaders: map[string]string{
			"Content-Type":           EncryptedObjectContentType,
			"X-Amz-Meta-Kuku-Sha256": ciphertextSHA256,
		},
		ExpiresAt: time.Now().UTC().Add(ttl),
	}, nil
}

func (s *fakePresignStore) PresignGet(_ context.Context, storageKey string, ttl time.Duration) (PresignedObjectURL, error) {
	return PresignedObjectURL{
		URL:             "https://objects.example/download/" + storageKey,
		RequiredHeaders: map[string]string{},
		ExpiresAt:       time.Now().UTC().Add(ttl),
	}, nil
}

func (s *fakePresignStore) Head(_ context.Context, storageKey string) (ObjectStoreMetadata, error) {
	metadata, ok := s.head[storageKey]
	if !ok {
		return ObjectStoreMetadata{}, ErrObjectStoreNotFound
	}
	return metadata, nil
}
