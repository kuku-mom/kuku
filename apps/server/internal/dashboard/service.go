package dashboard

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

var ErrAIRequestLimitExceeded = errors.New("ai request limit exceeded")

const (
	maxInt64              = uint64(1<<63 - 1)
	subscriptionPeriodDay = 30
)

var PlanLimits = map[sqlc.KukuPlan]int32{
	sqlc.KukuPlanFREE:  100,
	sqlc.KukuPlanPRO:   500,
	sqlc.KukuPlanULTRA: 10000,
}

type DashboardService struct {
	pool    *pgxpool.Pool
	queries *sqlc.Queries
}

type CurrentUsage struct {
	AIRequestsUsed  int32
	AIRequestsLimit int32
}

func NewDashboardService(pool *pgxpool.Pool, queries *sqlc.Queries) *DashboardService {
	return &DashboardService{pool: pool, queries: queries}
}

func (s *DashboardService) GetSubscription(ctx context.Context, userID uuid.UUID) (sqlc.KukuSubscription, error) {
	var sub sqlc.KukuSubscription
	err := s.withTx(ctx, func(q *sqlc.Queries) error {
		var err error
		sub, err = s.getActiveSubscription(ctx, q, userID, time.Now().UTC())
		return err
	})
	return sub, err
}

func (s *DashboardService) GetCurrentUsage(ctx context.Context, userID uuid.UUID) (CurrentUsage, error) {
	var currentUsage CurrentUsage
	err := s.withTx(ctx, func(q *sqlc.Queries) error {
		sub, err := s.getActiveSubscription(ctx, q, userID, time.Now().UTC())
		if err != nil {
			return err
		}
		usage, err := q.GetCurrentPeriodUsage(ctx, sqlc.GetCurrentPeriodUsageParams{
			UserID: userID,
			Date:   database.Date(sub.CurrentPeriodStart.Time),
			Date_2: database.Date(sub.CurrentPeriodEnd.Time),
		})
		if err != nil {
			return err
		}
		currentUsage = CurrentUsage{
			AIRequestsUsed:  usage.TotalAiRequests,
			AIRequestsLimit: PlanLimits[sub.Plan],
		}
		return nil
	})
	return currentUsage, err
}

func (s *DashboardService) ReserveAIRequest(ctx context.Context, userID uuid.UUID) error {
	return s.withTx(ctx, func(q *sqlc.Queries) error {
		sub, err := s.getActiveSubscription(ctx, q, userID, time.Now().UTC())
		if err != nil {
			return err
		}
		usage, err := q.GetCurrentPeriodUsage(ctx, sqlc.GetCurrentPeriodUsageParams{
			UserID: userID,
			Date:   database.Date(sub.CurrentPeriodStart.Time),
			Date_2: database.Date(sub.CurrentPeriodEnd.Time),
		})
		if err != nil {
			return err
		}

		if usage.TotalAiRequests >= PlanLimits[sub.Plan] {
			return ErrAIRequestLimitExceeded
		}

		return q.IncrementDailyAIRequests(ctx, sqlc.IncrementDailyAIRequestsParams{
			UserID:     userID,
			Date:       database.Date(time.Now().UTC()),
			AiRequests: 1,
		})
	})
}

func (s *DashboardService) getActiveSubscription(ctx context.Context, q *sqlc.Queries, userID uuid.UUID, now time.Time) (sqlc.KukuSubscription, error) {
	sub, err := q.GetSubscriptionByUserIDForUpdate(ctx, userID)
	if err != nil {
		if err != pgx.ErrNoRows {
			return sqlc.KukuSubscription{}, err
		}
		sub, err = q.EnsureSubscriptionExists(ctx, userID)
		if err != nil {
			return sqlc.KukuSubscription{}, err
		}
	}

	sub, advanced := advanceSubscriptionPeriod(sub, now)
	if !advanced {
		return sub, nil
	}
	return q.UpdateSubscriptionPeriod(ctx, sqlc.UpdateSubscriptionPeriodParams{
		UserID:             userID,
		CurrentPeriodStart: sub.CurrentPeriodStart,
		CurrentPeriodEnd:   sub.CurrentPeriodEnd,
	})
}

func advanceSubscriptionPeriod(sub sqlc.KukuSubscription, now time.Time) (sqlc.KukuSubscription, bool) {
	now = now.UTC()
	start := sub.CurrentPeriodStart.Time
	end := sub.CurrentPeriodEnd.Time
	if !sub.CurrentPeriodStart.Valid || !sub.CurrentPeriodEnd.Valid || !end.After(start) {
		sub.CurrentPeriodStart = database.Timestamptz(now)
		sub.CurrentPeriodEnd = database.Timestamptz(now.AddDate(0, 0, subscriptionPeriodDay))
		return sub, true
	}
	if end.After(now) {
		return sub, false
	}
	for !end.After(now) {
		start = end
		end = end.AddDate(0, 0, subscriptionPeriodDay)
	}
	sub.CurrentPeriodStart = database.Timestamptz(start)
	sub.CurrentPeriodEnd = database.Timestamptz(end)
	return sub, true
}

func (s *DashboardService) RecordAITokens(ctx context.Context, userID uuid.UUID, totalTokens uint64) error {
	if totalTokens == 0 {
		return nil
	}
	if totalTokens > maxInt64 {
		return fmt.Errorf("total tokens exceeds int64: %d", totalTokens)
	}
	return s.queries.IncrementDailyAITokens(ctx, sqlc.IncrementDailyAITokensParams{
		UserID:      userID,
		UsageDate:   database.Date(time.Now().UTC()),
		TotalTokens: int64(totalTokens),
	})
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

func (s *DashboardService) withTx(ctx context.Context, fn func(*sqlc.Queries) error) error {
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
