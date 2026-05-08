package sync

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

func TestSyncServerSurfacesDoNotExposePlaintextMarkers(t *testing.T) {
	userID := uuid.MustParse("00000000-0000-0000-0000-000000000001")
	workspaceID := uuid.MustParse("00000000-0000-0000-0000-000000000002")
	storageKey := objectStorageKey("test", userID, workspaceID, "obj_abc123")
	sha := strings.Repeat("a", 64)

	putURL, err := (&fakePresignStore{}).PresignPut(t.Context(), storageKey, sha, 12, time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	rendered := []string{
		storageKey,
		fmt.Sprintf("%+v", objectCandidate(sqlc.KukuSyncObject{
			ObjectID:         "obj_abc123",
			ObjectKind:       sqlc.KukuSyncObjectKindContentPack,
			StorageKey:       storageKey,
			CiphertextSha256: sha,
			UploadState:      sqlc.KukuSyncObjectStateAvailable,
			SizeBytes:        12,
		})),
		fmt.Sprintf("%+v", DeletedWorkspaceCleanupReport{
			DeletedWorkspaces: []uuid.UUID{workspaceID},
			DeletedObjectKeys: 1,
		}),
		fmt.Sprintf("%s %+v", putURL.URL, putURL.RequiredHeaders),
	}
	for _, surface := range rendered {
		requireNoPlaintextMarkers(t, surface)
	}
}

func requireNoPlaintextMarkers(t *testing.T, rendered string) {
	t.Helper()
	for _, marker := range []string{
		"user@example.com",
		"Notes/private.md",
		"private.md",
		"passphrase",
		"workspace display name",
	} {
		if strings.Contains(rendered, marker) {
			t.Fatalf("surface %q leaked plaintext marker %q", rendered, marker)
		}
	}
}
