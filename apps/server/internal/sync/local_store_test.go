package sync

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
)

func TestLocalObjectStoreRoundTrip(t *testing.T) {
	store, err := NewLocalObjectStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	key := objectStorageKey(
		"development",
		uuid.MustParse("00000000-0000-0000-0000-000000000001"),
		uuid.MustParse("00000000-0000-0000-0000-000000000002"),
		"obj_test",
	)
	want := []byte("encrypted bytes")

	if err := store.Put(context.Background(), key, want); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	got, err := store.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("payload = %q, want %q", got, want)
	}
	if err := store.Delete(context.Background(), key); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if _, err := store.Get(context.Background(), key); !errors.Is(err, ErrObjectStoreNotFound) {
		t.Fatalf("Get() after delete error = %v, want ErrObjectStoreNotFound", err)
	}
}

func TestLocalObjectStoreRejectsTraversal(t *testing.T) {
	store, err := NewLocalObjectStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	keys := []string{
		"../escape",
		"/absolute",
		"..",
		filepath.ToSlash(filepath.Join("sync", "..", "..", "escape")),
	}
	for _, key := range keys {
		if err := store.Put(context.Background(), key, []byte("x")); err == nil {
			t.Fatalf("Put(%q) error = nil, want traversal rejection", key)
		}
	}
}
