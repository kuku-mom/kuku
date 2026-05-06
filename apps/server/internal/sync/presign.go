package sync

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	syncv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1"

	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

const maxObjectTransferBatch = 100

type UploadObjectRequest struct {
	ObjectID         string
	Kind             syncv1.SyncObjectKind
	CiphertextSHA256 string
	SizeBytes        int64
}

type ObjectUploadTarget struct {
	ObjectID        string
	PutURL          string
	RequiredHeaders map[string]string
	ExpiresAt       time.Time
}

type CompletedObjectUploadRequest struct {
	ObjectID         string
	CiphertextSHA256 string
	SizeBytes        int64
	ProviderETag     string
}

type ObjectUploadResult struct {
	Object      sqlc.KukuSyncObject
	ErrorReason sqlc.NullKukuSyncObjectErrorReason
}

type ObjectDownloadTarget struct {
	Object          sqlc.KukuSyncObject
	GetURL          string
	RequiredHeaders map[string]string
	ExpiresAt       time.Time
}

func (s *Service) CreateObjectUploadBatch(ctx context.Context, userID, workspaceID, deviceID uuid.UUID, uploadAttemptID string, requests []UploadObjectRequest) ([]ObjectUploadTarget, error) {
	uploadAttemptID = strings.TrimSpace(uploadAttemptID)
	if uploadAttemptID == "" {
		return nil, fmt.Errorf("%w: upload attempt id is required", ErrInvalidArgument)
	}
	if len(requests) == 0 || len(requests) > maxObjectTransferBatch {
		return nil, fmt.Errorf("%w: invalid upload batch object count", ErrInvalidArgument)
	}
	store, err := s.presignStore()
	if err != nil {
		return nil, err
	}

	type candidate struct {
		object           sqlc.KukuSyncObject
		ciphertextSHA256 string
		sizeBytes        int64
	}
	candidates := make([]candidate, 0, len(requests))
	seen := make(map[string]struct{}, len(requests))
	additionalPendingBytes := int64(0)
	targets := make([]ObjectUploadTarget, 0, len(requests))

	err = s.withTx(ctx, func(q *sqlc.Queries) error {
		if _, err := s.authorizeWorkspace(ctx, q, userID, workspaceID); err != nil {
			return err
		}
		device, err := s.requireActiveDevice(ctx, q, userID, workspaceID, deviceID)
		if err != nil {
			return err
		}
		accountUsage, err := q.GetSyncUsageAccountForUpdate(ctx, userID)
		if err != nil {
			return err
		}
		workspaceUsage, err := q.GetSyncUsageWorkspaceForUpdate(ctx, workspaceID)
		if err != nil {
			return err
		}
		now := s.now()
		pendingExpiresAt := database.Timestamptz(now.Add(s.cfg.SyncMaxPendingUploadAge))
		presignTTL := s.cfg.SyncPresignTTL

		for _, request := range requests {
			objectID := strings.TrimSpace(request.ObjectID)
			if objectID == "" {
				return fmt.Errorf("%w: object id is required", ErrInvalidArgument)
			}
			if _, ok := seen[objectID]; ok {
				return fmt.Errorf("%w: duplicate upload object id", ErrInvalidArgument)
			}
			seen[objectID] = struct{}{}
			kind, err := objectKindToSQL(request.Kind)
			if err != nil {
				return err
			}
			ciphertextSHA256, err := validateCiphertextDescriptor(request.CiphertextSHA256, request.SizeBytes)
			if err != nil {
				return err
			}
			if request.SizeBytes > s.cfg.SyncMaxSingleBlobBytes {
				return &QuotaError{
					Limit:     syncv1.SyncQuotaLimit_SYNC_QUOTA_LIMIT_SINGLE_BLOB_BYTES,
					Max:       s.cfg.SyncMaxSingleBlobBytes,
					Current:   0,
					Requested: request.SizeBytes,
				}
			}
			object, err := q.GetSyncObjectForUpdate(ctx, sqlc.GetSyncObjectForUpdateParams{
				WorkspaceID: workspaceID,
				ObjectID:    objectID,
			})
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrPermissionDenied
			}
			if err != nil {
				return err
			}
			if err := requireObjectReservedByDevice(object, device.ID); err != nil {
				return err
			}
			if object.ObjectKind != kind {
				return ErrObjectMetadataMismatch
			}
			if object.StorageProvider != s.store.Provider() {
				return ErrObjectMetadataMismatch
			}
			switch object.UploadState {
			case sqlc.KukuSyncObjectStateReserved:
				additionalPendingBytes += request.SizeBytes
				candidates = append(candidates, candidate{
					object:           object,
					ciphertextSHA256: ciphertextSHA256,
					sizeBytes:        request.SizeBytes,
				})
			case sqlc.KukuSyncObjectStatePending:
				if object.CiphertextSha256 != ciphertextSHA256 || object.SizeBytes != request.SizeBytes {
					return ErrObjectMetadataMismatch
				}
				if object.ExpiresAt.Valid && !object.ExpiresAt.Time.After(now) {
					return ErrObjectNotAvailable
				}
				candidates = append(candidates, candidate{
					object:           object,
					ciphertextSHA256: ciphertextSHA256,
					sizeBytes:        request.SizeBytes,
				})
			default:
				return ErrObjectNotAvailable
			}
		}

		if err := s.checkUploadBatchQuota(accountUsage, workspaceUsage, additionalPendingBytes); err != nil {
			return err
		}

		if additionalPendingBytes > 0 {
			if err := q.AddSyncUsagePendingBytes(ctx, sqlc.AddSyncUsagePendingBytesParams{
				WorkspaceID:        workspaceID,
				PendingUploadBytes: additionalPendingBytes,
			}); err != nil {
				return err
			}
			if err := q.AddSyncUsageAccountPendingBytes(ctx, sqlc.AddSyncUsageAccountPendingBytesParams{
				UserID:             userID,
				PendingUploadBytes: additionalPendingBytes,
			}); err != nil {
				return err
			}
		}

		for _, item := range candidates {
			object, err := q.MarkSyncObjectPending(ctx, sqlc.MarkSyncObjectPendingParams{
				WorkspaceID:      workspaceID,
				ObjectID:         item.object.ObjectID,
				CiphertextSha256: item.ciphertextSHA256,
				SizeBytes:        item.sizeBytes,
				ExpiresAt:        pendingExpiresAt,
			})
			if err != nil {
				return err
			}
			presigned, err := store.PresignPut(ctx, object.StorageKey, item.ciphertextSHA256, item.sizeBytes, presignTTL)
			if err != nil {
				return err
			}
			targets = append(targets, ObjectUploadTarget{
				ObjectID:        object.ObjectID,
				PutURL:          presigned.URL,
				RequiredHeaders: presigned.RequiredHeaders,
				ExpiresAt:       presigned.ExpiresAt,
			})
		}
		return q.TouchSyncDeviceLastSeen(ctx, sqlc.TouchSyncDeviceLastSeenParams{
			WorkspaceID: workspaceID,
			ID:          device.ID,
			UserID:      userID,
		})
	})
	return targets, err
}

