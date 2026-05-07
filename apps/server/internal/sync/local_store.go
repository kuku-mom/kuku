package sync

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

type LocalObjectStore struct {
	root string
}

func NewLocalObjectStore(root string) (*LocalObjectStore, error) {
	if strings.TrimSpace(root) == "" {
		return nil, ErrInvalidArgument
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &LocalObjectStore{root: abs}, nil
}

func (s *LocalObjectStore) Provider() sqlc.KukuSyncStorageProvider {
	return sqlc.KukuSyncStorageProviderLocal
}

func (s *LocalObjectStore) Put(ctx context.Context, storageKey string, payload []byte) error {
	path, err := s.pathForKey(storageKey)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, payload, 0o600)
}

func (s *LocalObjectStore) Get(ctx context.Context, storageKey string) ([]byte, error) {
	path, err := s.pathForKey(storageKey)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	payload, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrObjectStoreNotFound
	}
	return payload, err
}

func (s *LocalObjectStore) Delete(ctx context.Context, storageKey string) error {
	path, err := s.pathForKey(storageKey)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (s *LocalObjectStore) pathForKey(storageKey string) (string, error) {
	key := filepath.Clean(filepath.FromSlash(storageKey))
	if key == "." || filepath.IsAbs(key) || key == ".." || strings.HasPrefix(key, ".."+string(filepath.Separator)) {
		return "", ErrInvalidArgument
	}
	path := filepath.Join(s.root, key)
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	root := s.root
	if abs != root && !strings.HasPrefix(abs, root+string(filepath.Separator)) {
		return "", ErrInvalidArgument
	}
	return abs, nil
}
