package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	authv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/auth/v1"
	"github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/auth/v1/authv1connect"
	errorv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/error/v1"
)

type AuthHandler struct {
	authv1connect.UnimplementedAuthServiceHandler
	authService *AuthService
	log         *slog.Logger
	secure      bool
}

func NewAuthHandler(authService *AuthService, log *slog.Logger, secure bool) *AuthHandler {
	return &AuthHandler{authService: authService, log: log, secure: secure}
}

func (h *AuthHandler) GoogleAuthURL(ctx context.Context, req *connect.Request[authv1.GoogleAuthURLRequest]) (*connect.Response[authv1.GoogleAuthURLResponse], error) {
	url, err := h.authService.GoogleAuthURL(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&authv1.GoogleAuthURLResponse{AuthUrl: proto.String(url)}), nil
}

func (h *AuthHandler) GithubAuthURL(ctx context.Context, req *connect.Request[authv1.GithubAuthURLRequest]) (*connect.Response[authv1.GithubAuthURLResponse], error) {
	url, err := h.authService.GithubAuthURL(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&authv1.GithubAuthURLResponse{AuthUrl: proto.String(url)}), nil
}

func (h *AuthHandler) DesktopAuthURL(ctx context.Context, req *connect.Request[authv1.DesktopAuthURLRequest]) (*connect.Response[authv1.DesktopAuthURLResponse], error) {
	url, err := h.authService.DesktopAuthURL(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&authv1.DesktopAuthURLResponse{AuthUrl: proto.String(url)}), nil
}

func (h *AuthHandler) ExchangeDesktopToken(ctx context.Context, req *connect.Request[authv1.ExchangeDesktopTokenRequest]) (*connect.Response[authv1.ExchangeDesktopTokenResponse], error) {
	token := strings.TrimSpace(req.Msg.GetToken())
	state := strings.TrimSpace(req.Msg.GetState())
	if token == "" || state == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("token and state are required"))
	}
	pair, err := h.authService.ExchangeDesktopToken(ctx, token, state, clientIPFromHeader(req.Header()), req.Header().Get("User-Agent"))
	if err != nil {
		return nil, authServiceError(err)
	}
	return connect.NewResponse(&authv1.ExchangeDesktopTokenResponse{
		AccessToken:  proto.String(pair.AccessToken),
		RefreshToken: proto.String(pair.RefreshToken),
		ExpiresIn:    proto.Int64(pair.ExpiresIn),
	}), nil
}

func (h *AuthHandler) CreateDesktopToken(ctx context.Context, req *connect.Request[authv1.CreateDesktopTokenRequest]) (*connect.Response[authv1.CreateDesktopTokenResponse], error) {
	userID, _, err := FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	state := strings.TrimSpace(req.Msg.GetState())
	if state == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("state is required"))
	}
	token, err := h.authService.CreateDesktopToken(ctx, userID, state)
	if err != nil {
		return nil, authServiceError(err)
	}
	return connect.NewResponse(&authv1.CreateDesktopTokenResponse{Token: proto.String(token)}), nil
}

func (h *AuthHandler) EmailAuth(ctx context.Context, req *connect.Request[authv1.EmailAuthRequest]) (*connect.Response[authv1.EmailAuthResponse], error) {
	email := strings.TrimSpace(req.Msg.GetEmail())
	if email == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("email is required"))
	}
	flow, err := h.authService.EmailAuth(ctx, email, clientIPFromHeader(req.Header()), req.Header().Get("User-Agent"))
	if err != nil {
		return nil, authServiceError(err)
	}
	resp := connect.NewResponse(&authv1.EmailAuthResponse{})
	AddEmailFlowCookie(resp.Header(), flow, h.secure)
	return resp, nil
}

func (h *AuthHandler) EmailVerify(ctx context.Context, req *connect.Request[authv1.EmailVerifyRequest]) (*connect.Response[authv1.EmailVerifyResponse], error) {
	code := strings.TrimSpace(req.Msg.GetCode())
	if len(code) != 6 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("code must be 6 digits"))
	}
	pair, err := h.authService.EmailVerify(ctx, code, clientIPFromHeader(req.Header()), req.Header().Get("User-Agent"))
	if err != nil {
		return nil, authServiceError(err)
	}
	resp := connect.NewResponse(&authv1.EmailVerifyResponse{})
	AddAuthCookies(resp.Header(), pair.AccessToken, pair.RefreshToken, h.secure)
	AddClearEmailFlowCookie(resp.Header(), h.secure)
	return resp, nil
}

