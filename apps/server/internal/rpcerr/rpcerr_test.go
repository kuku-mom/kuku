package rpcerr

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/kuku-mom/kuku/apps/server/internal/requestctx"
)

func TestInternal_HidesRawErrorFromClient(t *testing.T) {
	t.Parallel()

	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	raw := errors.New("postgres: connection refused (secret hint)")

	err := Internal(context.Background(), log, "db call failed", raw)

	var ce *connect.Error
	if !errors.As(err, &ce) {
		t.Fatalf("expected connect.Error, got %T", err)
	}
	if ce.Code() != connect.CodeInternal {
		t.Fatalf("code: got %v, want Internal", ce.Code())
	}
	if strings.Contains(ce.Message(), "postgres") || strings.Contains(ce.Message(), "secret hint") {
		t.Fatalf("wire message leaked internal detail: %q", ce.Message())
	}
}

func TestInternal_LogsRequestIDAndRawError(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&buf, nil))
	ctx := requestctx.WithRequestID(context.Background(), "req-xyz")
	raw := errors.New("underlying failure")

	_ = Internal(ctx, log, "op failed", raw)

	out := buf.String()
	if !strings.Contains(out, "req-xyz") {
		t.Fatalf("log missing request_id: %s", out)
	}
	if !strings.Contains(out, "underlying failure") {
		t.Fatalf("log missing raw error: %s", out)
	}
	if !strings.Contains(out, "op failed") {
		t.Fatalf("log missing caller-supplied msg: %s", out)
	}
}
