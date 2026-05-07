package sync

import (
	"strings"
	"testing"
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
	key := objectStorageKey("preview", "obj_abc123")
	for _, marker := range []string{"user@example.com", "workspace", "notes.md", ".md", "sha256"} {
		if strings.Contains(key, marker) {
			t.Fatalf("storage key %q leaked marker %q", key, marker)
		}
	}
	if key != "sync/preview/objects/obj_abc123" {
		t.Fatalf("storage key = %q", key)
	}
}
