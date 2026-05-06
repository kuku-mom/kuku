package sync

import (
	syncv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/sync/v1"

	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

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