func (h *AuthHandler) EmailResend(ctx context.Context, req *connect.Request[authv1.EmailResendRequest]) (*connect.Response[authv1.EmailResendResponse], error) {
	flow := emailFlowFromHeader(req.Header())
	if flow == "" {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("no pending email authentication"))
	}
	newFlow, err := h.authService.EmailResend(ctx, flow, clientIPFromHeader(req.Header()), req.Header().Get("User-Agent"))
	if err != nil {
		return nil, authServiceError(err)
	}
	resp := connect.NewResponse(&authv1.EmailResendResponse{})
	AddEmailFlowCookie(resp.Header(), newFlow, h.secure)
	return resp, nil
}

func (h *AuthHandler) SignOut(ctx context.Context, req *connect.Request[authv1.SignOutRequest]) (*connect.Response[authv1.SignOutResponse], error) {
	userID, sessionID, err := FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	if err := h.authService.SignOut(ctx, userID, sessionID, clientIPFromHeader(req.Header()), req.Header().Get("User-Agent")); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	resp := connect.NewResponse(&authv1.SignOutResponse{})
	AddClearAuthCookies(resp.Header(), h.secure)
	return resp, nil
}

func (h *AuthHandler) Profile(ctx context.Context, req *connect.Request[authv1.ProfileRequest]) (*connect.Response[authv1.ProfileResponse], error) {
	userID, _, err := FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	user, err := h.authService.GetProfile(ctx, userID)
	if err != nil {
		return nil, authServiceError(err)
	}
	return connect.NewResponse(&authv1.ProfileResponse{User: sqlcUserToProto(user)}), nil
}

func (h *AuthHandler) ProfileUpdate(ctx context.Context, req *connect.Request[authv1.ProfileUpdateRequest]) (*connect.Response[authv1.ProfileUpdateResponse], error) {
	userID, _, err := FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	name := strings.TrimSpace(req.Msg.GetName())
	if name == "" || len(name) > 100 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name must be between 1 and 100 characters"))
	}
	user, err := h.authService.UpdateProfile(ctx, userID, name, clientIPFromHeader(req.Header()), req.Header().Get("User-Agent"))
	if err != nil {
		return nil, authServiceError(err)
	}
	return connect.NewResponse(&authv1.ProfileUpdateResponse{User: sqlcUserToProto(user)}), nil
}

func (h *AuthHandler) AccountDelete(ctx context.Context, req *connect.Request[authv1.AccountDeleteRequest]) (*connect.Response[authv1.AccountDeleteResponse], error) {
	userID, _, err := FromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("not authenticated"))
	}
	if err := h.authService.DeleteAccount(ctx, userID, clientIPFromHeader(req.Header()), req.Header().Get("User-Agent")); err != nil {
		return nil, authServiceError(err)
	}
	resp := connect.NewResponse(&authv1.AccountDeleteResponse{})
	AddClearAuthCookies(resp.Header(), h.secure)
	return resp, nil
}

func authServiceError(err error) error {
	switch {
	case errors.Is(err, ErrInvalidCode):
		return newBusinessError(connect.CodeInvalidArgument, errorv1.ErrorCode_ERROR_CODE_INVALID_CODE, "invalid code")
	case errors.Is(err, ErrCodeExpired), errors.Is(err, ErrFlowStateExpired):
		return newBusinessError(connect.CodeInvalidArgument, errorv1.ErrorCode_ERROR_CODE_CODE_EXPIRED, "code expired")
	case errors.Is(err, ErrUserNotFound):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, ErrOAuthNotConfigured):
		return connect.NewError(connect.CodeFailedPrecondition, err)
	default:
		return connect.NewError(connect.CodeInternal, err)
	}
}

func emailFlowFromHeader(header http.Header) string {
	req := http.Request{Header: header}
	if cookie, err := req.Cookie(EmailAuthFlowName); err == nil {
		return cookie.Value
	}
	return ""
}
