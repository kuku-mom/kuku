package sync

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	syncv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1"

	"github.com/kuku-mom/kuku/apps/server/internal/config"
	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

const (
	defaultListCommitsPageSize = 100
	maxListCommitsPageSize     = 500
	maxObjectReservations      = 100
)

type Service struct {
	pool    *pgxpool.Pool
	queries *sqlc.Queries
	cfg     *config.Config
	store   ObjectStore
	now     func() time.Time
}

func NewService(pool *pgxpool.Pool, queries *sqlc.Queries, cfg *config.Config, store ObjectStore) *Service {
	return &Service{
		pool:    pool,
		queries: queries,
		cfg:     cfg,
		store:   store,
		now:     func() time.Time { return time.Now().UTC() },
	}
}

func (s *Service) GetAccountKeyState(ctx context.Context, userID uuid.UUID) (*sqlc.KukuSyncAccountKey, error) {
	accountKey, err := s.queries.GetSyncAccountKeyByUser(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &accountKey, nil
}

func (s *Service) CreateAccountKey(ctx context.Context, userID uuid.UUID, params CreateAccountKeyParams) (AccountKeySetup, error) {
	params.AccountKeyID = strings.TrimSpace(params.AccountKeyID)
	params.CryptoVersion = strings.TrimSpace(params.CryptoVersion)
	params.EnvelopeID = strings.TrimSpace(params.EnvelopeID)
	if params.AccountKeyID == "" {
		return AccountKeySetup{}, fmt.Errorf("%w: account key id is required", ErrInvalidArgument)
	}
	if params.CryptoVersion == "" {
		return AccountKeySetup{}, fmt.Errorf("%w: crypto version is required", ErrInvalidArgument)
	}
	if params.RecipientType != syncv1.SyncAccountKeyRecipientType_SYNC_ACCOUNT_KEY_RECIPIENT_TYPE_RECOVERY_PHRASE {
		return AccountKeySetup{}, fmt.Errorf("%w: first account key envelope must be recovery phrase", ErrInvalidArgument)
	}
	recipientType, err := validateAccountKeyEnvelopeParams(
		params.EnvelopeID,
		params.RecipientType,
		params.KeyVersion,
		params.KDFParamsJSON,
		params.EncryptedEnvelope,
	)
	if err != nil {
		return AccountKeySetup{}, err
	}
	existing, err := s.GetAccountKeyState(ctx, userID)
	if err != nil {
		return AccountKeySetup{}, err
	}
	if existing != nil {
		return AccountKeySetup{}, ErrAccountKeyExists
	}

	var result AccountKeySetup
	err = s.withTx(ctx, func(q *sqlc.Queries) error {
		accountKey, err := q.CreateSyncAccountKey(ctx, sqlc.CreateSyncAccountKeyParams{
			UserID:        userID,
			AccountKeyID:  params.AccountKeyID,
			CryptoVersion: params.CryptoVersion,
		})
		if err != nil {
			return err
		}
		envelope, err := q.UpsertSyncAccountKeyEnvelope(ctx, sqlc.UpsertSyncAccountKeyEnvelopeParams{
			UserID:            userID,
			AccountKeyID:      accountKey.AccountKeyID,
			EnvelopeID:        params.EnvelopeID,
			RecipientType:     recipientType,
			KeyVersion:        params.KeyVersion,
			KdfParams:         []byte(params.KDFParamsJSON),
			EncryptedEnvelope: params.EncryptedEnvelope,
		})
		if err != nil {
			return err
		}
		result = AccountKeySetup{AccountKey: accountKey, Envelope: envelope}
		return nil
	})
	return result, err
}

type CreateAccountKeyParams struct {
	AccountKeyID      string
	CryptoVersion     string
	EnvelopeID        string
	RecipientType     syncv1.SyncAccountKeyRecipientType
	KeyVersion        int64
	KDFParamsJSON     string
	EncryptedEnvelope []byte
}

type AccountKeySetup struct {
	AccountKey sqlc.KukuSyncAccountKey
	Envelope   sqlc.KukuSyncAccountKeyEnvelope
}

func (s *Service) ListAccountKeyEnvelopes(ctx context.Context, userID uuid.UUID) ([]sqlc.KukuSyncAccountKeyEnvelope, error) {
	accountKey, err := s.GetAccountKeyState(ctx, userID)
	if err != nil {
		return nil, err
	}
	if accountKey == nil {
		return []sqlc.KukuSyncAccountKeyEnvelope{}, nil
	}
	return s.queries.ListSyncAccountKeyEnvelopes(ctx, userID)
}

func (s *Service) PutAccountKeyEnvelope(ctx context.Context, userID uuid.UUID, params PutAccountKeyEnvelopeParams) (sqlc.KukuSyncAccountKeyEnvelope, error) {
	params.EnvelopeID = strings.TrimSpace(params.EnvelopeID)
	recipientType, err := validateAccountKeyEnvelopeParams(
		params.EnvelopeID,
		params.RecipientType,
		params.KeyVersion,
		params.KDFParamsJSON,
		params.EncryptedEnvelope,
	)
	if err != nil {
		return sqlc.KukuSyncAccountKeyEnvelope{}, err
	}
	accountKey, err := s.GetAccountKeyState(ctx, userID)
	if err != nil {
		return sqlc.KukuSyncAccountKeyEnvelope{}, err
	}
	if accountKey == nil {
		return sqlc.KukuSyncAccountKeyEnvelope{}, ErrAccountKeyNotConfigured
	}
	return s.queries.UpsertSyncAccountKeyEnvelope(ctx, sqlc.UpsertSyncAccountKeyEnvelopeParams{
		UserID:            userID,
		AccountKeyID:      accountKey.AccountKeyID,
		EnvelopeID:        params.EnvelopeID,
		RecipientType:     recipientType,
		KeyVersion:        params.KeyVersion,
		KdfParams:         []byte(params.KDFParamsJSON),
		EncryptedEnvelope: params.EncryptedEnvelope,
	})
}

type PutAccountKeyEnvelopeParams struct {
	EnvelopeID        string
	RecipientType     syncv1.SyncAccountKeyRecipientType
	KeyVersion        int64
	KDFParamsJSON     string
	EncryptedEnvelope []byte
}

func (s *Service) CreateWorkspace(ctx context.Context, userID uuid.UUID, cryptoVersion string) (sqlc.KukuSyncWorkspace, error) {
	cryptoVersion = strings.TrimSpace(cryptoVersion)
	if cryptoVersion == "" {
		return sqlc.KukuSyncWorkspace{}, fmt.Errorf("%w: crypto version is required", ErrInvalidArgument)
	}

	var workspace sqlc.KukuSyncWorkspace
	err := s.withTx(ctx, func(q *sqlc.Queries) error {
		usage, err := q.EnsureSyncUsageAccount(ctx, userID)
		if err != nil {
			return err
		}
		usage, err = q.GetSyncUsageAccountForUpdate(ctx, usage.UserID)
		if err != nil {
			return err
		}
		if usage.WorkspaceCount >= s.cfg.SyncMaxWorkspacesPerUser {
			return &QuotaError{
				Limit:     syncv1.SyncQuotaLimit_SYNC_QUOTA_LIMIT_WORKSPACE_COUNT,
				Max:       int64(s.cfg.SyncMaxWorkspacesPerUser),
				Current:   int64(usage.WorkspaceCount),
				Requested: 1,
			}
		}
		workspace, err = q.CreateSyncWorkspace(ctx, sqlc.CreateSyncWorkspaceParams{
			OwnerUserID:   userID,
			CryptoVersion: cryptoVersion,
		})
		if err != nil {
			return err
		}
		if _, err := q.CreateSyncUsageWorkspace(ctx, workspace.ID); err != nil {
			return err
		}
		return q.IncrementSyncUsageWorkspaceCount(ctx, sqlc.IncrementSyncUsageWorkspaceCountParams{
			UserID:         userID,
			WorkspaceCount: 1,
		})
	})
	return workspace, err
}

func (s *Service) ListWorkspaces(ctx context.Context, userID uuid.UUID) ([]sqlc.KukuSyncWorkspace, error) {
	return s.queries.ListSyncWorkspacesByOwner(ctx, userID)
}

func (s *Service) GetWorkspace(ctx context.Context, userID, workspaceID uuid.UUID) (sqlc.KukuSyncWorkspace, error) {
	workspace, err := s.queries.GetSyncWorkspaceByIDAndOwner(ctx, sqlc.GetSyncWorkspaceByIDAndOwnerParams{
		ID:          workspaceID,
		OwnerUserID: userID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.KukuSyncWorkspace{}, ErrPermissionDenied
	}
	return workspace, err
}

func (s *Service) UpdateWorkspaceMetadata(ctx context.Context, userID uuid.UUID, params UpdateWorkspaceMetadataParams) (sqlc.KukuSyncWorkspace, error) {
	if params.WorkspaceID == uuid.Nil {
		return sqlc.KukuSyncWorkspace{}, fmt.Errorf("%w: workspace id is required", ErrInvalidArgument)
	}
	if len(params.EncryptedMetadata) == 0 {
		return sqlc.KukuSyncWorkspace{}, fmt.Errorf("%w: encrypted metadata is required", ErrInvalidArgument)
	}
	if params.ExpectedMetadataVersion < 0 || params.MetadataVersion != params.ExpectedMetadataVersion+1 {
		return sqlc.KukuSyncWorkspace{}, fmt.Errorf("%w: invalid metadata version", ErrInvalidArgument)
	}

	if _, err := s.GetWorkspace(ctx, userID, params.WorkspaceID); err != nil {
		return sqlc.KukuSyncWorkspace{}, err
	}
	workspace, err := s.queries.UpdateSyncWorkspaceMetadata(ctx, sqlc.UpdateSyncWorkspaceMetadataParams{
		ID:                params.WorkspaceID,
		OwnerUserID:       userID,
		EncryptedMetadata: params.EncryptedMetadata,
		MetadataVersion:   params.MetadataVersion,
		MetadataVersion_2: params.ExpectedMetadataVersion,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.KukuSyncWorkspace{}, ErrMetadataVersionConflict
	}
	return workspace, err
}

type UpdateWorkspaceMetadataParams struct {
	WorkspaceID             uuid.UUID
	EncryptedMetadata       []byte
	MetadataVersion         int64
	ExpectedMetadataVersion int64
}

func (s *Service) UpdateWorkspaceKey(ctx context.Context, userID uuid.UUID, params UpdateWorkspaceKeyParams) (sqlc.KukuSyncWorkspace, error) {
	if params.WorkspaceID == uuid.Nil {
		return sqlc.KukuSyncWorkspace{}, fmt.Errorf("%w: workspace id is required", ErrInvalidArgument)
	}
	if len(params.EncryptedWorkspaceKey) == 0 {
		return sqlc.KukuSyncWorkspace{}, fmt.Errorf("%w: encrypted workspace key is required", ErrInvalidArgument)
	}
	if params.ExpectedWorkspaceKeyVersion < 0 || params.WorkspaceKeyVersion != params.ExpectedWorkspaceKeyVersion+1 {
		return sqlc.KukuSyncWorkspace{}, fmt.Errorf("%w: invalid workspace key version", ErrInvalidArgument)
	}

	if _, err := s.GetWorkspace(ctx, userID, params.WorkspaceID); err != nil {
		return sqlc.KukuSyncWorkspace{}, err
	}
	workspace, err := s.queries.UpdateSyncWorkspaceKey(ctx, sqlc.UpdateSyncWorkspaceKeyParams{
		ID:                    params.WorkspaceID,
		OwnerUserID:           userID,
		EncryptedWorkspaceKey: params.EncryptedWorkspaceKey,
		WorkspaceKeyVersion:   params.WorkspaceKeyVersion,
		WorkspaceKeyVersion_2: params.ExpectedWorkspaceKeyVersion,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.KukuSyncWorkspace{}, ErrMetadataVersionConflict
	}
	return workspace, err
}

type UpdateWorkspaceKeyParams struct {
	WorkspaceID                 uuid.UUID
	EncryptedWorkspaceKey       []byte
	WorkspaceKeyVersion         int64
	ExpectedWorkspaceKeyVersion int64
}

func (s *Service) DeleteWorkspace(ctx context.Context, userID, workspaceID uuid.UUID) error {
	return s.withTx(ctx, func(q *sqlc.Queries) error {
		usage, err := q.EnsureSyncUsageAccount(ctx, userID)
		if err != nil {
			return err
		}
		if _, err := q.GetSyncUsageAccountForUpdate(ctx, usage.UserID); err != nil {
			return err
		}
		if err := q.SoftDeleteSyncWorkspace(ctx, sqlc.SoftDeleteSyncWorkspaceParams{
			ID:          workspaceID,
			OwnerUserID: userID,
		}); err != nil {
			return err
		}
		_, err = q.RecalculateSyncUsageAccount(ctx, userID)
		return err
	})
}

func (s *Service) RegisterDevice(ctx context.Context, userID, workspaceID uuid.UUID, signingPublicKey, encryptionPublicKey, encryptedDeviceName []byte) (sqlc.KukuSyncDevice, error) {
	if len(signingPublicKey) != ed25519.PublicKeySize {
		return sqlc.KukuSyncDevice{}, fmt.Errorf("%w: signing public key must be ed25519 public key", ErrInvalidArgument)
	}
	var device sqlc.KukuSyncDevice
	err := s.withTx(ctx, func(q *sqlc.Queries) error {
		if _, err := s.authorizeWorkspace(ctx, q, userID, workspaceID); err != nil {
			return err
		}
		var err error
		device, err = q.CreateSyncDevice(ctx, sqlc.CreateSyncDeviceParams{
			WorkspaceID:         workspaceID,
			UserID:              userID,
			SigningPublicKey:    signingPublicKey,
			EncryptionPublicKey: encryptionPublicKey,
			EncryptedDeviceName: encryptedDeviceName,
		})
		return err
	})
	return device, err
}

func (s *Service) UpdateDeviceMetadata(ctx context.Context, userID uuid.UUID, params UpdateDeviceMetadataParams) (sqlc.KukuSyncDevice, error) {
	if params.WorkspaceID == uuid.Nil {
		return sqlc.KukuSyncDevice{}, fmt.Errorf("%w: workspace id is required", ErrInvalidArgument)
	}
	if params.DeviceID == uuid.Nil {
		return sqlc.KukuSyncDevice{}, fmt.Errorf("%w: device id is required", ErrInvalidArgument)
	}
	if len(params.EncryptedDeviceName) == 0 {
		return sqlc.KukuSyncDevice{}, fmt.Errorf("%w: encrypted device name is required", ErrInvalidArgument)
	}
	if params.ExpectedMetadataVersion < 0 || params.MetadataVersion != params.ExpectedMetadataVersion+1 {
		return sqlc.KukuSyncDevice{}, fmt.Errorf("%w: invalid device metadata version", ErrInvalidArgument)
	}

	var device sqlc.KukuSyncDevice
	err := s.withTx(ctx, func(q *sqlc.Queries) error {
		if _, err := s.authorizeWorkspace(ctx, q, userID, params.WorkspaceID); err != nil {
			return err
		}
		if _, err := s.requireActiveDevice(ctx, q, userID, params.WorkspaceID, params.DeviceID); err != nil {
			return err
		}
		var err error
		device, err = q.UpdateSyncDeviceMetadata(ctx, sqlc.UpdateSyncDeviceMetadataParams{
			WorkspaceID:         params.WorkspaceID,
			ID:                  params.DeviceID,
			UserID:              userID,
			EncryptedDeviceName: params.EncryptedDeviceName,
			MetadataVersion:     params.MetadataVersion,
			MetadataVersion_2:   params.ExpectedMetadataVersion,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrMetadataVersionConflict
		}
		return err
	})
	return device, err
}

type UpdateDeviceMetadataParams struct {
	WorkspaceID             uuid.UUID
	DeviceID                uuid.UUID
	EncryptedDeviceName     []byte
	MetadataVersion         int64
	ExpectedMetadataVersion int64
}

func (s *Service) ListKeyEnvelopes(ctx context.Context, userID, workspaceID uuid.UUID) ([]sqlc.KukuSyncKeyEnvelope, error) {
	if _, err := s.GetWorkspace(ctx, userID, workspaceID); err != nil {
		return nil, err
	}
	return s.queries.ListSyncKeyEnvelopes(ctx, workspaceID)
}

func (s *Service) PutKeyEnvelope(ctx context.Context, userID uuid.UUID, params PutKeyEnvelopeParams) (sqlc.KukuSyncKeyEnvelope, error) {
	if params.EnvelopeID == "" || params.KeyVersion <= 0 || len(params.EncryptedEnvelope) == 0 {
		return sqlc.KukuSyncKeyEnvelope{}, ErrInvalidArgument
	}
	if params.KDFParamsJSON != "" && !json.Valid([]byte(params.KDFParamsJSON)) {
		return sqlc.KukuSyncKeyEnvelope{}, fmt.Errorf("%w: invalid kdf params json", ErrInvalidArgument)
	}
	recipientType, err := keyRecipientTypeToSQL(params.RecipientType)
	if err != nil {
		return sqlc.KukuSyncKeyEnvelope{}, err
	}
	if params.RecipientType == syncv1.SyncKeyRecipientType_SYNC_KEY_RECIPIENT_TYPE_DEVICE && params.RecipientDeviceID == uuid.Nil {
		return sqlc.KukuSyncKeyEnvelope{}, fmt.Errorf("%w: recipient device id is required", ErrInvalidArgument)
	}
	if params.CreatedByDeviceID == uuid.Nil {
		return sqlc.KukuSyncKeyEnvelope{}, fmt.Errorf("%w: created by device id is required", ErrInvalidArgument)
	}

	var envelope sqlc.KukuSyncKeyEnvelope
	err = s.withTx(ctx, func(q *sqlc.Queries) error {
		if _, err := s.authorizeWorkspace(ctx, q, userID, params.WorkspaceID); err != nil {
			return err
		}
		if _, err := s.requireActiveDevice(ctx, q, userID, params.WorkspaceID, params.CreatedByDeviceID); err != nil {
			return err
		}
		recipientDeviceID := uuid.NullUUID{}
		if params.RecipientDeviceID != uuid.Nil {
			recipientDeviceID = uuid.NullUUID{UUID: params.RecipientDeviceID, Valid: true}
		}
		createdBy := uuid.NullUUID{UUID: params.CreatedByDeviceID, Valid: true}
		var err error
		envelope, err = q.UpsertSyncKeyEnvelope(ctx, sqlc.UpsertSyncKeyEnvelopeParams{
			WorkspaceID:       params.WorkspaceID,
			EnvelopeID:        params.EnvelopeID,
			RecipientType:     recipientType,
			RecipientDeviceID: recipientDeviceID,
			KeyVersion:        params.KeyVersion,
			KdfParams:         []byte(params.KDFParamsJSON),
			EncryptedEnvelope: params.EncryptedEnvelope,
			CreatedByDeviceID: createdBy,
		})
		return err
	})
	return envelope, err
}

type PutKeyEnvelopeParams struct {
	WorkspaceID       uuid.UUID
	EnvelopeID        string
	RecipientType     syncv1.SyncKeyRecipientType
	RecipientDeviceID uuid.UUID
	KeyVersion        int64
	KDFParamsJSON     string
	EncryptedEnvelope []byte
	CreatedByDeviceID uuid.UUID
}

func (s *Service) GetHead(ctx context.Context, userID, workspaceID uuid.UUID) (sqlc.KukuSyncWorkspace, string, error) {
	workspace, err := s.GetWorkspace(ctx, userID, workspaceID)
	if err != nil {
		return sqlc.KukuSyncWorkspace{}, "", err
	}
	checkpointID, err := s.queries.GetLatestSyncCheckpointCommitID(ctx, workspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return workspace, checkpointID, err
}

func (s *Service) ListCommits(ctx context.Context, userID, workspaceID uuid.UUID, afterServerSeq int64, pageSize int32) ([]sqlc.KukuSyncCommit, bool, int64, error) {
	if _, err := s.GetWorkspace(ctx, userID, workspaceID); err != nil {
		return nil, false, 0, err
	}
	if pageSize <= 0 {
		pageSize = defaultListCommitsPageSize
	}
	if pageSize > maxListCommitsPageSize {
		pageSize = maxListCommitsPageSize
	}
	rows, err := s.queries.ListSyncCommitsAfterServerSeq(ctx, sqlc.ListSyncCommitsAfterServerSeqParams{
		WorkspaceID: workspaceID,
		ServerSeq:   pgtype.Int8{Int64: afterServerSeq, Valid: true},
		Limit:       pageSize + 1,
	})
	if err != nil {
		return nil, false, 0, err
	}
	hasMore := int32(len(rows)) > pageSize
	if hasMore {
		rows = rows[:pageSize]
	}
	var next int64
	if len(rows) > 0 && rows[len(rows)-1].ServerSeq.Valid {
		next = rows[len(rows)-1].ServerSeq.Int64
	}
	return rows, hasMore, next, nil
}

func (s *Service) ReserveObjectIDs(ctx context.Context, userID, workspaceID, deviceID uuid.UUID, requests []ObjectReservationRequest) ([]ObjectReservation, error) {
	if len(requests) == 0 || len(requests) > maxObjectReservations {
		return nil, fmt.Errorf("%w: invalid object reservation count", ErrInvalidArgument)
	}
	reserved := make([]ObjectReservation, 0, len(requests))
	err := s.withTx(ctx, func(q *sqlc.Queries) error {
		if _, err := s.authorizeWorkspace(ctx, q, userID, workspaceID); err != nil {
			return err
		}
		device, err := s.requireActiveDevice(ctx, q, userID, workspaceID, deviceID)
		if err != nil {
			return err
		}
		expiresAt := database.Timestamptz(s.now().Add(s.cfg.SyncMaxPendingUploadAge))
		for _, request := range requests {
			if strings.TrimSpace(request.ClientObjectRef) == "" {
				return fmt.Errorf("%w: client object ref is required", ErrInvalidArgument)
			}
			kind, err := objectKindToSQL(request.Kind)
			if err != nil {
				return err
			}
			objectID, err := newObjectID()
			if err != nil {
				return err
			}
			object, err := q.CreateReservedSyncObject(ctx, sqlc.CreateReservedSyncObjectParams{
				WorkspaceID:       workspaceID,
				ObjectID:          objectID,
				ObjectKind:        kind,
				StorageProvider:   s.store.Provider(),
				StorageKey:        objectStorageKey(s.cfg.Env, userID, workspaceID, objectID),
				CreatedByDeviceID: uuid.NullUUID{UUID: device.ID, Valid: true},
				ExpiresAt:         expiresAt,
			})
			if err != nil {
				return err
			}
			reserved = append(reserved, ObjectReservation{
				ClientObjectRef: request.ClientObjectRef,
				Object:          object,
			})
		}
		return q.TouchSyncDeviceLastSeen(ctx, sqlc.TouchSyncDeviceLastSeenParams{
			WorkspaceID: workspaceID,
			ID:          device.ID,
			UserID:      userID,
		})
	})
	return reserved, err
}

type ObjectReservationRequest struct {
	ClientObjectRef string
	Kind            syncv1.SyncObjectKind
}

type ObjectReservation struct {
	ClientObjectRef string
	Object          sqlc.KukuSyncObject
}

func (s *Service) UploadObjectBytesDev(ctx context.Context, userID, workspaceID, deviceID uuid.UUID, objectID, ciphertextSHA256 string, sizeBytes int64, encryptedBlob []byte) (sqlc.KukuSyncObject, error) {
	if !s.cfg.SyncDirectBytesDevEnabled {
		return sqlc.KukuSyncObject{}, ErrDevBytesDisabled
	}
	ciphertextSHA256 = strings.ToLower(strings.TrimSpace(ciphertextSHA256))
	if err := validateCiphertextMetadata(ciphertextSHA256, sizeBytes, encryptedBlob); err != nil {
		return sqlc.KukuSyncObject{}, err
	}
	if sizeBytes > s.cfg.SyncMaxSingleBlobBytes {
		return sqlc.KukuSyncObject{}, &QuotaError{
			Limit:     syncv1.SyncQuotaLimit_SYNC_QUOTA_LIMIT_SINGLE_BLOB_BYTES,
			Max:       s.cfg.SyncMaxSingleBlobBytes,
			Current:   0,
			Requested: sizeBytes,
		}
	}

	var object sqlc.KukuSyncObject
	err := s.withTx(ctx, func(q *sqlc.Queries) error {
		if _, err := s.authorizeWorkspace(ctx, q, userID, workspaceID); err != nil {
			return err
		}
		if _, err := s.requireActiveDevice(ctx, q, userID, workspaceID, deviceID); err != nil {
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
		if accountUsage.TotalStorageBytes+sizeBytes > s.cfg.SyncMaxTotalStorageBytesPerUser {
			return &QuotaError{
				Limit:     syncv1.SyncQuotaLimit_SYNC_QUOTA_LIMIT_USER_TOTAL_STORAGE_BYTES,
				Max:       s.cfg.SyncMaxTotalStorageBytesPerUser,
				Current:   accountUsage.TotalStorageBytes,
				Requested: sizeBytes,
			}
		}
		if workspaceUsage.StorageBytes+sizeBytes > s.cfg.SyncMaxStorageBytesPerWorkspace {
			return &QuotaError{
				Limit:     syncv1.SyncQuotaLimit_SYNC_QUOTA_LIMIT_WORKSPACE_STORAGE_BYTES,
				Max:       s.cfg.SyncMaxStorageBytesPerWorkspace,
				Current:   workspaceUsage.StorageBytes,
				Requested: sizeBytes,
			}
		}

		current, err := q.GetSyncObjectForUpdate(ctx, sqlc.GetSyncObjectForUpdateParams{
			WorkspaceID: workspaceID,
			ObjectID:    objectID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrPermissionDenied
		}
		if err != nil {
			return err
		}
		if current.StorageProvider != sqlc.KukuSyncStorageProviderLocal {
			return ErrDevBytesDisabled
		}
		if current.UploadState == sqlc.KukuSyncObjectStateAvailable {
			if current.CiphertextSha256 == ciphertextSHA256 && current.SizeBytes == sizeBytes {
				object = current
				return nil
			}
			return ErrObjectMetadataMismatch
		}
		if current.UploadState != sqlc.KukuSyncObjectStateReserved && current.UploadState != sqlc.KukuSyncObjectStatePending {
			return ErrObjectNotAvailable
		}
		if err := s.store.Put(ctx, current.StorageKey, encryptedBlob); err != nil {
			return err
		}
		object, err = q.MarkSyncObjectAvailable(ctx, sqlc.MarkSyncObjectAvailableParams{
			WorkspaceID:      workspaceID,
			ObjectID:         objectID,
			CiphertextSha256: ciphertextSHA256,
			SizeBytes:        sizeBytes,
		})
		if err != nil {
			return err
		}
		if err := q.AddSyncUsageAvailableObjectBytes(ctx, sqlc.AddSyncUsageAvailableObjectBytesParams{
			WorkspaceID:  workspaceID,
			StorageBytes: sizeBytes,
		}); err != nil {
			return err
		}
		return q.AddSyncUsageAccountAvailableObjectBytes(ctx, sqlc.AddSyncUsageAccountAvailableObjectBytesParams{
			UserID:            userID,
			TotalStorageBytes: sizeBytes,
		})
	})
	return object, err
}

func (s *Service) DownloadObjectBytesDev(ctx context.Context, userID, workspaceID, deviceID uuid.UUID, objectID string) (sqlc.KukuSyncObject, []byte, error) {
	if !s.cfg.SyncDirectBytesDevEnabled {
		return sqlc.KukuSyncObject{}, nil, ErrDevBytesDisabled
	}
	if _, err := s.GetWorkspace(ctx, userID, workspaceID); err != nil {
		return sqlc.KukuSyncObject{}, nil, err
	}
	if _, err := s.queries.GetActiveSyncDevice(ctx, sqlc.GetActiveSyncDeviceParams{
		WorkspaceID: workspaceID,
		ID:          deviceID,
		UserID:      userID,
	}); errors.Is(err, pgx.ErrNoRows) {
		return sqlc.KukuSyncObject{}, nil, ErrPermissionDenied
	} else if err != nil {
		return sqlc.KukuSyncObject{}, nil, err
	}
	object, err := s.queries.GetSyncObject(ctx, sqlc.GetSyncObjectParams{
		WorkspaceID: workspaceID,
		ObjectID:    objectID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.KukuSyncObject{}, nil, ErrPermissionDenied
	}
	if err != nil {
		return sqlc.KukuSyncObject{}, nil, err
	}
	if object.UploadState != sqlc.KukuSyncObjectStateAvailable {
		return sqlc.KukuSyncObject{}, nil, ErrObjectNotAvailable
	}
	payload, err := s.store.Get(ctx, object.StorageKey)
	return object, payload, err
}

func (s *Service) authorizeWorkspace(ctx context.Context, q *sqlc.Queries, userID, workspaceID uuid.UUID) (sqlc.KukuSyncWorkspace, error) {
	workspace, err := q.GetSyncWorkspaceByIDAndOwner(ctx, sqlc.GetSyncWorkspaceByIDAndOwnerParams{
		ID:          workspaceID,
		OwnerUserID: userID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.KukuSyncWorkspace{}, ErrPermissionDenied
	}
	return workspace, err
}

func (s *Service) requireActiveDevice(ctx context.Context, q *sqlc.Queries, userID, workspaceID, deviceID uuid.UUID) (sqlc.KukuSyncDevice, error) {
	device, err := q.GetActiveSyncDevice(ctx, sqlc.GetActiveSyncDeviceParams{
		WorkspaceID: workspaceID,
		ID:          deviceID,
		UserID:      userID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.KukuSyncDevice{}, ErrPermissionDenied
	}
	return device, err
}

func validateCiphertextMetadata(ciphertextSHA256 string, sizeBytes int64, encryptedBlob []byte) error {
	ciphertextSHA256, err := validateCiphertextDescriptor(ciphertextSHA256, sizeBytes)
	if err != nil {
		return err
	}
	if int64(len(encryptedBlob)) != sizeBytes {
		return ErrObjectMetadataMismatch
	}
	sum := sha256.Sum256(encryptedBlob)
	if hex.EncodeToString(sum[:]) != ciphertextSHA256 {
		return ErrObjectMetadataMismatch
	}
	return nil
}

func validateCiphertextDescriptor(ciphertextSHA256 string, sizeBytes int64) (string, error) {
	ciphertextSHA256 = strings.ToLower(strings.TrimSpace(ciphertextSHA256))
	if len(ciphertextSHA256) != sha256.Size*2 {
		return "", fmt.Errorf("%w: ciphertext sha256 must be hex sha256", ErrInvalidArgument)
	}
	if _, err := hex.DecodeString(ciphertextSHA256); err != nil {
		return "", fmt.Errorf("%w: ciphertext sha256 must be hex sha256", ErrInvalidArgument)
	}
	if sizeBytes <= 0 {
		return "", ErrObjectMetadataMismatch
	}
	return ciphertextSHA256, nil
}

func objectKindToSQL(kind syncv1.SyncObjectKind) (sqlc.KukuSyncObjectKind, error) {
	switch kind {
	case syncv1.SyncObjectKind_SYNC_OBJECT_KIND_COMMIT_BODY:
		return sqlc.KukuSyncObjectKindCommitBody, nil
	case syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CONTENT_PACK:
		return sqlc.KukuSyncObjectKindContentPack, nil
	case syncv1.SyncObjectKind_SYNC_OBJECT_KIND_CHECKPOINT_PACK:
		return sqlc.KukuSyncObjectKindCheckpointPack, nil
	case syncv1.SyncObjectKind_SYNC_OBJECT_KIND_LARGE_OBJECT:
		return sqlc.KukuSyncObjectKindLargeObject, nil
	default:
		return "", fmt.Errorf("%w: unsupported object kind", ErrInvalidArgument)
	}
}

func keyRecipientTypeToSQL(kind syncv1.SyncKeyRecipientType) (sqlc.KukuSyncKeyRecipientType, error) {
	switch kind {
	case syncv1.SyncKeyRecipientType_SYNC_KEY_RECIPIENT_TYPE_PASSPHRASE:
		return sqlc.KukuSyncKeyRecipientTypePassphrase, nil
	case syncv1.SyncKeyRecipientType_SYNC_KEY_RECIPIENT_TYPE_DEVICE:
		return sqlc.KukuSyncKeyRecipientTypeDevice, nil
	default:
		return "", fmt.Errorf("%w: unsupported key recipient type", ErrInvalidArgument)
	}
}

func accountKeyRecipientTypeToSQL(kind syncv1.SyncAccountKeyRecipientType) (sqlc.KukuSyncAccountKeyRecipientType, error) {
	switch kind {
	case syncv1.SyncAccountKeyRecipientType_SYNC_ACCOUNT_KEY_RECIPIENT_TYPE_RECOVERY_PHRASE:
		return sqlc.KukuSyncAccountKeyRecipientTypeRecoveryPhrase, nil
	case syncv1.SyncAccountKeyRecipientType_SYNC_ACCOUNT_KEY_RECIPIENT_TYPE_DEVICE:
		return sqlc.KukuSyncAccountKeyRecipientTypeDevice, nil
	default:
		return "", fmt.Errorf("%w: unsupported account key recipient type", ErrInvalidArgument)
	}
}

func validateAccountKeyEnvelopeParams(
	envelopeID string,
	recipientType syncv1.SyncAccountKeyRecipientType,
	keyVersion int64,
	kdfParamsJSON string,
	encryptedEnvelope []byte,
) (sqlc.KukuSyncAccountKeyRecipientType, error) {
	if envelopeID == "" || keyVersion <= 0 || len(encryptedEnvelope) == 0 {
		return "", ErrInvalidArgument
	}
	if kdfParamsJSON != "" && !json.Valid([]byte(kdfParamsJSON)) {
		return "", fmt.Errorf("%w: invalid kdf params json", ErrInvalidArgument)
	}
	return accountKeyRecipientTypeToSQL(recipientType)
}

func (s *Service) withTx(ctx context.Context, fn func(*sqlc.Queries) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()
	if err := fn(s.queries.WithTx(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}
