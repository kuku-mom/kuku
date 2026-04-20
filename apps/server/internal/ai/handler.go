package ai

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"connectrpc.com/connect"

	aiv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/ai/v1"
	"github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/ai/v1/aiv1connect"

	"github.com/kuku-mom/kuku/apps/server/internal/auth"
	"github.com/kuku-mom/kuku/apps/server/internal/rpcerr"
)

type Handler struct {
	aiv1connect.UnimplementedAIServiceHandler
	service *Service
	log     *slog.Logger
}

func NewHandler(service *Service, log *slog.Logger) *Handler {
	return &Handler{service: service, log: log}
}

func (h *Handler) Complete(ctx context.Context, req *connect.Request[aiv1.CompleteRequest]) (*connect.Response[aiv1.CompleteResponse], error) {
	if _, _, err := auth.FromContext(ctx); err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}

	message := strings.TrimSpace(req.Msg.GetMessage())
	if message == "" && len(req.Msg.GetMessages()) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("message is required"))
	}

	output, err := h.service.Complete(ctx, CompleteInput{
		Mode:         req.Msg.GetMode(),
		Message:      message,
		ContextFiles: req.Msg.GetContextFiles(),
		Model:        req.Msg.GetModel(),
		Messages:     req.Msg.GetMessages(),
		Tools:        req.Msg.GetTools(),
		SystemPrompt: req.Msg.GetSystemPrompt(),
	})
	if err != nil {
		if errors.Is(err, ErrNotConfigured) {
			return nil, connect.NewError(connect.CodeFailedPrecondition, err)
		}
		return nil, rpcerr.Internal(ctx, h.log, "remote ai complete failed", err)
	}

	return connect.NewResponse(&aiv1.CompleteResponse{
		Text:         &output.Text,
		Usage:        output.Usage,
		ToolCalls:    output.ToolCalls,
		FinishReason: &output.FinishReason,
	}), nil
}