func (s *Service) CompleteObjectUploadBatch(ctx context.Context, userID, workspaceID, deviceID uuid.UUID, uploadAttemptID string, requests []CompletedObjectUploadRequest) ([]ObjectUploadResult, error) {
	uploadAttemptID = strings.TrimSpace(uploadAttemptID)
	if uploadAttemptID == "" {
		return nil, fmt.Errorf("%w: upload attempt id is required", ErrInvalidArgument)
	}
	if len(requests) == 0 || len(requests) > maxObjectTransferBatch {
		return nil, fmt.Errorf("%w: invalid complete upload batch object count", ErrInvalidArgument)
	}
	store, err := s.presignStore()
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(requests))
	results := make([]ObjectUploadResult, 0, len(requests))

	err = s.withTx(ctx, func(q *sqlc.Queries) error {
		if _, err := s.authorizeWorkspace(ctx, q, userID, workspaceID); err != nil {
			return err
		}
		device, err := s.requireActiveDevice(ctx, q, userID, workspaceID, deviceID)
		if err != nil {
			return err
		}
		if _, err := q.GetSyncUsageAccountForUpdate(ctx, userID); err != nil {
			return err
		}
		if _, err := q.GetSyncUsageWorkspaceForUpdate(ctx, workspaceID); err != nil {
			return err
		}
		now := s.now()

		for _, request := range requests {
			objectID := strings.TrimSpace(request.ObjectID)
			if objectID == "" {
				return fmt.Errorf("%w: object id is required", ErrInvalidArgument)
			}
			if _, ok := seen[objectID]; ok {
				return fmt.Errorf("%w: duplicate complete object id", ErrInvalidArgument)
			}
			seen[objectID] = struct{}{}
			ciphertextSHA256, err := validateCiphertextDescriptor(request.CiphertextSHA256, request.SizeBytes)
			if err != nil {
				return err
			}
			object, err := q.GetSyncObjectForUpdate(ctx, sqlc.GetSyncObjectForUpdateParams{
				WorkspaceID: workspaceID,
				ObjectID:    objectID,
			})
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrPermissionDenied
			}
			if err != nil {
				return err
			}
			if err := requireObjectReservedByDevice(object, device.ID); err != nil {
				return err
			}
			if object.UploadState == sqlc.KukuSyncObjectStateAvailable {
				if object.CiphertextSha256 == ciphertextSHA256 && object.SizeBytes == request.SizeBytes {
					results = append(results, ObjectUploadResult{Object: object})
					continue
				}
				return ErrObjectMetadataMismatch
			}
			if object.UploadState != sqlc.KukuSyncObjectStatePending {
				return ErrObjectNotAvailable
			}
			if object.ExpiresAt.Valid && !object.ExpiresAt.Time.After(now) {
				failed, err := s.failPendingObject(ctx, q, userID, workspaceID, object, sqlc.KukuSyncObjectErrorReasonUploadExpired)
				if err != nil {
					return err
				}
				results = append(results, failedUploadResult(failed, sqlc.KukuSyncObjectErrorReasonUploadExpired))
				continue
			}
			if object.SizeBytes != request.SizeBytes {
				failed, err := s.failPendingObject(ctx, q, userID, workspaceID, object, sqlc.KukuSyncObjectErrorReasonSizeMismatch)
				if err != nil {
					return err
				}
				results = append(results, failedUploadResult(failed, sqlc.KukuSyncObjectErrorReasonSizeMismatch))
				continue
			}
			if object.CiphertextSha256 != ciphertextSHA256 {
				failed, err := s.failPendingObject(ctx, q, userID, workspaceID, object, sqlc.KukuSyncObjectErrorReasonChecksumMismatch)
				if err != nil {
					return err
				}
				results = append(results, failedUploadResult(failed, sqlc.KukuSyncObjectErrorReasonChecksumMismatch))
				continue
			}
			metadata, err := store.Head(ctx, object.StorageKey)
			if errors.Is(err, ErrObjectStoreNotFound) {
				failed, failErr := s.failPendingObject(ctx, q, userID, workspaceID, object, sqlc.KukuSyncObjectErrorReasonStorageProviderError)
				if failErr != nil {
					return failErr
				}
				results = append(results, failedUploadResult(failed, sqlc.KukuSyncObjectErrorReasonStorageProviderError))
				continue
			}
			if err != nil {
				return err
			}
			if metadata.SizeBytes != object.SizeBytes {
				failed, err := s.failPendingObject(ctx, q, userID, workspaceID, object, sqlc.KukuSyncObjectErrorReasonSizeMismatch)
				if err != nil {
					return err
				}
				results = append(results, failedUploadResult(failed, sqlc.KukuSyncObjectErrorReasonSizeMismatch))
				continue
			}
			if strings.ToLower(strings.TrimSpace(metadata.CiphertextSHA256)) != object.CiphertextSha256 {
				failed, err := s.failPendingObject(ctx, q, userID, workspaceID, object, sqlc.KukuSyncObjectErrorReasonChecksumMismatch)
				if err != nil {
					return err
				}
				results = append(results, failedUploadResult(failed, sqlc.KukuSyncObjectErrorReasonChecksumMismatch))
				continue
			}

			available, err := q.MarkSyncObjectAvailable(ctx, sqlc.MarkSyncObjectAvailableParams{
				WorkspaceID:      workspaceID,
				ObjectID:         object.ObjectID,
				CiphertextSha256: object.CiphertextSha256,
				SizeBytes:        object.SizeBytes,
			})
			if err != nil {
				return err
			}
			if err := q.CompleteSyncUsageObjectBytes(ctx, sqlc.CompleteSyncUsageObjectBytesParams{
				WorkspaceID:        workspaceID,
				PendingUploadBytes: object.SizeBytes,
			}); err != nil {
				return err
			}
			if err := q.CompleteSyncUsageAccountObjectBytes(ctx, sqlc.CompleteSyncUsageAccountObjectBytesParams{
				UserID:             userID,
				PendingUploadBytes: object.SizeBytes,
			}); err != nil {
				return err
			}
			results = append(results, ObjectUploadResult{Object: available})
		}
		return q.TouchSyncDeviceLastSeen(ctx, sqlc.TouchSyncDeviceLastSeenParams{
			WorkspaceID: workspaceID,
			ID:          device.ID,
			UserID:      userID,
		})
	})
	return results, err
}

