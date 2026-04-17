package auth

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	errorv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/error/v1"
	userv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/user/v1"

	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
	"github.com/kuku-mom/kuku/apps/server/internal/requestctx"
)

func newBusinessError(code connect.Code, errorCode errorv1.ErrorCode, message string) *connect.Error {
	err := connect.NewError(code, errors.New(message))
	if detail, detailErr := connect.NewErrorDetail(&errorv1.ErrorDetail{
		Code:    errorCode.Enum(),
		Message: proto.String(message),
	}); detailErr == nil {
		err.AddDetail(detail)
	}
	return err
}

func sqlcUserToProto(user sqlc.AuthUser) *userv1.User {
	return &userv1.User{
		Id:    proto.String(user.ID.String()),
		Email: proto.String(user.Email),
		Name:  proto.String(user.Name),
	}
}

// clientIP returns the trusted client IP attached by `middleware.ClientIP`.
// Centralized in `requestctx` so handlers + audit logs + rate limiter all
// see the same trusted-proxy resolution and we avoid an auth↔middleware
// import cycle.
func clientIP(ctx context.Context) string {
	return requestctx.ClientIP(ctx)
}
