package sync

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

const defaultDeletedWorkspaceCleanupLimit int32 = 20

type DeletedWorkspaceCleanupOptions struct {
	Now            time.Time
	WorkspaceLimit int32
}

type DeletedWorkspaceCleanupReport struct {
	DeletedWorkspaces []uuid.UUID
	DeletedObjectKeys int
}

// TODO: Wire this into the server's cron/worker.
func (s *Service) RunDeletedWorkspaceCleanup(ctx context.Context, options DeletedWorkspaceCleanupOptions) (DeletedWorkspaceCleanupReport, error) {
	deleter, ok := s.store.(DeletingObjectStore)
	if !ok {
		return DeletedWorkspaceCleanupReport{}, ErrNotImplemented
	}
	now := options.Now
	if now.IsZero() {
		now = s.now()
	}
	limit := options.WorkspaceLimit
	if limit <= 0 {
		limit = defaultDeletedWorkspaceCleanupLimit
	}

	report := DeletedWorkspaceCleanupReport{}
	err := s.withTx(ctx, func(q *sqlc.Queries) error {
		workspaces, err := q.ListDeletedSyncWorkspacesForCleanup(ctx, sqlc.ListDeletedSyncWorkspacesForCleanupParams{
			DeletedAt: database.Timestamptz(now),
			Limit:     limit,
		})
		if err != nil {
			return err
		}
		for _, workspace := range workspaces {
			objects, err := q.ListAllSyncObjectsByWorkspaceForUpdate(ctx, workspace.ID)
			if err != nil {
				return err
			}
			for _, object := range objects {
				if err := deleteObjectBlob(ctx, deleter, object); err != nil {
					return err
				}
			}
			if err := q.HardDeleteSyncWorkspace(ctx, workspace.ID); err != nil {
				return err
			}
			report.DeletedWorkspaces = append(report.DeletedWorkspaces, workspace.ID)
			report.DeletedObjectKeys += len(objects)
		}
		return nil
	})
	return report, err
}
