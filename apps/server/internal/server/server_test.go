package server

import (
	"strings"
	"testing"

	"github.com/kuku-mom/kuku/apps/server/internal/config"
	syncsvc "github.com/kuku-mom/kuku/apps/server/internal/sync"
)

func TestNewSyncHandlerDisabledSkipsObjectStoreInitialization(t *testing.T) {
	s := &Server{
		cfg: &config.Config{
			SyncFeatureEnabled:    false,
			SyncObjectStoreDriver: "unsupported",
		},
	}

	handler, err := s.newSyncHandler(nil)
	if err != nil {
		t.Fatalf("newSyncHandler() error = %v, want nil", err)
	}
	if _, ok := handler.(*syncsvc.DisabledHandler); !ok {
		t.Fatalf("newSyncHandler() = %T, want *sync.DisabledHandler", handler)
	}
}

func TestNewSyncHandlerEnabledInitializesObjectStore(t *testing.T) {
	s := &Server{
		cfg: &config.Config{
			SyncFeatureEnabled:    true,
			SyncObjectStoreDriver: "unsupported",
		},
	}

	_, err := s.newSyncHandler(nil)
	if err == nil {
		t.Fatal("newSyncHandler() error = nil, want object store initialization error")
	}
	if !strings.Contains(err.Error(), "init sync object store") {
		t.Fatalf("newSyncHandler() error = %q, want object store initialization context", err.Error())
	}
}
