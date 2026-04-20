package dashboard

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

var PlanLimits = map[sqlc.KukuPlan]int32{
	sqlc.KukuPlanFREE:  100,
	sqlc.KukuPlanPRO:   500,
	sqlc.KukuPlanULTRA: 10000,
}

type DashboardService struct {
	queries *sqlc.Queries
}

type CurrentUsage struct {
	AIRequestsUsed  int32
	AIRequestsLimit int32
}

func NewDashboardService(queries *sqlc.Queries) *DashboardService {
	return &DashboardService{queries: queries}
}

func (s *DashboardService) GetSubscription(ctx context.Context, userID uuid.UUID) (sqlc.KukuSubscription, error) {
	sub, err := s.queries.GetSubscriptionByUserID(ctx, userID)
	if err == nil {
		return sub, nil
	}
	if err != nil && err != pgx.ErrNoRows {
		return sqlc.KukuSubscription{}, err
	}
	return s.queries.EnsureSubscriptionExists(ctx, userID)
}

func (s *DashboardService) GetCurrentUsage(ctx context.Context, userID uuid.UUID) (CurrentUsage, error) {
	sub, err := s.GetSubscription(ctx, userID)
	if err != nil {
		return CurrentUsage{}, err
	}
	start := sub.CurrentPeriodStart.Time
	end := sub.CurrentPeriodEnd.Time
	usage, err := s.queries.GetCurrentPeriodUsage(ctx, sqlc.GetCurrentPeriodUsageParams{
		UserID: userID,
		Date:   database.Date(start),
		Date_2: database.Date(end),
	})
	if err != nil {
		return CurrentUsage{}, err
	}
	return CurrentUsage{
		AIRequestsUsed:  usage.TotalAiRequests,
		AIRequestsLimit: PlanLimits[sub.Plan],
	}, nil
}

func (s *DashboardService) GetUsageStats(ctx context.Context, userID uuid.UUID, days int) ([]sqlc.GetUsageStatsByUserAndDateRangeRow, error) {
	end := time.Now().UTC().Truncate(24 * time.Hour)
	start := end.AddDate(0, 0, -days+1)
	return s.queries.GetUsageStatsByUserAndDateRange(ctx, sqlc.GetUsageStatsByUserAndDateRangeParams{
		UserID: userID,
		Date:   database.Date(start),
		Date_2: database.Date(end),
	})
}
