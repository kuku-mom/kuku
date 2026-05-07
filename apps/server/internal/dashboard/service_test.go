package dashboard

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

func TestAdvanceSubscriptionPeriodRollsExpiredPeriodForward(t *testing.T) {
	now := time.Date(2026, time.May, 5, 12, 0, 0, 0, time.UTC)
	sub := sqlc.KukuSubscription{
		UserID:             uuid.New(),
		CurrentPeriodStart: database.Timestamptz(time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)),
		CurrentPeriodEnd:   database.Timestamptz(time.Date(2026, time.January, 31, 0, 0, 0, 0, time.UTC)),
	}

	got, advanced := advanceSubscriptionPeriod(sub, now)

	if !advanced {
		t.Fatal("advanceSubscriptionPeriod() advanced = false, want true")
	}
	if !got.CurrentPeriodStart.Time.Before(now) || !got.CurrentPeriodEnd.Time.After(now) {
		t.Fatalf("period = [%s, %s], want range containing %s", got.CurrentPeriodStart.Time, got.CurrentPeriodEnd.Time, now)
	}
}

func TestAdvanceSubscriptionPeriodKeepsActivePeriod(t *testing.T) {
	now := time.Date(2026, time.May, 5, 12, 0, 0, 0, time.UTC)
	sub := sqlc.KukuSubscription{
		UserID:             uuid.New(),
		CurrentPeriodStart: database.Timestamptz(time.Date(2026, time.April, 24, 0, 0, 0, 0, time.UTC)),
		CurrentPeriodEnd:   database.Timestamptz(time.Date(2026, time.May, 24, 0, 0, 0, 0, time.UTC)),
	}

	got, advanced := advanceSubscriptionPeriod(sub, now)

	if advanced {
		t.Fatal("advanceSubscriptionPeriod() advanced = true, want false")
	}
	if !got.CurrentPeriodStart.Time.Equal(sub.CurrentPeriodStart.Time) || !got.CurrentPeriodEnd.Time.Equal(sub.CurrentPeriodEnd.Time) {
		t.Fatalf("period changed from [%s, %s] to [%s, %s]", sub.CurrentPeriodStart.Time, sub.CurrentPeriodEnd.Time, got.CurrentPeriodStart.Time, got.CurrentPeriodEnd.Time)
	}
}
