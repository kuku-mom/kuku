package ai

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	aiv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/ai/v1"

	"github.com/kuku-mom/kuku/apps/server/internal/auth"
	"github.com/kuku-mom/kuku/apps/server/internal/dashboard"
)

type fakeUsageReservoir struct {
	calls     int
	err       error
	tokenErr  error
	tokenLogs []uint64
}

func (f *fakeUsageReservoir) ReserveAIRequest(context.Context, uuid.UUID) error {
	f.calls++
	return f.err
}

func (f *fakeUsageReservoir) RecordAITokens(_ context.Context, _ uuid.UUID, totalTokens uint64) error {
	f.tokenLogs = append(f.tokenLogs, totalTokens)
	return f.tokenErr
}

func TestCompleteRejectsWhenAIRequestLimitExceeded(t *testing.T) {
	usage := &fakeUsageReservoir{err: dashboard.ErrAIRequestLimitExceeded}
	handler := NewHandler(nil, usage, nil)
	ctx := auth.WithAuth(context.Background(), uuid.New(), uuid.New())

	err := handler.Complete(
		ctx,
		connect.NewRequest(&aiv1.CompleteRequest{Message: proto.String("hello")}),
		nil,
	)

	if connect.CodeOf(err) != connect.CodeResourceExhausted {
		t.Fatalf("Complete() code = %v, want %v; err=%v", connect.CodeOf(err), connect.CodeResourceExhausted, err)
	}
	if usage.calls != 1 {
		t.Fatalf("ReserveAIRequest calls = %d, want 1", usage.calls)
	}
}

func TestCompleteDoesNotReserveUsageForInvalidPrompt(t *testing.T) {
	usage := &fakeUsageReservoir{err: errors.New("should not be called")}
	handler := NewHandler(nil, usage, nil)
	ctx := auth.WithAuth(context.Background(), uuid.New(), uuid.New())

	err := handler.Complete(ctx, connect.NewRequest(&aiv1.CompleteRequest{}), nil)

	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("Complete() code = %v, want %v; err=%v", connect.CodeOf(err), connect.CodeInvalidArgument, err)
	}
	if usage.calls != 0 {
		t.Fatalf("ReserveAIRequest calls = %d, want 0", usage.calls)
	}
}

func TestCompleteDoesNotReserveUsageForInvalidChatHistory(t *testing.T) {
	usage := &fakeUsageReservoir{err: errors.New("should not be called")}
	handler := NewHandler(nil, usage, nil)
	ctx := auth.WithAuth(context.Background(), uuid.New(), uuid.New())

	err := handler.Complete(ctx, connect.NewRequest(&aiv1.CompleteRequest{
		Messages: []*aiv1.ChatMessage{{
			Role: aiv1.ChatMessageRole_CHAT_MESSAGE_ROLE_USER.Enum(),
		}},
	}), nil)

	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("Complete() code = %v, want %v; err=%v", connect.CodeOf(err), connect.CodeInvalidArgument, err)
	}
	if usage.calls != 0 {
		t.Fatalf("ReserveAIRequest calls = %d, want 0", usage.calls)
	}
}

func TestTotalTokensFromCompleteResponse(t *testing.T) {
	response := &aiv1.CompleteResponse{
		Event: &aiv1.CompleteResponse_Finished{
			Finished: &aiv1.FinishedEvent{
				Usage: &aiv1.TokenUsage{
					InputTokens:  proto.Uint64(11),
					OutputTokens: proto.Uint64(7),
					TotalTokens:  proto.Uint64(18),
				},
			},
		},
	}

	if got := totalTokensFromCompleteResponse(response); got != 18 {
		t.Fatalf("totalTokensFromCompleteResponse() = %d, want 18", got)
	}
}

func TestTotalTokensFromCompleteResponseFallsBackToInputAndOutput(t *testing.T) {
	response := &aiv1.CompleteResponse{
		Event: &aiv1.CompleteResponse_Finished{
			Finished: &aiv1.FinishedEvent{
				Usage: &aiv1.TokenUsage{
					InputTokens:  proto.Uint64(11),
					OutputTokens: proto.Uint64(7),
				},
			},
		},
	}

	if got := totalTokensFromCompleteResponse(response); got != 18 {
		t.Fatalf("totalTokensFromCompleteResponse() = %d, want 18", got)
	}
}
