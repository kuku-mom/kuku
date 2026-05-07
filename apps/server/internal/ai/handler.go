package ai

import (
	"context"
	"errors"
	"iter"
	"log/slog"
	"strings"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	aiv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/ai/v1"
	"github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/ai/v1/aiv1connect"

	"github.com/kuku-mom/kuku/apps/server/internal/auth"
	"github.com/kuku-mom/kuku/apps/server/internal/dashboard"
	"github.com/kuku-mom/kuku/apps/server/internal/requestctx"
	"github.com/kuku-mom/kuku/apps/server/internal/rpcerr"
)

type usageReservoir interface {
	ReserveAIRequest(ctx context.Context, userID uuid.UUID) error
	RecordAITokens(ctx context.Context, userID uuid.UUID, totalTokens uint64) error
}

type completeStreamer interface {
	CompleteStream(ctx context.Context, input CompleteInput) iter.Seq2[*aiv1.CompleteResponse, error]
}

type Handler struct {
	aiv1connect.UnimplementedAIServiceHandler
	service completeStreamer
	usage   usageReservoir
	log     *slog.Logger
}

func NewHandler(service completeStreamer, usage usageReservoir, log *slog.Logger) *Handler {
	return &Handler{service: service, usage: usage, log: log}
}

// Complete forwards CompleteResponse events from the service's streaming
// iterator to the Connect server stream. The stream closes naturally on
// the terminal FinishedEvent; tool-call rounds are driven client-side by
// issuing a follow-up Complete with tool_result messages appended.
func (h *Handler) Complete(
	ctx context.Context,
	req *connect.Request[aiv1.CompleteRequest],
	stream *connect.ServerStream[aiv1.CompleteResponse],
) error {
	userID, _, err := auth.FromContext(ctx)
	if err != nil {
		return connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}

	message := strings.TrimSpace(req.Msg.GetMessage())
	if message == "" && len(req.Msg.GetMessages()) == 0 {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("message is required"))
	}
	input := CompleteInput{
		Mode:         req.Msg.GetMode(),
		Message:      message,
		ContextFiles: req.Msg.GetContextFiles(),
		Model:        req.Msg.GetModel(),
		Messages:     req.Msg.GetMessages(),
		Tools:        req.Msg.GetTools(),
		SystemPrompt: req.Msg.GetSystemPrompt(),
	}
	if err := validateCompleteInput(input); err != nil {
		return connect.NewError(connect.CodeInvalidArgument, err)
	}
	if h.usage == nil {
		return rpcerr.Internal(ctx, h.log, "remote ai usage tracker missing", errors.New("usage tracker is not configured"))
	}
	if err := h.usage.ReserveAIRequest(ctx, userID); err != nil {
		if errors.Is(err, dashboard.ErrAIRequestLimitExceeded) {
			return connect.NewError(connect.CodeResourceExhausted, err)
		}
		return rpcerr.Internal(ctx, h.log, "reserve ai usage failed", err)
	}

	var totalTokens uint64
	for event, err := range h.service.CompleteStream(ctx, input) {
		if err != nil {
			if errors.Is(err, ErrNotConfigured) {
				return connect.NewError(connect.CodeFailedPrecondition, err)
			}
			return rpcerr.Internal(ctx, h.log, "remote ai complete failed", err)
		}
		totalTokens = max(totalTokens, totalTokensFromCompleteResponse(event))
		if err := stream.Send(event); err != nil {
			return err
		}
	}
	if totalTokens > 0 {
		if err := h.usage.RecordAITokens(ctx, userID, totalTokens); err != nil && h.log != nil {
			h.log.Error("record ai token usage failed", "error", err, "user_id", userID, "request_id", requestctx.RequestID(ctx))
		}
	}
	return nil
}

func validateCompleteInput(input CompleteInput) error {
	if _, err := buildContents(input); err != nil {
		return err
	}
	if _, err := buildConfig(input); err != nil {
		return err
	}
	return nil
}

func totalTokensFromCompleteResponse(response *aiv1.CompleteResponse) uint64 {
	if response == nil || response.GetFinished() == nil {
		return 0
	}
	usage := response.GetFinished().GetUsage()
	if usage == nil {
		return 0
	}
	if totalTokens := usage.GetTotalTokens(); totalTokens > 0 {
		return totalTokens
	}
	return usage.GetInputTokens() + usage.GetOutputTokens()
}