func (s *Service) CreateObjectDownloadBatch(ctx context.Context, userID, workspaceID, deviceID uuid.UUID, objectIDs []string) ([]ObjectDownloadTarget, error) {
	if len(objectIDs) == 0 || len(objectIDs) > maxObjectTransferBatch {
		return nil, fmt.Errorf("%w: invalid download batch object count", ErrInvalidArgument)
	}
	store, err := s.presignStore()
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(objectIDs))
	targets := make([]ObjectDownloadTarget, 0, len(objectIDs))
	err = s.withTx(ctx, func(q *sqlc.Queries) error {
		if _, err := s.authorizeWorkspace(ctx, q, userID, workspaceID); err != nil {
			return err
		}
		device, err := s.requireActiveDevice(ctx, q, userID, workspaceID, deviceID)
		if err != nil {
			return err
		}
		for _, value := range objectIDs {
			objectID := strings.TrimSpace(value)
			if objectID == "" {
				return fmt.Errorf("%w: object id is required", ErrInvalidArgument)
			}
			if _, ok := seen[objectID]; ok {
				return fmt.Errorf("%w: duplicate download object id", ErrInvalidArgument)
			}
			seen[objectID] = struct{}{}
			object, err := q.GetSyncObject(ctx, sqlc.GetSyncObjectParams{
				WorkspaceID: workspaceID,
				ObjectID:    objectID,
			})
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrObjectStoreNotFound
			}
			if err != nil {
				return err
			}
			if object.UploadState != sqlc.KukuSyncObjectStateAvailable {
				return ErrObjectNotAvailable
			}
			presigned, err := store.PresignGet(ctx, object.StorageKey, s.cfg.SyncPresignTTL)
			if err != nil {
				return err
			}
			targets = append(targets, ObjectDownloadTarget{
				Object:          object,
				GetURL:          presigned.URL,
				RequiredHeaders: presigned.RequiredHeaders,
				ExpiresAt:       presigned.ExpiresAt,
			})
		}
		return q.TouchSyncDeviceLastSeen(ctx, sqlc.TouchSyncDeviceLastSeenParams{
			WorkspaceID: workspaceID,
			ID:          device.ID,
			UserID:      userID,
		})
	})
	return targets, err
}

