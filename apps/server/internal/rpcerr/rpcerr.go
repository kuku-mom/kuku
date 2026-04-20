// Package rpcerr centralizes Connect-RPC error construction so handler
// code can't accidentally leak internal error text to clients.
//
// The convention: any "500-class" failure should go through
// `Internal(ctx, log, msg, err)`. The helper records the raw error in the
// server log (with request_id for correlation against the access log) and
// returns an opaque `connect.NewError(CodeInternal, ...)` that is safe to
// put on the wire — clients see "internal error" instead of
// connection strings, SQL fragments, or SDK internals.
package rpcerr

import (
	"context"
	"errors"
	"log/slog"

	"connectrpc.com/connect"

	"github.com/kuku-mom/kuku/apps/server/internal/requestctx"
)

// errInternal is the fixed message returned to clients. Intentionally
// bland so error text is never leveraged as a side channel for internal
// state. Use observability (request_id + logs) to triage, not the wire.
var errInternal = errors.New("internal error")

// Internal logs the original error with request correlation and returns a
// sanitized Connect error. Pass the handler's logger so the entry carries
// whatever scope (`slog.With`) the caller already attached.
func Internal(ctx context.Context, log *slog.Logger, msg string, err error) error {
	log.Error(msg, "error", err, "request_id", requestctx.RequestID(ctx))
	return connect.NewError(connect.CodeInternal, errInternal)
}
