package sync

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"

	"github.com/kuku-mom/kuku/apps/server/internal/config"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

const EncryptedObjectContentType = "application/vnd.kuku.sync.encrypted-object"

type ObjectStore interface {
	Provider() sqlc.KukuSyncStorageProvider
	Put(ctx context.Context, storageKey string, payload []byte) error
	Get(ctx context.Context, storageKey string) ([]byte, error)
}

type DeletingObjectStore interface {
	ObjectStore
	Delete(ctx context.Context, storageKey string) error
}

type PresignObjectStore interface {
	ObjectStore
	PresignPut(ctx context.Context, storageKey, ciphertextSHA256 string, sizeBytes int64, ttl time.Duration) (PresignedObjectURL, error)
	PresignGet(ctx context.Context, storageKey string, ttl time.Duration) (PresignedObjectURL, error)
	Head(ctx context.Context, storageKey string) (ObjectStoreMetadata, error)
}

type PresignedObjectURL struct {
	URL             string
	RequiredHeaders map[string]string
	ExpiresAt       time.Time
}

type ObjectStoreMetadata struct {
	SizeBytes        int64
	CiphertextSHA256 string
}

func NewObjectStore(cfg *config.Config) (ObjectStore, error) {
	switch cfg.SyncObjectStoreDriver {
	case "local":
		return NewLocalObjectStore(cfg.SyncLocalObjectDir)
	case "s3", "s3_compatible":
		return NewS3ObjectStore(context.Background(), cfg)
	default:
		return nil, fmt.Errorf("%w: unsupported object store driver %q", ErrInvalidArgument, cfg.SyncObjectStoreDriver)
	}
}

func newObjectID() (string, error) {
	var raw [18]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "obj_" + base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func objectStorageKey(env string, userID, workspaceID uuid.UUID, objectID string) string {
	return fmt.Sprintf(
		"sync/%s/users/%s/workspaces/%s/objects/%s",
		storageNamespace(env),
		userID.String(),
		workspaceID.String(),
		objectID,
	)
}

func storageNamespace(env string) string {
	env = strings.TrimSpace(env)
	if env == "" {
		return "development"
	}
	var b strings.Builder
	for _, r := range env {
		switch {
		case r == '-' || r == '_':
			b.WriteRune(r)
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(unicode.ToLower(r))
		default:
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-_")
	if out == "" {
		return "development"
	}
	return out
}
