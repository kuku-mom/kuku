package sync

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	syncv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1"

	"github.com/kuku-mom/kuku/apps/server/internal/config"
	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

func TestServiceIntegrationLocalMetadataRoundTrip(t *testing.T) {
	databaseURL := os.Getenv("KUKU_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("KUKU_TEST_DATABASE_URL is not set")
	}

	ctx := context.Background()
	pool, err := database.NewPool(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	migrationsDir := filepath.Join("..", "..", "sql", "migrations")
	if err := database.RunMigrations(ctx, pool, migrationsDir); err != nil {
		t.Fatal(err)
	}

	queries := sqlc.New(pool)
	user, err := queries.CreateUser(ctx, sqlc.CreateUserParams{
		Email:            "sync-" + uuid.NewString() + "@example.com",
		Name:             "Sync Test",
		EmailConfirmedAt: database.Timestamptz(time.Now().UTC()),
	})
	if err != nil {
		t.Fatal(err)
	}
	otherUser, err := queries.CreateUser(ctx, sqlc.CreateUserParams{
		Email:            "sync-other-" + uuid.NewString() + "@example.com",
		Name:             "Other Sync Test",
		EmailConfirmedAt: database.Timestamptz(time.Now().UTC()),
	})
	if err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		Env:                             "test",
		SyncDirectBytesDevEnabled:       true,
		SyncObjectStoreDriver:           "local",
		SyncLocalObjectDir:              t.TempDir(),
		SyncMaxWorkspacesPerUser:        5,
		SyncMaxTotalStorageBytesPerUser: 1024 * 1024,
		SyncMaxStorageBytesPerWorkspace: 1024 * 1024,
		SyncMaxSingleBlobBytes:          1024 * 1024,
		SyncMaxPendingUploadBytes:       1024 * 1024,
		SyncMaxPendingUploadAge:         24 * time.Hour,
	}
	store, err := NewObjectStore(cfg)
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, queries, cfg, store)

	accountKeyState, err := service.GetAccountKeyState(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if accountKeyState != nil {
		t.Fatalf("account key state = %+v, want nil before setup", accountKeyState)
	}
	accountSetup, err := service.CreateAccountKey(ctx, user.ID, CreateAccountKeyParams{
		AccountKeyID:      "account-key-" + uuid.NewString(),
		CryptoVersion:     "kuku-sync-v1",
		EnvelopeID:        "recovery:v1",
		RecipientType:     syncv1.SyncAccountKeyRecipientType_SYNC_ACCOUNT_KEY_RECIPIENT_TYPE_RECOVERY_PHRASE,
		KeyVersion:        1,
		KDFParamsJSON:     `{"name":"argon2id"}`,
		EncryptedEnvelope: []byte("encrypted-account-root-key"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if accountSetup.AccountKey.AccountKeyID == "" || accountSetup.Envelope.EnvelopeID != "recovery:v1" {
		t.Fatalf("account setup = %+v", accountSetup)
	}
	if _, err := service.CreateAccountKey(ctx, user.ID, CreateAccountKeyParams{
		AccountKeyID:      "other-account-key",
		CryptoVersion:     "kuku-sync-v1",
		EnvelopeID:        "recovery:v1",
		RecipientType:     syncv1.SyncAccountKeyRecipientType_SYNC_ACCOUNT_KEY_RECIPIENT_TYPE_RECOVERY_PHRASE,
		KeyVersion:        1,
		EncryptedEnvelope: []byte("encrypted-account-root-key"),
	}); !errors.Is(err, ErrAccountKeyExists) {
		t.Fatalf("duplicate account key error = %v, want ErrAccountKeyExists", err)
	}
	accountEnvelopes, err := service.ListAccountKeyEnvelopes(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(accountEnvelopes) != 1 {
		t.Fatalf("len(accountEnvelopes) = %d, want 1", len(accountEnvelopes))
	}

	workspace, err := service.CreateWorkspace(ctx, user.ID, "kuku-sync-v1")
	if err != nil {
		t.Fatal(err)
	}
	workspace, err = service.UpdateWorkspaceMetadata(ctx, user.ID, UpdateWorkspaceMetadataParams{
		WorkspaceID:             workspace.ID,
		EncryptedMetadata:       []byte("encrypted-workspace-name"),
		MetadataVersion:         1,
		ExpectedMetadataVersion: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if workspace.MetadataVersion != 1 || string(workspace.EncryptedMetadata) != "encrypted-workspace-name" {
		t.Fatalf("workspace metadata = %+v", workspace)
	}
	workspace, err = service.UpdateWorkspaceKey(ctx, user.ID, UpdateWorkspaceKeyParams{
		WorkspaceID:                 workspace.ID,
		EncryptedWorkspaceKey:       []byte("encrypted-workspace-key"),
		WorkspaceKeyVersion:         1,
		ExpectedWorkspaceKeyVersion: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if workspace.WorkspaceKeyVersion != 1 || string(workspace.EncryptedWorkspaceKey) != "encrypted-workspace-key" {
		t.Fatalf("workspace key metadata = %+v", workspace)
	}
	if _, err := service.UpdateWorkspaceMetadata(ctx, user.ID, UpdateWorkspaceMetadataParams{
		WorkspaceID:             workspace.ID,
		EncryptedMetadata:       []byte("stale"),
		MetadataVersion:         2,
		ExpectedMetadataVersion: 0,
	}); !errors.Is(err, ErrMetadataVersionConflict) {
		t.Fatalf("stale workspace metadata error = %v, want ErrMetadataVersionConflict", err)
	}
	workspaces, err := service.ListWorkspaces(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(workspaces) != 1 || workspaces[0].ID != workspace.ID || string(workspaces[0].EncryptedMetadata) != "encrypted-workspace-name" {
		t.Fatalf("workspaces = %+v", workspaces)
	}
	if _, err := service.GetWorkspace(ctx, otherUser.ID, workspace.ID); !errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("other user GetWorkspace error = %v, want ErrPermissionDenied", err)
	}
	signingPublicKey, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	device, err := service.RegisterDevice(ctx, user.ID, workspace.ID, signingPublicKey, nil, []byte("encrypted-name"))
	if err != nil {
		t.Fatal(err)
	}
	device, err = service.UpdateDeviceMetadata(ctx, user.ID, UpdateDeviceMetadataParams{
		WorkspaceID:             workspace.ID,
		DeviceID:                device.ID,
		EncryptedDeviceName:     []byte("encrypted-device-label"),
		MetadataVersion:         1,
		ExpectedMetadataVersion: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if device.MetadataVersion != 1 || string(device.EncryptedDeviceName) != "encrypted-device-label" {
		t.Fatalf("device metadata = %+v", device)
	}
	envelope, err := service.PutKeyEnvelope(ctx, user.ID, PutKeyEnvelopeParams{
		WorkspaceID:       workspace.ID,
		EnvelopeID:        "passphrase:v1",
		RecipientType:     syncv1.SyncKeyRecipientType_SYNC_KEY_RECIPIENT_TYPE_PASSPHRASE,
		KeyVersion:        1,
		KDFParamsJSON:     `{"name":"argon2id"}`,
		EncryptedEnvelope: []byte("encrypted-envelope"),
		CreatedByDeviceID: device.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if envelope.EnvelopeID != "passphrase:v1" {
		t.Fatalf("envelope id = %q", envelope.EnvelopeID)
	}
	envelopes, err := service.ListKeyEnvelopes(ctx, user.ID, workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(envelopes) != 1 {
		t.Fatalf("len(envelopes) = %d, want 1", len(envelopes))
	}

	reserved, err := service.ReserveObjectIDs(ctx, user.ID, workspace.ID, device.ID, []ObjectReservationRequest{{
		ClientObjectRef: "local-1",
		Kind:            syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(reserved) != 1 || reserved[0].Object.ObjectID == "" {
		t.Fatalf("reserved object missing: %+v", reserved)
	}
	if reserved[0].Object.StorageKey == "" || reserved[0].Object.StorageKey == reserved[0].Object.ObjectID {
		t.Fatalf("storage key not set correctly: %+v", reserved[0].Object)
	}
	expectedStoragePrefix := "sync/test/users/" + user.ID.String() + "/workspaces/" + workspace.ID.String() + "/objects/"
	if !strings.HasPrefix(reserved[0].Object.StorageKey, expectedStoragePrefix) {
		t.Fatalf("storage key = %q, want prefix %q", reserved[0].Object.StorageKey, expectedStoragePrefix)
	}

	payload := []byte("encrypted blob")
	sum := sha256.Sum256(payload)
	uploaded, err := service.UploadObjectBytesDev(ctx, user.ID, workspace.ID, device.ID, reserved[0].Object.ObjectID, hex.EncodeToString(sum[:]), int64(len(payload)), payload)
	if err != nil {
		t.Fatal(err)
	}
	if uploaded.UploadState != sqlc.KukuSyncObjectStateAvailable {
		t.Fatalf("upload state = %s", uploaded.UploadState)
	}
	downloadedObject, downloaded, err := service.DownloadObjectBytesDev(ctx, user.ID, workspace.ID, device.ID, reserved[0].Object.ObjectID)
	if err != nil {
		t.Fatal(err)
	}
	if downloadedObject.ObjectID != uploaded.ObjectID || string(downloaded) != string(payload) {
		t.Fatalf("download mismatch: object=%+v payload=%q", downloadedObject, downloaded)
	}

	usage, err := queries.EnsureSyncUsageAccount(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if usage.WorkspaceCount != 1 || usage.TotalStorageBytes != int64(len(payload)) {
		t.Fatalf("usage before delete = %+v, want one workspace and uploaded bytes", usage)
	}
	if err := service.DeleteWorkspace(ctx, user.ID, workspace.ID); err != nil {
		t.Fatal(err)
	}
	usage, err = queries.EnsureSyncUsageAccount(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if usage.WorkspaceCount != 0 || usage.TotalStorageBytes != 0 || usage.PendingUploadBytes != 0 {
		t.Fatalf("usage after delete = %+v, want released account quota", usage)
	}
	workspaces, err = service.ListWorkspaces(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(workspaces) != 0 {
		t.Fatalf("workspaces after delete = %+v, want empty", workspaces)
	}
}

func TestServiceIntegrationPublishCommitCorrectness(t *testing.T) {
	f := newPublishFixture(t)

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
	genesisResult, err := f.service.PublishCommit(f.ctx, f.user.ID, genesis)
	if err != nil {
		t.Fatal(err)
	}
	if genesisResult.Idempotent || genesisResult.HeadVersion != 1 || genesisResult.Commit.CommitID != genesis.CommitID {
		t.Fatalf("genesis result = %+v", genesisResult)
	}
	if count := f.commitObjectCount(t, genesis.CommitID); count != 2 {
		t.Fatalf("genesis commit object count = %d, want 2", count)
	}
	f.requireCursor(t, genesis.CommitID, genesis.CommitID)

	retryResult, err := f.service.PublishCommit(f.ctx, f.user.ID, genesis)
	if err != nil {
		t.Fatalf("idempotent retry error = %v", err)
	}
	if !retryResult.Idempotent || retryResult.HeadVersion != 1 || retryResult.Commit.CommitID != genesis.CommitID {
		t.Fatalf("retry result = %+v", retryResult)
	}

	differentPayload := f.sign(t, PublishCommitParams{
		WorkspaceID:          f.workspace.ID,
		CommitID:             genesis.CommitID,
		CommitKind:           syncv1.SyncCommitKind_SYNC_COMMIT_KIND_CHECKPOINT,
		ExpectedHeadCommitID: "",
		ParentCommitIDs:      nil,
		AuthorDeviceID:       f.device.ID,
		DeviceSeq:            2,
		BodyObjectID:         genesisBody.ObjectID,
		BodyCiphertextSHA256: genesisBody.CiphertextSha256,
		BodySizeBytes:        genesisBody.SizeBytes,
		ReferencedObjectIDs:  []string{genesisPack.ObjectID},
	})
	requireErrorIs(t, onlyErr(f.service.PublishCommit(f.ctx, f.user.ID, differentPayload)), ErrDuplicateCommitPayload)

	invalidParentBody := f.reserveAndUploadObject(t, "invalid-parent-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("invalid parent body"))
	invalidParent := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL,
		genesis.CommitID,
		nil,
		2,
		invalidParentBody,
	))
	requireErrorIs(t, onlyErr(f.service.PublishCommit(f.ctx, f.user.ID, invalidParent)), ErrInvalidCommitParent)

	incrementalBody := f.reserveAndUploadObject(t, "incremental-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("incremental body"))
	incremental := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL,
		genesis.CommitID,
		[]string{genesis.CommitID},
		2,
		incrementalBody,
	))
	incrementalResult, err := f.service.PublishCommit(f.ctx, f.user.ID, incremental)
	if err != nil {
		t.Fatal(err)
	}
	if incrementalResult.HeadVersion != 2 || incrementalResult.Commit.CommitID != incremental.CommitID {
		t.Fatalf("incremental result = %+v", incrementalResult)
	}
	if count := f.commitObjectCount(t, incremental.CommitID); count != 1 {
		t.Fatalf("incremental commit object count = %d, want 1", count)
	}
	f.requireCursor(t, incremental.CommitID, genesis.CommitID)

	duplicateSeqBody := f.reserveAndUploadObject(t, "duplicate-seq-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("duplicate seq body"))
	duplicateSeq := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL,
		incremental.CommitID,
		[]string{incremental.CommitID},
		2,
		duplicateSeqBody,
	))
	requireErrorIs(t, onlyErr(f.service.PublishCommit(f.ctx, f.user.ID, duplicateSeq)), ErrDuplicateDeviceSeq)

	staleBody := f.reserveAndUploadObject(t, "stale-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("stale body"))
	stale := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL,
		genesis.CommitID,
		[]string{genesis.CommitID},
		3,
		staleBody,
	))
	err = onlyErr(f.service.PublishCommit(f.ctx, f.user.ID, stale))
	conflict := requireHeadConflict(t, err)
	if conflict.CurrentHeadID != incremental.CommitID || conflict.HeadVersion != 2 {
		t.Fatalf("head conflict = %+v", conflict)
	}

	missingBody := f.sign(t, PublishCommitParams{
		WorkspaceID:          f.workspace.ID,
		CommitID:             "commit-" + uuid.NewString(),
		CommitKind:           syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL,
		ExpectedHeadCommitID: incremental.CommitID,
		ParentCommitIDs:      []string{incremental.CommitID},
		AuthorDeviceID:       f.device.ID,
		DeviceSeq:            3,
		BodyObjectID:         "missing-" + uuid.NewString(),
		BodyCiphertextSHA256: strings.Repeat("0", sha256.Size*2),
		BodySizeBytes:        12,
	})
	requireErrorIs(t, onlyErr(f.service.PublishCommit(f.ctx, f.user.ID, missingBody)), ErrObjectNotAvailable)

	missingRefBody := f.reserveAndUploadObject(t, "missing-ref-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("missing ref body"))
	missingRef := f.sign(t, PublishCommitParams{
		WorkspaceID:          f.workspace.ID,
		CommitID:             "commit-" + uuid.NewString(),
		CommitKind:           syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL,
		ExpectedHeadCommitID: incremental.CommitID,
		ParentCommitIDs:      []string{incremental.CommitID},
		AuthorDeviceID:       f.device.ID,
		DeviceSeq:            3,
		BodyObjectID:         missingRefBody.ObjectID,
		BodyCiphertextSHA256: missingRefBody.CiphertextSha256,
		BodySizeBytes:        missingRefBody.SizeBytes,
		ReferencedObjectIDs:  []string{"missing-ref-" + uuid.NewString()},
	})
	requireErrorIs(t, onlyErr(f.service.PublishCommit(f.ctx, f.user.ID, missingRef)), ErrObjectNotAvailable)

	pendingBody := f.reservePendingObject(t, "pending-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("pending body"))
	pending := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL,
		incremental.CommitID,
		[]string{incremental.CommitID},
		3,
		pendingBody,
	))
	requireErrorIs(t, onlyErr(f.service.PublishCommit(f.ctx, f.user.ID, pending)), ErrObjectNotAvailable)

	failedBody := f.reserveFailedObject(t, "failed-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("failed body"))
	failed := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL,
		incremental.CommitID,
		[]string{incremental.CommitID},
		3,
		failedBody,
	))
	requireErrorIs(t, onlyErr(f.service.PublishCommit(f.ctx, f.user.ID, failed)), ErrObjectNotAvailable)

	deletedBody := f.reserveObject(t, "deleted-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY)
	if _, err := f.pool.Exec(f.ctx, `UPDATE kuku.sync_objects SET deleted_at = now(), updated_at = now() WHERE workspace_id = $1 AND object_id = $2`, f.workspace.ID, deletedBody.ObjectID); err != nil {
		t.Fatal(err)
	}
	deletedBody.CiphertextSha256 = strings.Repeat("1", sha256.Size*2)
	deletedBody.SizeBytes = 12
	deleted := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL,
		incremental.CommitID,
		[]string{incremental.CommitID},
		3,
		deletedBody,
	))
	requireErrorIs(t, onlyErr(f.service.PublishCommit(f.ctx, f.user.ID, deleted)), ErrObjectNotAvailable)

	hashMismatchBody := f.reserveAndUploadObject(t, "hash-mismatch-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("hash mismatch body"))
	hashMismatch := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL,
		incremental.CommitID,
		[]string{incremental.CommitID},
		3,
		hashMismatchBody,
	))
	hashMismatch.BodyCiphertextSHA256 = strings.Repeat("0", sha256.Size*2)
	hashMismatch = f.sign(t, hashMismatch)
	requireErrorIs(t, onlyErr(f.service.PublishCommit(f.ctx, f.user.ID, hashMismatch)), ErrObjectMetadataMismatch)

	sizeMismatchBody := f.reserveAndUploadObject(t, "size-mismatch-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("size mismatch body"))
	sizeMismatch := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL,
		incremental.CommitID,
		[]string{incremental.CommitID},
		3,
		sizeMismatchBody,
	))
	sizeMismatch.BodySizeBytes++
	sizeMismatch = f.sign(t, sizeMismatch)
	requireErrorIs(t, onlyErr(f.service.PublishCommit(f.ctx, f.user.ID, sizeMismatch)), ErrObjectMetadataMismatch)

	checkpointWithoutPackBody := f.reserveAndUploadObject(t, "checkpoint-without-pack-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("checkpoint without pack body"))
	contentPack := f.reserveAndUploadObject(t, "content-pack", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK, []byte("content pack"))
	checkpointWithoutPack := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_CHECKPOINT,
		incremental.CommitID,
		[]string{incremental.CommitID},
		3,
		checkpointWithoutPackBody,
		contentPack,
	))
	requireErrorIs(t, onlyErr(f.service.PublishCommit(f.ctx, f.user.ID, checkpointWithoutPack)), ErrObjectNotAvailable)

	checkpointInvalidParentBody := f.reserveAndUploadObject(t, "checkpoint-invalid-parent-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("checkpoint invalid parent body"))
	checkpointPack := f.reserveAndUploadObject(t, "checkpoint-pack", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CHECKPOINT_PACK, []byte("checkpoint pack"))
	checkpointInvalidParent := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_CHECKPOINT,
		incremental.CommitID,
		nil,
		3,
		checkpointInvalidParentBody,
		checkpointPack,
	))
	requireErrorIs(t, onlyErr(f.service.PublishCommit(f.ctx, f.user.ID, checkpointInvalidParent)), ErrInvalidCommitParent)

	mergeInvalidBody := f.reserveAndUploadObject(t, "merge-invalid-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("merge invalid body"))
	mergeInvalid := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_MERGE,
		incremental.CommitID,
		[]string{incremental.CommitID},
		3,
		mergeInvalidBody,
	))
	requireErrorIs(t, onlyErr(f.service.PublishCommit(f.ctx, f.user.ID, mergeInvalid)), ErrInvalidCommitParent)

	invalidSignatureBody := f.reserveAndUploadObject(t, "invalid-signature-body", syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY, []byte("invalid signature body"))
	invalidSignature := f.sign(t, f.publishParams(
		syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL,
		incremental.CommitID,
		[]string{incremental.CommitID},
		3,
		invalidSignatureBody,
	))
	invalidSignature.Signature[0] ^= 0xff
	requireErrorIs(t, onlyErr(f.service.PublishCommit(f.ctx, f.user.ID, invalidSignature)), ErrInvalidSignature)

	workspaceAfter, err := f.service.GetWorkspace(f.ctx, f.user.ID, f.workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if textValue(workspaceAfter.CurrentHeadCommitID) != incremental.CommitID || workspaceAfter.HeadVersion != 2 {
		t.Fatalf("workspace after failures = %+v", workspaceAfter)
	}
	deviceAfter, err := f.queries.GetActiveSyncDevice(f.ctx, sqlc.GetActiveSyncDeviceParams{
		WorkspaceID: f.workspace.ID,
		ID:          f.device.ID,
		UserID:      f.user.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if deviceAfter.LastDeviceSeq != 2 {
		t.Fatalf("device sequence after failures = %d, want 2", deviceAfter.LastDeviceSeq)
	}
}

func TestHandlerServiceErrorHeadConflictDetail(t *testing.T) {
	err := (&Handler{}).serviceError(context.Background(), &HeadConflictError{
		WorkspaceID:   "workspace-1",
		CurrentHeadID: "commit-1",
		HeadVersion:   7,
	})
	if connect.CodeOf(err) != connect.CodeAborted {
		t.Fatalf("code = %s, want %s", connect.CodeOf(err), connect.CodeAborted)
	}
	var connectErr *connect.Error
	if !errors.As(err, &connectErr) {
		t.Fatalf("error type = %T, want *connect.Error", err)
	}
	if len(connectErr.Details()) != 1 {
		t.Fatalf("detail count = %d, want 1", len(connectErr.Details()))
	}
	value, err := connectErr.Details()[0].Value()
	if err != nil {
		t.Fatal(err)
	}
	detail, ok := value.(*syncv1.HeadConflictDetail)
	if !ok {
		t.Fatalf("detail type = %T, want *HeadConflictDetail", value)
	}
	if detail.GetWorkspaceId() != "workspace-1" || detail.GetCurrentHeadCommitId() != "commit-1" || detail.GetHeadVersion() != 7 {
		t.Fatalf("detail = %+v", detail)
	}
}

func TestHandlerServiceErrorMetadataVersionConflict(t *testing.T) {
	err := (&Handler{}).serviceError(context.Background(), ErrMetadataVersionConflict)

	if connect.CodeOf(err) != connect.CodeAborted {
		t.Fatalf("code = %s, want %s", connect.CodeOf(err), connect.CodeAborted)
	}
}

type publishFixture struct {
	ctx       context.Context
	pool      *pgxpool.Pool
	queries   *sqlc.Queries
	service   *Service
	user      sqlc.AuthUser
	workspace sqlc.KukuSyncWorkspace
	device    sqlc.KukuSyncDevice
	private   ed25519.PrivateKey
}

func newPublishFixture(t *testing.T) publishFixture {
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
		Email:            "sync-publish-" + uuid.NewString() + "@example.com",
		Name:             "Sync Publish Test",
		EmailConfirmedAt: database.Timestamptz(time.Now().UTC()),
	})
	if err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		Env:                             "test",
		SyncDirectBytesDevEnabled:       true,
		SyncObjectStoreDriver:           "local",
		SyncLocalObjectDir:              t.TempDir(),
		SyncMaxWorkspacesPerUser:        5,
		SyncMaxTotalStorageBytesPerUser: 1024 * 1024,
		SyncMaxStorageBytesPerWorkspace: 1024 * 1024,
		SyncMaxSingleBlobBytes:          1024 * 1024,
		SyncMaxPendingUploadBytes:       1024 * 1024,
		SyncMaxPendingUploadAge:         24 * time.Hour,
	}
	store, err := NewObjectStore(cfg)
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(pool, queries, cfg, store)
	workspace, err := service.CreateWorkspace(ctx, user.ID, "kuku-sync-v1")
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	device, err := service.RegisterDevice(ctx, user.ID, workspace.ID, public, nil, []byte("encrypted-device-name"))
	if err != nil {
		t.Fatal(err)
	}
	return publishFixture{
		ctx:       ctx,
		pool:      pool,
		queries:   queries,
		service:   service,
		user:      user,
		workspace: workspace,
		device:    device,
		private:   private,
	}
}

func (f publishFixture) reserveObject(t *testing.T, ref string, kind syncv1.SyncObjectKind) sqlc.KukuSyncObject {
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

func (f publishFixture) reserveAndUploadObject(t *testing.T, ref string, kind syncv1.SyncObjectKind, payload []byte) sqlc.KukuSyncObject {
	t.Helper()
	object := f.reserveObject(t, ref, kind)
	sha, size := objectMetadata(payload)
	uploaded, err := f.service.UploadObjectBytesDev(f.ctx, f.user.ID, f.workspace.ID, f.device.ID, object.ObjectID, sha, size, payload)
	if err != nil {
		t.Fatal(err)
	}
	return uploaded
}

func (f publishFixture) reservePendingObject(t *testing.T, ref string, kind syncv1.SyncObjectKind, payload []byte) sqlc.KukuSyncObject {
	t.Helper()
	object := f.reserveObject(t, ref, kind)
	sha, size := objectMetadata(payload)
	pending, err := f.queries.MarkSyncObjectPending(f.ctx, sqlc.MarkSyncObjectPendingParams{
		WorkspaceID:      f.workspace.ID,
		ObjectID:         object.ObjectID,
		CiphertextSha256: sha,
		SizeBytes:        size,
		ExpiresAt:        database.Timestamptz(time.Now().UTC().Add(time.Hour)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return pending
}

func (f publishFixture) reserveFailedObject(t *testing.T, ref string, kind syncv1.SyncObjectKind, payload []byte) sqlc.KukuSyncObject {
	t.Helper()
	pending := f.reservePendingObject(t, ref, kind, payload)
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

func (f publishFixture) commitObjectCount(t *testing.T, commitID string) int {
	t.Helper()
	var count int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM kuku.sync_commit_objects WHERE workspace_id = $1 AND commit_id = $2`, f.workspace.ID, commitID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func (f publishFixture) requireCursor(t *testing.T, wantCommitID, wantCheckpointID string) {
	t.Helper()
	var lastSeen pgtype.Text
	var lastCheckpoint pgtype.Text
	if err := f.pool.QueryRow(f.ctx, `SELECT last_seen_commit_id, last_seen_checkpoint_commit_id FROM kuku.sync_device_cursors WHERE workspace_id = $1 AND device_id = $2`, f.workspace.ID, f.device.ID).Scan(&lastSeen, &lastCheckpoint); err != nil {
		t.Fatal(err)
	}
	if textValue(lastSeen) != wantCommitID || textValue(lastCheckpoint) != wantCheckpointID {
		t.Fatalf("cursor last_seen=%q last_checkpoint=%q, want %q/%q", textValue(lastSeen), textValue(lastCheckpoint), wantCommitID, wantCheckpointID)
	}
}

func (f publishFixture) publishParams(kind syncv1.SyncCommitKind, expectedHead string, parentIDs []string, deviceSeq int64, body sqlc.KukuSyncObject, refs ...sqlc.KukuSyncObject) PublishCommitParams {
	referencedObjectIDs := make([]string, 0, len(refs))
	for _, ref := range refs {
		referencedObjectIDs = append(referencedObjectIDs, ref.ObjectID)
	}
	return PublishCommitParams{
		WorkspaceID:          f.workspace.ID,
		CommitID:             "commit-" + uuid.NewString(),
		CommitKind:           kind,
		ExpectedHeadCommitID: expectedHead,
		ParentCommitIDs:      parentIDs,
		AuthorDeviceID:       f.device.ID,
		DeviceSeq:            deviceSeq,
		BodyObjectID:         body.ObjectID,
		BodyCiphertextSHA256: body.CiphertextSha256,
		BodySizeBytes:        body.SizeBytes,
		ReferencedObjectIDs:  referencedObjectIDs,
	}
}

func (f publishFixture) sign(t *testing.T, params PublishCommitParams) PublishCommitParams {
	t.Helper()
	params.Signature = make([]byte, ed25519.SignatureSize)
	normalized, err := normalizePublishCommitParams(params)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := canonicalCommitPayload(normalized)
	if err != nil {
		t.Fatal(err)
	}
	normalized.Signature = ed25519.Sign(f.private, payload)
	return normalized
}

func objectMetadata(payload []byte) (string, int64) {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), int64(len(payload))
}

func requireErrorIs(t *testing.T, err error, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("error = %v, want %v", err, target)
	}
}

func requireHeadConflict(t *testing.T, err error) *HeadConflictError {
	t.Helper()
	var conflict *HeadConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("error = %v, want HeadConflictError", err)
	}
	return conflict
}

func onlyErr(_ PublishCommitResult, err error) error {
	return err
}
