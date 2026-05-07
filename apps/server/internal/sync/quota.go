package sync

import (
	"context"

	"github.com/google/uuid"

	syncv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1"

	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

type SyncUsageSnapshot struct {
	Account   sqlc.KukuSyncUsageAccount
	Workspace sqlc.KukuSyncUsageWorkspace
}

func (s *Service) checkUploadBatchQuota(accountUsage sqlc.KukuSyncUsageAccount, workspaceUsage sqlc.KukuSyncUsageWorkspace, additionalPendingBytes int64) error {
	if workspaceUsage.PendingUploadBytes+additionalPendingBytes > s.cfg.SyncMaxPendingUploadBytes {
		return &QuotaError{
			Limit:     syncv1.SyncQuotaLimit_SYNC_QUOTA_LIMIT_PENDING_UPLOAD_BYTES,
			Max:       s.cfg.SyncMaxPendingUploadBytes,
			Current:   workspaceUsage.PendingUploadBytes,
			Requested: additionalPendingBytes,
		}
	}
	if accountUsage.TotalStorageBytes+accountUsage.PendingUploadBytes+additionalPendingBytes > s.cfg.SyncMaxTotalStorageBytesPerUser {
		return &QuotaError{
			Limit:     syncv1.SyncQuotaLimit_SYNC_QUOTA_LIMIT_USER_TOTAL_STORAGE_BYTES,
			Max:       s.cfg.SyncMaxTotalStorageBytesPerUser,
			Current:   accountUsage.TotalStorageBytes + accountUsage.PendingUploadBytes,
			Requested: additionalPendingBytes,
		}
	}
	if workspaceUsage.StorageBytes+workspaceUsage.PendingUploadBytes+additionalPendingBytes > s.cfg.SyncMaxStorageBytesPerWorkspace {
		return &QuotaError{
			Limit:     syncv1.SyncQuotaLimit_SYNC_QUOTA_LIMIT_WORKSPACE_STORAGE_BYTES,
			Max:       s.cfg.SyncMaxStorageBytesPerWorkspace,
			Current:   workspaceUsage.StorageBytes + workspaceUsage.PendingUploadBytes,
			Requested: additionalPendingBytes,
		}
	}
	return nil
}

func (s *Service) RecalculateSyncUsage(ctx context.Context, userID, workspaceID uuid.UUID) (SyncUsageSnapshot, error) {
	var snapshot SyncUsageSnapshot
	err := s.withTx(ctx, func(q *sqlc.Queries) error {
		workspace, err := s.authorizeWorkspace(ctx, q, userID, workspaceID)
		if err != nil {
			return err
		}
		if _, err := q.EnsureSyncUsageAccount(ctx, userID); err != nil {
			return err
		}
		if _, err := q.GetSyncUsageAccountForUpdate(ctx, userID); err != nil {
			return err
		}
		if _, err := q.GetSyncUsageWorkspaceForUpdate(ctx, workspace.ID); err != nil {
			return err
		}
		workspaceUsage, err := q.RecalculateSyncUsageWorkspace(ctx, workspace.ID)
		if err != nil {
			return err
		}
		accountUsage, err := q.RecalculateSyncUsageAccount(ctx, userID)
		if err != nil {
			return err
		}
		snapshot = SyncUsageSnapshot{
			Account:   accountUsage,
			Workspace: workspaceUsage,
		}
		return nil
	})
	return snapshot, err
}
