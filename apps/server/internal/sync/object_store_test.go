package sync

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestNewObjectIDOpaqueURLSafe(t *testing.T) {
	id, err := newObjectID()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(id, "obj_") {
		t.Fatalf("object id = %q, want obj_ prefix", id)
	}
	if strings.ContainsAny(id, `/\.`) {
		t.Fatalf("object id contains path-like characters: %q", id)
	}
}

func TestObjectStorageKeyDoesNotIncludePlaintextMarkers(t *testing.T) {
	userID := uuid.MustParse("00000000-0000-0000-0000-000000000001")
	workspaceID := uuid.MustParse("00000000-0000-0000-0000-000000000002")
	key := objectStorageKey("preview", userID, workspaceID, "obj_abc123")

	for _, marker := range []string{"user@example.com", "notes.md", ".md", "sha256"} {
		if strings.Contains(key, marker) {
			t.Fatalf("storage key %q leaked marker %q", key, marker)
		}
	}
	expected := "sync/preview/users/00000000-0000-0000-0000-000000000001/workspaces/00000000-0000-0000-0000-000000000002/objects/obj_abc123"
	if key != expected {
		t.Fatalf("storage key = %q", key)
	}
}

func TestObjectStorageKeySanitizesEnvironmentOnly(t *testing.T) {
	userID := uuid.MustParse("00000000-0000-0000-0000-000000000001")
	workspaceID := uuid.MustParse("00000000-0000-0000-0000-000000000002")

	key := objectStorageKey("Preview.Env", userID, workspaceID, "obj_abc123")

	if !strings.HasPrefix(key, "sync/preview-env/users/") {
		t.Fatalf("storage key = %q", key)
	}
}