func (s *Service) presignStore() (PresignObjectStore, error) {
	store, ok := s.store.(PresignObjectStore)
	if !ok {
		return nil, ErrNotImplemented
	}
	return store, nil
}

func (s *Service) failPendingObject(ctx context.Context, q *sqlc.Queries, userID, workspaceID uuid.UUID, object sqlc.KukuSyncObject, reason sqlc.KukuSyncObjectErrorReason) (sqlc.KukuSyncObject, error) {
	if object.SizeBytes > 0 {
		if err := q.ReleaseSyncUsagePendingBytes(ctx, sqlc.ReleaseSyncUsagePendingBytesParams{
			WorkspaceID:        workspaceID,
			PendingUploadBytes: object.SizeBytes,
		}); err != nil {
			return sqlc.KukuSyncObject{}, err
		}
		if err := q.ReleaseSyncUsageAccountPendingBytes(ctx, sqlc.ReleaseSyncUsageAccountPendingBytesParams{
			UserID:             userID,
			PendingUploadBytes: object.SizeBytes,
		}); err != nil {
			return sqlc.KukuSyncObject{}, err
		}
	}
	return q.MarkSyncObjectFailed(ctx, sqlc.MarkSyncObjectFailedParams{
		WorkspaceID: workspaceID,
		ObjectID:    object.ObjectID,
		ErrorReason: sqlc.NullKukuSyncObjectErrorReason{
			KukuSyncObjectErrorReason: reason,
			Valid:                     true,
		},
	})
}

func failedUploadResult(object sqlc.KukuSyncObject, reason sqlc.KukuSyncObjectErrorReason) ObjectUploadResult {
	return ObjectUploadResult{
		Object: object,
		ErrorReason: sqlc.NullKukuSyncObjectErrorReason{
			KukuSyncObjectErrorReason: reason,
			Valid:                     true,
		},
	}
}

func requireObjectReservedByDevice(object sqlc.KukuSyncObject, deviceID uuid.UUID) error {
	if !object.CreatedByDeviceID.Valid || object.CreatedByDeviceID.UUID != deviceID {
		return ErrPermissionDenied
	}
	return nil
}
