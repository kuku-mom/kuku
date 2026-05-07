package sync

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

const defaultGCOrphanLimit int32 = 100

type SyncGCOptions struct {
	DryRun      bool
	Now         time.Time
	OrphanLimit int32
}

type SyncGCReport struct {
	WorkspaceID                   uuid.UUID
	DryRun                        bool
	LatestCheckpoint              SyncCheckpointInfo
	HasLatestCheckpoint           bool
	ReachableCommitCount          int
	ReachableObjectCount          int
	PreservedCommitCount          int
	PreservedObjectCount          int
	OrphanCandidates              []SyncGCObjectCandidate
	DeletedOrphans                []SyncGCObjectCandidate
	OldReachableHistoryCandidates []SyncGCCommitCandidate
	UsageBefore                   SyncUsageSnapshot
	UsageAfter                    SyncUsageSnapshot
}

type SyncGCObjectCandidate struct {
	ObjectID    string
	ObjectKind  sqlc.KukuSyncObjectKind
	UploadState sqlc.KukuSyncObjectState
	SizeBytes   int64
}

type SyncGCCommitCandidate struct {
	CommitID   string
	CommitKind sqlc.KukuSyncCommitKind
	ServerSeq  int64
	Reason     string
}

type SyncReachableGraph struct {
	HeadCommitID               string
	CommitIDs                  map[string]struct{}
	ObjectIDs                  map[string]struct{}
	PreservedCommitIDs         map[string]struct{}
	PreservedObjectIDs         map[string]struct{}
	LatestCheckpoint           SyncCheckpointInfo
	HasLatestCheckpoint        bool
	OldReachableHistoryCommits []SyncGCCommitCandidate
}

func (s *Service) BuildReachableObjectGraph(ctx context.Context, userID, workspaceID uuid.UUID) (SyncReachableGraph, error) {
	workspace, err := s.GetWorkspace(ctx, userID, workspaceID)
	if err != nil {
		return SyncReachableGraph{}, err
	}
	commits, err := s.queries.ListSyncCommitsByWorkspaceDesc(ctx, workspaceID)
	if err != nil {
		return SyncReachableGraph{}, err
	}
	commitObjects, err := s.queries.ListSyncCommitObjectsByWorkspace(ctx, workspaceID)
	if err != nil {
		return SyncReachableGraph{}, err
	}
	return buildReachableObjectGraph(workspace, commits, commitObjects), nil
}

func (s *Service) RunWorkspaceGC(ctx context.Context, userID, workspaceID uuid.UUID, options SyncGCOptions) (SyncGCReport, error) {
	now := options.Now
	if now.IsZero() {
		now = s.now()
	}
	limit := options.OrphanLimit
	if limit <= 0 {
		limit = defaultGCOrphanLimit
	}

	report := SyncGCReport{
		WorkspaceID: workspaceID,
		DryRun:      options.DryRun,
	}

	err := s.withTx(ctx, func(q *sqlc.Queries) error {
		workspace, err := s.authorizeWorkspace(ctx, q, userID, workspaceID)
		if err != nil {
			return err
		}
		if _, err := q.EnsureSyncUsageAccount(ctx, userID); err != nil {
			return err
		}
		accountBefore, err := q.GetSyncUsageAccountForUpdate(ctx, userID)
		if err != nil {
			return err
		}
		workspaceBefore, err := q.GetSyncUsageWorkspaceForUpdate(ctx, workspaceID)
		if err != nil {
			return err
		}
		report.UsageBefore = SyncUsageSnapshot{
			Account:   accountBefore,
			Workspace: workspaceBefore,
		}

		commits, err := q.ListSyncCommitsByWorkspaceDesc(ctx, workspaceID)
		if err != nil {
			return err
		}
		commitObjects, err := q.ListSyncCommitObjectsByWorkspace(ctx, workspaceID)
		if err != nil {
			return err
		}
		graph := buildReachableObjectGraph(workspace, commits, commitObjects)
		report.LatestCheckpoint = graph.LatestCheckpoint
		report.HasLatestCheckpoint = graph.HasLatestCheckpoint
		report.ReachableCommitCount = len(graph.CommitIDs)
		report.ReachableObjectCount = len(graph.ObjectIDs)
		report.PreservedCommitCount = len(graph.PreservedCommitIDs)
		report.PreservedObjectCount = len(graph.PreservedObjectIDs)
		report.OldReachableHistoryCandidates = graph.OldReachableHistoryCommits

		orphanObjects, err := q.ListExpiredOrphanSyncObjectsForUpdate(ctx, sqlc.ListExpiredOrphanSyncObjectsForUpdateParams{
			WorkspaceID: workspaceID,
			ExpiresAt:   database.Timestamptz(now),
			Limit:       limit,
		})
		if err != nil {
			return err
		}
		report.OrphanCandidates = objectCandidates(orphanObjects)
		if options.DryRun || len(orphanObjects) == 0 {
			report.UsageAfter = report.UsageBefore
			return nil
		}

		deleter, ok := s.store.(DeletingObjectStore)
		if !ok {
			return ErrNotImplemented
		}
		deleted := make([]SyncGCObjectCandidate, 0, len(orphanObjects))
		for _, object := range orphanObjects {
			if err := deleteObjectBlob(ctx, deleter, object); err != nil {
				return err
			}
			deletedObject, err := q.MarkSyncObjectDeleted(ctx, sqlc.MarkSyncObjectDeletedParams{
				WorkspaceID: workspaceID,
				ObjectID:    object.ObjectID,
			})
			if err != nil {
				return err
			}
			deleted = append(deleted, objectCandidate(deletedObject))
		}
		report.DeletedOrphans = deleted

		workspaceAfter, err := q.RecalculateSyncUsageWorkspace(ctx, workspaceID)
		if err != nil {
			return err
		}
		accountAfter, err := q.RecalculateSyncUsageAccount(ctx, userID)
		if err != nil {
			return err
		}
		report.UsageAfter = SyncUsageSnapshot{
			Account:   accountAfter,
			Workspace: workspaceAfter,
		}
		return nil
	})
	return report, err
}

