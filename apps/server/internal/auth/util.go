package auth

import (
	"errors"
	"net"
	"net/http"
	"strings"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	errorv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/error/v1"
	userv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/user/v1"

	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
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
		Id:    proto.String(database.PgtypeToUUID(user.ID).String()),
		Email: proto.String(user.Email),
		Name:  proto.String(user.Name),
	}
}

func clientIPFromHeader(header http.Header) string {
	if value := header.Get("X-Forwarded-For"); value != "" {
		parts := strings.Split(value, ",")
		return strings.TrimSpace(parts[0])
	}
	if value := header.Get("X-Real-IP"); value != "" {
		return value
	}
	return ""
}

func clientIPFromRequest(r *http.Request) string {
	if value := clientIPFromHeader(r.Header); value != "" {
		return value
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
