package sync

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	syncv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1"

	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

type PublishCommitParams struct {
	WorkspaceID          uuid.UUID
	CommitID             string
	CommitKind           syncv1.SyncCommitKind
	ExpectedHeadCommitID string
	ParentCommitIDs      []string
	AuthorDeviceID       uuid.UUID
	DeviceSeq            int64
	BodyObjectID         string
	BodyCiphertextSHA256 string
	BodySizeBytes        int64
	ReferencedObjectIDs  []string
	Signature            []byte
}

type PublishCommitResult struct {
	Commit      sqlc.KukuSyncCommit
	HeadVersion int64
	Idempotent  bool
}

func (s *Service) PublishCommit(ctx context.Context, userID uuid.UUID, params PublishCommitParams) (PublishCommitResult, error) {
	normalized, err := normalizePublishCommitParams(params)
	if err != nil {
		return PublishCommitResult{}, err
	}
	canonicalPayload, err := canonicalCommitPayload(normalized)
	if err != nil {
		return PublishCommitResult{}, err
	}

	var result PublishCommitResult
	err = s.withTx(ctx, func(q *sqlc.Queries) error {
		workspace, err := s.authorizeWorkspace(ctx, q, userID, normalized.WorkspaceID)
		if err != nil {
			return err
		}

		existing, err := q.GetSyncCommit(ctx, sqlc.GetSyncCommitParams{
			WorkspaceID: normalized.WorkspaceID,
			CommitID:    normalized.CommitID,
		})
		if err == nil {
			matches, err := commitMatchesPayload(existing, canonicalPayload, normalized.Signature)
			if err != nil {
				return err
			}
			if !matches {
				return ErrDuplicateCommitPayload
			}
			result = PublishCommitResult{
				Commit:      existing,
				HeadVersion: workspace.HeadVersion,
				Idempotent:  true,
			}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}

		workspace, err = q.GetSyncWorkspaceForUpdate(ctx, sqlc.GetSyncWorkspaceForUpdateParams{
			ID:          normalized.WorkspaceID,
			OwnerUserID: userID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrPermissionDenied
		}
		if err != nil {
			return err
		}

		existing, err = q.GetSyncCommit(ctx, sqlc.GetSyncCommitParams{
			WorkspaceID: normalized.WorkspaceID,
			CommitID:    normalized.CommitID,
		})
		if err == nil {
			matches, err := commitMatchesPayload(existing, canonicalPayload, normalized.Signature)
			if err != nil {
				return err
			}
			if !matches {
				return ErrDuplicateCommitPayload
			}
			result = PublishCommitResult{
				Commit:      existing,
				HeadVersion: workspace.HeadVersion,
				Idempotent:  true,
			}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}

		currentHead := textValue(workspace.CurrentHeadCommitID)
		if currentHead != normalized.ExpectedHeadCommitID {
			return &HeadConflictError{
				WorkspaceID:   normalized.WorkspaceID.String(),
				CurrentHeadID: currentHead,
				HeadVersion:   workspace.HeadVersion,
			}
		}

		device, err := q.GetActiveSyncDeviceForUpdate(ctx, sqlc.GetActiveSyncDeviceForUpdateParams{
			WorkspaceID: normalized.WorkspaceID,
			ID:          normalized.AuthorDeviceID,
			UserID:      userID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrPermissionDenied
		}
		if err != nil {
			return err
		}
		if normalized.DeviceSeq <= device.LastDeviceSeq {
			return ErrDuplicateDeviceSeq
		}
		if len(device.SigningPublicKey) != ed25519.PublicKeySize {
			return ErrInvalidSignature
		}
		if !ed25519.Verify(ed25519.PublicKey(device.SigningPublicKey), canonicalPayload, normalized.Signature) {
			return ErrInvalidSignature
		}

		if err := s.validateParents(ctx, q, normalized); err != nil {
			return err
		}
		objects, bodyObject, err := s.validateCommitObjects(ctx, q, normalized)
		if err != nil {
			return err
		}

		commitKind, err := commitKindToSQL(normalized.CommitKind)
		if err != nil {
			return err
		}
		commit, err := q.CreateSyncCommit(ctx, sqlc.CreateSyncCommitParams{
			WorkspaceID:          normalized.WorkspaceID,
			CommitID:             normalized.CommitID,
			CommitKind:           commitKind,
			ExpectedHeadCommitID: database.Text(normalized.ExpectedHeadCommitID),
			AuthorDeviceID:       normalized.AuthorDeviceID,
			DeviceSeq:            normalized.DeviceSeq,
			ParentCommitIds:      normalized.ParentCommitIDs,
			BodyObjectID:         normalized.BodyObjectID,
			BodyCiphertextSha256: normalized.BodyCiphertextSHA256,
			BodySizeBytes:        normalized.BodySizeBytes,
			ReferencedObjectIds:  normalized.ReferencedObjectIDs,
			Signature:            normalized.Signature,
		})
		if err != nil {
			return err
		}
		if err := q.CreateSyncCommitObject(ctx, sqlc.CreateSyncCommitObjectParams{
			WorkspaceID: normalized.WorkspaceID,
			CommitID:    normalized.CommitID,
			ObjectID:    bodyObject.ObjectID,
			ObjectRole:  sqlc.KukuSyncCommitObjectRoleBody,
		}); err != nil {
			return err
		}
		for _, object := range objects {
			if err := q.CreateSyncCommitObject(ctx, sqlc.CreateSyncCommitObjectParams{
				WorkspaceID: normalized.WorkspaceID,
				CommitID:    normalized.CommitID,
				ObjectID:    object.ObjectID,
				ObjectRole:  commitObjectRole(object.ObjectKind),
			}); err != nil {
				return err
			}
		}
		if err := q.UpdateSyncDeviceSequence(ctx, sqlc.UpdateSyncDeviceSequenceParams{
			WorkspaceID:   normalized.WorkspaceID,
			ID:            normalized.AuthorDeviceID,
			UserID:        userID,
			LastDeviceSeq: normalized.DeviceSeq,
		}); err != nil {
			return err
		}
		lastCheckpoint := ""
		if normalized.CommitKind == syncv1.SyncCommitKind_SYNC_COMMIT_KIND_CHECKPOINT {
			lastCheckpoint = normalized.CommitID
		}
		if err := q.UpsertSyncDeviceCursor(ctx, sqlc.UpsertSyncDeviceCursorParams{
			WorkspaceID:                normalized.WorkspaceID,
			DeviceID:                   normalized.AuthorDeviceID,
			LastSeenCommitID:           database.Text(normalized.CommitID),
			LastSeenCheckpointCommitID: database.Text(lastCheckpoint),
		}); err != nil {
			return err
		}
		updatedWorkspace, err := q.UpdateSyncWorkspaceHead(ctx, sqlc.UpdateSyncWorkspaceHeadParams{
			ID:                  normalized.WorkspaceID,
			OwnerUserID:         userID,
			CurrentHeadCommitID: database.Text(normalized.CommitID),
		})
		if err != nil {
			return err
		}
		result = PublishCommitResult{
			Commit:      commit,
			HeadVersion: updatedWorkspace.HeadVersion,
			Idempotent:  false,
		}
		return nil
	})
	return result, err
}

func normalizePublishCommitParams(params PublishCommitParams) (PublishCommitParams, error) {
	params.CommitID = strings.TrimSpace(params.CommitID)
	params.ExpectedHeadCommitID = strings.TrimSpace(params.ExpectedHeadCommitID)
	params.BodyObjectID = strings.TrimSpace(params.BodyObjectID)
	params.BodyCiphertextSHA256 = strings.ToLower(strings.TrimSpace(params.BodyCiphertextSHA256))
	if params.WorkspaceID == uuid.Nil ||
		params.CommitID == "" ||
		params.AuthorDeviceID == uuid.Nil ||
		params.BodyObjectID == "" ||
		params.DeviceSeq <= 0 ||
		params.BodySizeBytes <= 0 ||
		len(params.Signature) != ed25519.SignatureSize {
		return PublishCommitParams{}, ErrInvalidArgument
	}
	if _, err := commitKindToSQL(params.CommitKind); err != nil {
		return PublishCommitParams{}, err
	}
	if len(params.BodyCiphertextSHA256) != sha256.Size*2 {
		return PublishCommitParams{}, ErrInvalidArgument
	}
	if _, err := hex.DecodeString(params.BodyCiphertextSHA256); err != nil {
		return PublishCommitParams{}, ErrInvalidArgument
	}
	params.ParentCommitIDs = normalizeIDsPreserveOrder(params.ParentCommitIDs)
	if hasDuplicate(params.ParentCommitIDs) {
		return PublishCommitParams{}, ErrInvalidCommitParent
	}
	params.ReferencedObjectIDs = normalizeIDsSorted(params.ReferencedObjectIDs)
	if hasDuplicate(params.ReferencedObjectIDs) {
		return PublishCommitParams{}, ErrInvalidArgument
	}
	if slices.Contains(params.ReferencedObjectIDs, params.BodyObjectID) {
		return PublishCommitParams{}, ErrInvalidArgument
	}
	return params, nil
}

func (s *Service) validateParents(ctx context.Context, q *sqlc.Queries, params PublishCommitParams) error {
	switch params.CommitKind {
	case syncv1.SyncCommitKind_SYNC_COMMIT_KIND_CHECKPOINT:
		if params.ExpectedHeadCommitID == "" {
			if len(params.ParentCommitIDs) != 0 {
				return ErrInvalidCommitParent
			}
			return nil
		}
		if len(params.ParentCommitIDs) != 1 || params.ParentCommitIDs[0] != params.ExpectedHeadCommitID {
			return ErrInvalidCommitParent
		}
	case syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL:
		if params.ExpectedHeadCommitID == "" || len(params.ParentCommitIDs) != 1 || params.ParentCommitIDs[0] != params.ExpectedHeadCommitID {
			return ErrInvalidCommitParent
		}
	case syncv1.SyncCommitKind_SYNC_COMMIT_KIND_MERGE:
		if params.ExpectedHeadCommitID == "" || len(params.ParentCommitIDs) < 2 || !contains(params.ParentCommitIDs, params.ExpectedHeadCommitID) {
			return ErrInvalidCommitParent
		}
	default:
		return ErrInvalidCommitParent
	}
	for _, parentID := range params.ParentCommitIDs {
		if _, err := q.GetSyncCommit(ctx, sqlc.GetSyncCommitParams{
			WorkspaceID: params.WorkspaceID,
			CommitID:    parentID,
		}); errors.Is(err, pgx.ErrNoRows) {
			return ErrInvalidCommitParent
		} else if err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) validateCommitObjects(ctx context.Context, q *sqlc.Queries, params PublishCommitParams) ([]sqlc.KukuSyncObject, sqlc.KukuSyncObject, error) {
	bodyObject, err := q.GetSyncObjectForUpdate(ctx, sqlc.GetSyncObjectForUpdateParams{
		WorkspaceID: params.WorkspaceID,
		ObjectID:    params.BodyObjectID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, sqlc.KukuSyncObject{}, ErrObjectNotAvailable
	}
	if err != nil {
		return nil, sqlc.KukuSyncObject{}, err
	}
	if bodyObject.UploadState != sqlc.KukuSyncObjectStateAvailable || bodyObject.ObjectKind != sqlc.KukuSyncObjectKindCommitBody {
		return nil, sqlc.KukuSyncObject{}, ErrObjectNotAvailable
	}
	if bodyObject.CiphertextSha256 != params.BodyCiphertextSHA256 || bodyObject.SizeBytes != params.BodySizeBytes {
		return nil, sqlc.KukuSyncObject{}, ErrObjectMetadataMismatch
	}
	if len(params.ReferencedObjectIDs) == 0 {
		if params.CommitKind == syncv1.SyncCommitKind_SYNC_COMMIT_KIND_CHECKPOINT {
			return nil, sqlc.KukuSyncObject{}, ErrObjectNotAvailable
		}
		return nil, bodyObject, nil
	}
	objects, err := q.ListSyncObjectsByIDs(ctx, sqlc.ListSyncObjectsByIDsParams{
		WorkspaceID: params.WorkspaceID,
		Column2:     params.ReferencedObjectIDs,
	})
	if err != nil {
		return nil, sqlc.KukuSyncObject{}, err
	}
	if len(objects) != len(params.ReferencedObjectIDs) {
		return nil, sqlc.KukuSyncObject{}, ErrObjectNotAvailable
	}
	hasCheckpointPack := false
	for _, object := range objects {
		if object.UploadState != sqlc.KukuSyncObjectStateAvailable {
			return nil, sqlc.KukuSyncObject{}, ErrObjectNotAvailable
		}
		if object.ObjectKind == sqlc.KukuSyncObjectKindCommitBody {
			return nil, sqlc.KukuSyncObject{}, ErrInvalidArgument
		}
		if object.ObjectKind == sqlc.KukuSyncObjectKindCheckpointPack {
			hasCheckpointPack = true
		}
	}
	if params.CommitKind == syncv1.SyncCommitKind_SYNC_COMMIT_KIND_CHECKPOINT && !hasCheckpointPack {
		return nil, sqlc.KukuSyncObject{}, ErrObjectNotAvailable
	}
	return objects, bodyObject, nil
}

type commitSignaturePayload struct {
	WorkspaceID          string   `json:"workspace_id"`
	CommitID             string   `json:"commit_id"`
	CommitKind           string   `json:"commit_kind"`
	ExpectedHeadCommitID string   `json:"expected_head_commit_id"`
	ParentCommitIDs      []string `json:"parent_commit_ids"`
	AuthorDeviceID       string   `json:"author_device_id"`
	DeviceSeq            int64    `json:"device_seq"`
	BodyObjectID         string   `json:"body_object_id"`
	BodyCiphertextSHA256 string   `json:"body_ciphertext_sha256"`
	BodySizeBytes        int64    `json:"body_size_bytes"`
	ReferencedObjectIDs  []string `json:"referenced_object_ids"`
}

func canonicalCommitPayload(params PublishCommitParams) ([]byte, error) {
	commitKind, err := commitKindToSQL(params.CommitKind)
	if err != nil {
		return nil, err
	}
	return json.Marshal(commitSignaturePayload{
		WorkspaceID:          params.WorkspaceID.String(),
		CommitID:             params.CommitID,
		CommitKind:           string(commitKind),
		ExpectedHeadCommitID: params.ExpectedHeadCommitID,
		ParentCommitIDs:      params.ParentCommitIDs,
		AuthorDeviceID:       params.AuthorDeviceID.String(),
		DeviceSeq:            params.DeviceSeq,
		BodyObjectID:         params.BodyObjectID,
		BodyCiphertextSHA256: params.BodyCiphertextSHA256,
		BodySizeBytes:        params.BodySizeBytes,
		ReferencedObjectIDs:  params.ReferencedObjectIDs,
	})
}

func canonicalCommitPayloadFromSQL(commit sqlc.KukuSyncCommit) ([]byte, error) {
	commitKind, err := commitKindToProtoChecked(commit.CommitKind)
	if err != nil {
		return nil, err
	}
	return canonicalCommitPayload(PublishCommitParams{
		WorkspaceID:          commit.WorkspaceID,
		CommitID:             commit.CommitID,
		CommitKind:           commitKind,
		ExpectedHeadCommitID: textValue(commit.ExpectedHeadCommitID),
		ParentCommitIDs:      commit.ParentCommitIds,
		AuthorDeviceID:       commit.AuthorDeviceID,
		DeviceSeq:            commit.DeviceSeq,
		BodyObjectID:         commit.BodyObjectID,
		BodyCiphertextSHA256: commit.BodyCiphertextSha256,
		BodySizeBytes:        commit.BodySizeBytes,
		ReferencedObjectIDs:  normalizeIDsSorted(commit.ReferencedObjectIds),
	})
}

func commitMatchesPayload(commit sqlc.KukuSyncCommit, canonicalPayload []byte, signature []byte) (bool, error) {
	existingPayload, err := canonicalCommitPayloadFromSQL(commit)
	if err != nil {
		return false, err
	}
	return bytes.Equal(existingPayload, canonicalPayload) && bytes.Equal(commit.Signature, signature), nil
}

func commitKindToSQL(kind syncv1.SyncCommitKind) (sqlc.KukuSyncCommitKind, error) {
	switch kind {
	case syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL:
		return sqlc.KukuSyncCommitKindIncremental, nil
	case syncv1.SyncCommitKind_SYNC_COMMIT_KIND_MERGE:
		return sqlc.KukuSyncCommitKindMerge, nil
	case syncv1.SyncCommitKind_SYNC_COMMIT_KIND_CHECKPOINT:
		return sqlc.KukuSyncCommitKindCheckpoint, nil
	default:
		return "", fmt.Errorf("%w: unsupported commit kind", ErrInvalidArgument)
	}
}

func commitKindToProtoChecked(kind sqlc.KukuSyncCommitKind) (syncv1.SyncCommitKind, error) {
	switch kind {
	case sqlc.KukuSyncCommitKindIncremental:
		return syncv1.SyncCommitKind_SYNC_COMMIT_KIND_INCREMENTAL, nil
	case sqlc.KukuSyncCommitKindMerge:
		return syncv1.SyncCommitKind_SYNC_COMMIT_KIND_MERGE, nil
	case sqlc.KukuSyncCommitKindCheckpoint:
		return syncv1.SyncCommitKind_SYNC_COMMIT_KIND_CHECKPOINT, nil
	default:
		return syncv1.SyncCommitKind_SYNC_COMMIT_KIND_UNSPECIFIED, fmt.Errorf("%w: unsupported commit kind", ErrInvalidArgument)
	}
}

func commitObjectRole(kind sqlc.KukuSyncObjectKind) sqlc.KukuSyncCommitObjectRole {
	switch kind {
	case sqlc.KukuSyncObjectKindContentPack:
		return sqlc.KukuSyncCommitObjectRoleContentPack
	case sqlc.KukuSyncObjectKindCheckpointPack:
		return sqlc.KukuSyncCommitObjectRoleCheckpointPack
	case sqlc.KukuSyncObjectKindLargeObject:
		return sqlc.KukuSyncCommitObjectRoleLargeObject
	default:
		return sqlc.KukuSyncCommitObjectRoleBody
	}
}

func normalizeIDsPreserveOrder(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func normalizeIDsSorted(values []string) []string {
	out := normalizeIDsPreserveOrder(values)
	sort.Strings(out)
	return out
}

func hasDuplicate(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			return true
		}
		seen[value] = struct{}{}
	}
	return false
}

func contains(values []string, needle string) bool {
	return slices.Contains(values, needle)
}
