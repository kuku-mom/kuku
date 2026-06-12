package auth

import (
	"context"
	"crypto/ed25519"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/kuku-mom/kuku/apps/server/internal/config"
	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

type noopEmailSender struct{}

func (noopEmailSender) SendAuthCode(context.Context, string, string) error {
	return nil
}

func TestAuthRefreshTokensConsumesRefreshTokenAtomically(t *testing.T) {
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
		Email:            "auth-refresh-race-" + uuid.NewString() + "@example.com",
		Name:             "Auth Refresh Race Test",
		EmailConfirmedAt: database.Timestamptz(time.Now().UTC()),
	})
	if err != nil {
		t.Fatal(err)
	}
	service := NewAuthService(&config.Config{
		JWTSecret:         "test-refresh-secret",
		SessionMaxAge:     time.Hour,
		SessionInactivity: time.Hour,
	}, pool, queries, noopEmailSender{}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	initial, err := service.createSessionAndTokens(ctx, user, "test", "127.0.0.1", desktopAccessExpiry, desktopRefreshExpiry)
	if err != nil {
		t.Fatal(err)
	}

	const attempts = 8
	start := make(chan struct{})
	successes := make(chan *TokenPair, attempts)
	failures := make(chan error, attempts)
	var wg sync.WaitGroup
	for range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			pair, err := service.RefreshDesktopTokens(ctx, initial.RefreshToken, "127.0.0.1", "test")
			if err != nil {
				failures <- err
				return
			}
			successes <- pair
		}()
	}
	close(start)
	wg.Wait()
	close(successes)
	close(failures)

	successCount := 0
	for pair := range successes {
		successCount++
		if pair.RefreshToken == "" || pair.RefreshToken == initial.RefreshToken {
			t.Fatalf("refresh token = %q, want a new non-empty token", pair.RefreshToken)
		}
	}
	invalidCount := 0
	for err := range failures {
		if !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("refresh error = %v, want ErrInvalidToken", err)
		}
		invalidCount++
	}
	if successCount != 1 {
		t.Fatalf("successful refreshes = %d, want 1", successCount)
	}
	if invalidCount != attempts-1 {
		t.Fatalf("invalid refreshes = %d, want %d", invalidCount, attempts-1)
	}
}

func TestAuthRefreshTokensRejectsExpiredSession(t *testing.T) {
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
		Email:            "auth-refresh-expired-session-" + uuid.NewString() + "@example.com",
		Name:             "Auth Refresh Expired Session Test",
		EmailConfirmedAt: database.Timestamptz(time.Now().UTC()),
	})
	if err != nil {
		t.Fatal(err)
	}
	service := NewAuthService(&config.Config{
		JWTSecret:         "test-refresh-secret",
		SessionMaxAge:     -time.Minute,
		SessionInactivity: time.Hour,
	}, pool, queries, noopEmailSender{}, slog.New(slog.NewTextHandler(io.Discard, nil)))

	initial, err := service.createSessionAndTokens(ctx, user, "test", "127.0.0.1", desktopAccessExpiry, desktopRefreshExpiry)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.RefreshDesktopTokens(ctx, initial.RefreshToken, "127.0.0.1", "test"); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("RefreshDesktopTokens error = %v, want ErrInvalidToken", err)
	}
}

