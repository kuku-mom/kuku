package dashboard

import (
	"context"
	"errors"
	"log/slog"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	dashboardv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/dashboard/v1"
	"github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/dashboard/v1/dashboardv1connect"

	"github.com/kuku-mom/kuku/apps/server/internal/auth"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
	"github.com/kuku-mom/kuku/apps/server/internal/rpcerr"
)

type DashboardHandler struct {
	dashboardv1connect.UnimplementedDashboardServiceHandler
	dashboard *DashboardService
	log       *slog.Logger
}

func NewDashboardHandler(dashboard *DashboardService, log *slog.Logger) *DashboardHandler {
	return &DashboardHandler{dashboard: dashboard, log: log}
}

func (h *DashboardHandler) Subscription(ctx context.Context, req *connect.Request[dashboardv1.SubscriptionRequest]) (*connect.Response[dashboardv1.SubscriptionResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	sub, err := h.dashboard.GetSubscription(ctx, userID)
	if err != nil {
		return nil, rpcerr.Internal(ctx, h.log, "get subscription failed", err)
	}
	return connect.NewResponse(&dashboardv1.SubscriptionResponse{Subscription: subscriptionToProto(sub)}), nil
}

func (h *DashboardHandler) CurrentUsage(ctx context.Context, req *connect.Request[dashboardv1.CurrentUsageRequest]) (*connect.Response[dashboardv1.CurrentUsageResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	usage, err := h.dashboard.GetCurrentUsage(ctx, userID)
	if err != nil {
		return nil, rpcerr.Internal(ctx, h.log, "get current usage failed", err)
	}
	return connect.NewResponse(&dashboardv1.CurrentUsageResponse{
		AiRequestsUsed:  proto.Int32(usage.AIRequestsUsed),
		AiRequestsLimit: proto.Int32(usage.AIRequestsLimit),
	}), nil
}

func (h *DashboardHandler) UsageStats(ctx context.Context, req *connect.Request[dashboardv1.UsageStatsRequest]) (*connect.Response[dashboardv1.UsageStatsResponse], error) {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	days := int(req.Msg.GetDays())
	if days != 1 && days != 7 && days != 30 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("days must be 1, 7, or 30"))
	}
	stats, err := h.dashboard.GetUsageStats(ctx, userID, days)
	if err != nil {
		return nil, rpcerr.Internal(ctx, h.log, "get usage stats failed", err)
	}
	daily := make([]*dashboardv1.DailyUsage, 0, len(stats))
	for _, stat := range stats {
		daily = append(daily, &dashboardv1.DailyUsage{
			Date:       timestamppb.New(stat.Date.Time),
			AiRequests: proto.Int32(stat.AiRequests),
			TokensK:    proto.Float32(stat.TokensK),
		})
	}
	return connect.NewResponse(&dashboardv1.UsageStatsResponse{DailyUsage: daily}), nil
}

func subscriptionToProto(sub sqlc.KukuSubscription) *dashboardv1.Subscription {
	return &dashboardv1.Subscription{
		Plan:               planToProto(sub.Plan).Enum(),
		Status:             statusToProto(sub.Status).Enum(),
		CurrentPeriodStart: timestamppb.New(sub.CurrentPeriodStart.Time),
		CurrentPeriodEnd:   timestamppb.New(sub.CurrentPeriodEnd.Time),
		CancelAtPeriodEnd:  proto.Bool(sub.CancelAtPeriodEnd),
	}
}

func planToProto(plan sqlc.KukuPlan) dashboardv1.Plan {
	switch plan {
	case sqlc.KukuPlanFREE:
		return dashboardv1.Plan_PLAN_FREE
	case sqlc.KukuPlanPRO:
		return dashboardv1.Plan_PLAN_PRO
	case sqlc.KukuPlanULTRA:
		return dashboardv1.Plan_PLAN_ULTRA
	default:
		return dashboardv1.Plan_PLAN_UNSPECIFIED
	}
}

func statusToProto(status sqlc.KukuSubscriptionStatus) dashboardv1.SubscriptionStatus {
	switch status {
	case sqlc.KukuSubscriptionStatusACTIVE:
		return dashboardv1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE
	case sqlc.KukuSubscriptionStatusCANCELED:
		return dashboardv1.SubscriptionStatus_SUBSCRIPTION_STATUS_CANCELED
	default:
		return dashboardv1.SubscriptionStatus_SUBSCRIPTION_STATUS_UNSPECIFIED
	}
}
