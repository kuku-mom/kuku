package sync

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

type SyncCheckpointInfo struct {
	CommitID  string
	ServerSeq int64
}

func (s *Service) GetLatestCheckpoint(ctx context.Context, userID, workspaceID uuid.UUID) (SyncCheckpointInfo, bool, error) {
	if _, err := s.GetWorkspace(ctx, userID, workspaceID); err != nil {
		return SyncCheckpointInfo{}, false, err
	}
	commit, err := s.queries.GetLatestSyncCheckpointCommit(ctx, workspaceID)
	if err == nil {
		return checkpointInfoFromCommit(commit), true, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return SyncCheckpointInfo{}, false, nil
	}
	return SyncCheckpointInfo{}, false, err
}

func latestCheckpointFromCommits(commits []sqlc.KukuSyncCommit) (SyncCheckpointInfo, bool) {
	for _, commit := range commits {
		if commit.CommitKind == sqlc.KukuSyncCommitKindCheckpoint {
			return checkpointInfoFromCommit(commit), true
		}
	}
	return SyncCheckpointInfo{}, false
}

func checkpointInfoFromCommit(commit sqlc.KukuSyncCommit) SyncCheckpointInfo {
	var serverSeq int64
	if commit.ServerSeq.Valid {
		serverSeq = commit.ServerSeq.Int64
	}
	return SyncCheckpointInfo{
		CommitID:  commit.CommitID,
		ServerSeq: serverSeq,
	}
}
