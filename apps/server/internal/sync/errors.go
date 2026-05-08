package sync

import (
	"errors"
	"fmt"

	syncv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1"
)

var (
	ErrPermissionDenied        = errors.New("sync permission denied")
	ErrInvalidArgument         = errors.New("invalid sync argument")
	ErrAccountKeyExists        = errors.New("sync account key already exists")
	ErrAccountKeyNotConfigured = errors.New("sync account key is not configured")
	ErrMetadataVersionConflict = errors.New("sync metadata version conflict")
	ErrDevBytesDisabled        = errors.New("sync direct bytes dev rpc disabled")
	ErrObjectNotAvailable      = errors.New("sync object not available")
	ErrObjectMetadataMismatch  = errors.New("sync object metadata mismatch")
	ErrObjectStoreNotFound     = errors.New("sync object not found in object store")
	ErrNotImplemented          = errors.New("sync operation not implemented")
	ErrDuplicateCommitPayload  = errors.New("sync commit id already exists with different payload")
	ErrDuplicateDeviceSeq      = errors.New("sync device sequence already used")
	ErrInvalidCommitParent     = errors.New("invalid sync commit parent")
	ErrInvalidSignature        = errors.New("invalid sync commit signature")
)

type QuotaError struct {
	Limit     syncv1.SyncQuotaLimit
	Max       int64
	Current   int64
	Requested int64
}

func (e *QuotaError) Error() string {
	return fmt.Sprintf("sync quota exceeded: limit=%s", e.Limit.String())
}

type HeadConflictError struct {
	WorkspaceID   string
	CurrentHeadID string
	HeadVersion   int64
}

func (e *HeadConflictError) Error() string {
	return "sync head conflict"
}