func buildReachableObjectGraph(workspace sqlc.KukuSyncWorkspace, commits []sqlc.KukuSyncCommit, commitObjects []sqlc.KukuSyncCommitObject) SyncReachableGraph {
	objectsByCommit := make(map[string]map[string]struct{}, len(commits))
	for _, link := range commitObjects {
		if objectsByCommit[link.CommitID] == nil {
			objectsByCommit[link.CommitID] = make(map[string]struct{})
		}
		objectsByCommit[link.CommitID][link.ObjectID] = struct{}{}
	}

	commitsByID := make(map[string]sqlc.KukuSyncCommit, len(commits))
	for _, commit := range commits {
		commitsByID[commit.CommitID] = commit
		addCommitFieldObjects(objectsByCommit, commit)
	}

	graph := SyncReachableGraph{
		HeadCommitID:       textValue(workspace.CurrentHeadCommitID),
		CommitIDs:          make(map[string]struct{}),
		ObjectIDs:          make(map[string]struct{}),
		PreservedCommitIDs: make(map[string]struct{}),
		PreservedObjectIDs: make(map[string]struct{}),
	}
	graph.LatestCheckpoint, graph.HasLatestCheckpoint = latestCheckpointFromCommits(commits)

	visitReachableCommits(graph.HeadCommitID, commitsByID, graph.CommitIDs)
	for commitID := range graph.CommitIDs {
		for objectID := range objectsByCommit[commitID] {
			graph.ObjectIDs[objectID] = struct{}{}
		}
	}

	if graph.HasLatestCheckpoint {
		for _, commit := range commits {
			serverSeq := commitServerSeq(commit)
			if serverSeq < graph.LatestCheckpoint.ServerSeq {
				continue
			}
			graph.PreservedCommitIDs[commit.CommitID] = struct{}{}
			for objectID := range objectsByCommit[commit.CommitID] {
				graph.PreservedObjectIDs[objectID] = struct{}{}
			}
		}
	} else {
		for commitID := range graph.CommitIDs {
			graph.PreservedCommitIDs[commitID] = struct{}{}
		}
		for objectID := range graph.ObjectIDs {
			graph.PreservedObjectIDs[objectID] = struct{}{}
		}
	}

	if graph.HasLatestCheckpoint {
		for _, commit := range commits {
			serverSeq := commitServerSeq(commit)
			if _, reachable := graph.CommitIDs[commit.CommitID]; reachable && serverSeq < graph.LatestCheckpoint.ServerSeq {
				graph.OldReachableHistoryCommits = append(graph.OldReachableHistoryCommits, SyncGCCommitCandidate{
					CommitID:   commit.CommitID,
					CommitKind: commit.CommitKind,
					ServerSeq:  serverSeq,
					Reason:     "before_latest_checkpoint",
				})
			}
		}
	}
	return graph
}

func visitReachableCommits(commitID string, commitsByID map[string]sqlc.KukuSyncCommit, visited map[string]struct{}) {
	if commitID == "" {
		return
	}
	if _, ok := visited[commitID]; ok {
		return
	}
	commit, ok := commitsByID[commitID]
	if !ok {
		return
	}
	visited[commitID] = struct{}{}
	for _, parentID := range commit.ParentCommitIds {
		visitReachableCommits(parentID, commitsByID, visited)
	}
}

func addCommitFieldObjects(objectsByCommit map[string]map[string]struct{}, commit sqlc.KukuSyncCommit) {
	if objectsByCommit[commit.CommitID] == nil {
		objectsByCommit[commit.CommitID] = make(map[string]struct{})
	}
	if commit.BodyObjectID != "" {
		objectsByCommit[commit.CommitID][commit.BodyObjectID] = struct{}{}
	}
	for _, objectID := range commit.ReferencedObjectIds {
		if objectID != "" {
			objectsByCommit[commit.CommitID][objectID] = struct{}{}
		}
	}
}

func commitServerSeq(commit sqlc.KukuSyncCommit) int64 {
	if !commit.ServerSeq.Valid {
		return 0
	}
	return commit.ServerSeq.Int64
}

func objectCandidates(objects []sqlc.KukuSyncObject) []SyncGCObjectCandidate {
	out := make([]SyncGCObjectCandidate, 0, len(objects))
	for _, object := range objects {
		out = append(out, objectCandidate(object))
	}
	return out
}

func objectCandidate(object sqlc.KukuSyncObject) SyncGCObjectCandidate {
	return SyncGCObjectCandidate{
		ObjectID:    object.ObjectID,
		ObjectKind:  object.ObjectKind,
		UploadState: object.UploadState,
		SizeBytes:   object.SizeBytes,
	}
}

func deleteObjectBlob(ctx context.Context, store DeletingObjectStore, object sqlc.KukuSyncObject) error {
	if object.StorageKey == "" {
		return nil
	}
	if err := store.Delete(ctx, object.StorageKey); err != nil && !errors.Is(err, ErrObjectStoreNotFound) {
		return err
	}
	return nil
}