func TestAuthDeleteAccountMarksSyncDataForDeferredCleanup(t *testing.T) {
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
		Email:            "auth-sync-delete-" + uuid.NewString() + "@example.com",
		Name:             "Auth Sync Delete Test",
		EmailConfirmedAt: database.Timestamptz(time.Now().UTC()),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queries.EnsureSyncUsageAccount(ctx, user.ID); err != nil {
		t.Fatal(err)
	}
	workspace, err := queries.CreateSyncWorkspace(ctx, sqlc.CreateSyncWorkspaceParams{
		OwnerUserID:   user.ID,
		CryptoVersion: "kuku-sync-v1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queries.CreateSyncUsageWorkspace(ctx, workspace.ID); err != nil {
		t.Fatal(err)
	}
	publicKey, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	device, err := queries.CreateSyncDevice(ctx, sqlc.CreateSyncDeviceParams{
		WorkspaceID:         workspace.ID,
		UserID:              user.ID,
		SigningPublicKey:    publicKey,
		EncryptionPublicKey: nil,
		EncryptedDeviceName: []byte("encrypted-device-name"),
	})
	if err != nil {
		t.Fatal(err)
	}
	object, err := queries.CreateReservedSyncObject(ctx, sqlc.CreateReservedSyncObjectParams{
		WorkspaceID:       workspace.ID,
		ObjectID:          "obj_auth_delete",
		ObjectKind:        sqlc.KukuSyncObjectKindContentPack,
		StorageProvider:   sqlc.KukuSyncStorageProviderS3Compatible,
		StorageKey:        "sync/test/users/" + user.ID.String() + "/workspaces/" + workspace.ID.String() + "/objects/obj_auth_delete",
		CreatedByDeviceID: uuid.NullUUID{UUID: device.ID, Valid: true},
		ExpiresAt:         database.Timestamptz(time.Now().UTC().Add(time.Hour)),
	})
	if err != nil {
		t.Fatal(err)
	}
	object, err = queries.MarkSyncObjectAvailable(ctx, sqlc.MarkSyncObjectAvailableParams{
		WorkspaceID:      workspace.ID,
		ObjectID:         object.ObjectID,
		CiphertextSha256: strings.Repeat("a", 64),
		SizeBytes:        32,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := queries.IncrementSyncUsageWorkspaceCount(ctx, sqlc.IncrementSyncUsageWorkspaceCountParams{
		UserID:         user.ID,
		WorkspaceCount: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if err := queries.AddSyncUsageAvailableObjectBytes(ctx, sqlc.AddSyncUsageAvailableObjectBytesParams{
		WorkspaceID:  workspace.ID,
		StorageBytes: object.SizeBytes,
	}); err != nil {
		t.Fatal(err)
	}
	if err := queries.AddSyncUsageAccountAvailableObjectBytes(ctx, sqlc.AddSyncUsageAccountAvailableObjectBytesParams{
		UserID:            user.ID,
		TotalStorageBytes: object.SizeBytes,
	}); err != nil {
		t.Fatal(err)
	}

	service := NewAuthService(&config.Config{}, pool, queries, noopEmailSender{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := service.DeleteAccount(ctx, user.ID, "127.0.0.1", "test"); err != nil {
		t.Fatal(err)
	}

	if _, err := queries.GetUserByID(ctx, user.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("GetUserByID error = %v, want pgx.ErrNoRows", err)
	}
	if _, err := queries.GetSyncWorkspaceByIDAndOwner(ctx, sqlc.GetSyncWorkspaceByIDAndOwnerParams{
		ID:          workspace.ID,
		OwnerUserID: user.ID,
	}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("GetSyncWorkspaceByIDAndOwner error = %v, want pgx.ErrNoRows", err)
	}

	var objectState sqlc.KukuSyncObjectState
	var objectDeletedAt pgtype.Timestamptz
	if err := pool.QueryRow(ctx, `
SELECT upload_state, deleted_at
FROM kuku.sync_objects
WHERE workspace_id = $1 AND object_id = $2
`, workspace.ID, object.ObjectID).Scan(&objectState, &objectDeletedAt); err != nil {
		t.Fatal(err)
	}
	if objectState != sqlc.KukuSyncObjectStateDeleted || !objectDeletedAt.Valid {
		t.Fatalf("object state=%s deleted_at=%v, want deleted", objectState, objectDeletedAt)
	}

	var deviceRevokedAt pgtype.Timestamptz
	if err := pool.QueryRow(ctx, `
SELECT revoked_at
FROM kuku.sync_devices
WHERE id = $1
`, device.ID).Scan(&deviceRevokedAt); err != nil {
		t.Fatal(err)
	}
	if !deviceRevokedAt.Valid {
		t.Fatal("device revoked_at is not set")
	}

	accountUsage, err := queries.GetSyncUsageAccountForUpdate(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if accountUsage.WorkspaceCount != 0 || accountUsage.TotalStorageBytes != 0 || accountUsage.PendingUploadBytes != 0 {
		t.Fatalf("account usage = %+v, want zeroed", accountUsage)
	}
	workspaceUsage, err := queries.GetSyncUsageWorkspaceForUpdate(ctx, workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if workspaceUsage.StorageBytes != 0 || workspaceUsage.ObjectCount != 0 || workspaceUsage.PendingUploadBytes != 0 {
		t.Fatalf("workspace usage = %+v, want zeroed", workspaceUsage)
	}
}
