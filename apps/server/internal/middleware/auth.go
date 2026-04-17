package middleware

import (
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/auth/v1/authv1connect"

	authpkg "github.com/kuku-mom/kuku/apps/server/internal/auth"
)

// publicPaths are routes the auth middleware allows to proceed without an
// authenticated context. Anything not in this set is rejected with 401 if
// auth fails — protected handlers no longer rely solely on
// `auth.FromContext` checks to enforce the boundary.
//
// When adding a new public endpoint (e.g. unauthenticated bootstrap RPCs,
// health checks, OAuth callbacks), append its exact path here.
var publicPaths = map[string]struct{}{
	"/health":               {},
	"/ready":                {},
	"/auth/callback/google": {},
	"/auth/callback/github": {},
	authv1connect.AuthServiceGoogleAuthURLProcedure:        {},
	authv1connect.AuthServiceGithubAuthURLProcedure:        {},
	authv1connect.AuthServiceDesktopAuthURLProcedure:       {},
	authv1connect.AuthServiceExchangeDesktopTokenProcedure: {},
	authv1connect.AuthServiceRefreshDesktopTokenProcedure:  {},
	authv1connect.AuthServiceEmailAuthProcedure:            {},
	authv1connect.AuthServiceEmailVerifyProcedure:          {},
	authv1connect.AuthServiceEmailResendProcedure:          {},
}

func isPublicPath(p string) bool {
	_, ok := publicPaths[p]
	return ok
}

// writeUnauthenticated emits a Connect-protocol-compatible 401 response so
// Connect clients surface it as `connect.CodeUnauthenticated` instead of an
// opaque transport error. Plain HTTP clients still see a 401 with a
// JSON body that's safe to ignore.
func writeUnauthenticated(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte(`{"code":"unauthenticated","message":"not authenticated"}`))
}

type authResponseWriter struct {
	http.ResponseWriter
	accessToken   string
	refreshToken  string
	secureCookie  bool
	headerWritten bool
}

func (w *authResponseWriter) WriteHeader(statusCode int) {
	w.applyCookies()
	w.ResponseWriter.WriteHeader(statusCode)
}

func (w *authResponseWriter) Write(body []byte) (int, error) {
	w.applyCookies()
	return w.ResponseWriter.Write(body)
}

func (w *authResponseWriter) Flush() {
	w.applyCookies()
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *authResponseWriter) applyCookies() {
	if w.headerWritten {
		return
	}
	w.headerWritten = true
	authpkg.AddAuthCookies(w.Header(), w.accessToken, w.refreshToken, w.secureCookie)
}

func Auth(authService *authpkg.AuthService, log *slog.Logger, secureCookie bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// `unauthenticated` consolidates the auth-failure exits below.
			// Public paths still proceed with no auth context (handlers
			// designed to be public ignore it); everything else gets 401
			// here, so a future protected handler that forgets to call
			// `auth.FromContext` still can't be hit anonymously.
			unauthenticated := func() {
				if isPublicPath(r.URL.Path) {
					next.ServeHTTP(w, r)
					return
				}
				writeUnauthenticated(w)
			}

			accessToken := getAccessToken(r)
			var claims *authpkg.Claims
			var err error
			refreshed := false
			var tokens *authpkg.TokenPair
			if accessToken != "" {
				claims, err = authService.ParseAccessToken(accessToken)
			} else {
				err = authpkg.ErrInvalidToken
			}
			if err != nil {
				refreshToken := getRefreshToken(r)
				if refreshToken == "" {
					unauthenticated()
					return
				}
				tokens, err = authService.RefreshTokens(r.Context(), refreshToken, clientIP(r), r.UserAgent())
				if err != nil {
					// Refresh-token failures are security-relevant: a valid
					// access token has already failed to parse and now the
					// refresh token is also invalid. Could be expiry
					// (benign) or a tampered/replayed token (suspicious).
					// Warn-level so it's visible without triggering on
					// every unauthenticated request.
					log.Warn("refresh token failed", "error", err, "ip", clientIP(r))
					unauthenticated()
					return
				}
				claims, err = authService.ParseAccessToken(tokens.AccessToken)
				if err != nil {
					unauthenticated()
					return
				}
				refreshed = true
			}

			userID, err := uuid.Parse(claims.Subject)
			if err != nil {
				unauthenticated()
				return
			}
			sessionID, err := uuid.Parse(claims.SessionID)
			if err != nil {
				unauthenticated()
				return
			}
			// TODO: every authenticated request hits the DB here.
			// When traffic justifies it, wrap with an LRU cache (sessionID
			// → validUntil, ~30s TTL) and evict explicitly from logout /
			// account-delete handlers.
			if err := authService.ValidateSession(r.Context(), sessionID); err != nil {
				// JWT signature was valid (we already parsed the claims) but
				// the session is missing/revoked in the database. Either a
				// race against logout or token reuse after sign-out. Warn
				// so it's auditable without burying it in debug noise.
				log.Warn("session validation failed", "error", err, "session_id", sessionID, "ip", clientIP(r))
				unauthenticated()
				return
			}

			ctx := authpkg.WithAuth(r.Context(), userID, sessionID)
			if refreshed {
				next.ServeHTTP(&authResponseWriter{
					ResponseWriter: w,
					accessToken:    tokens.AccessToken,
					refreshToken:   tokens.RefreshToken,
					secureCookie:   secureCookie,
				}, r.WithContext(ctx))
				return
			}
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func getAccessToken(r *http.Request) string {
	if cookie, err := r.Cookie(authpkg.AccessTokenName); err == nil && cookie.Value != "" {
		return cookie.Value
	}
	auth := r.Header.Get("Authorization")
	if after, ok := strings.CutPrefix(auth, "Bearer "); ok {
		return after
	}
	return ""
}

func getRefreshToken(r *http.Request) string {
	if cookie, err := r.Cookie(authpkg.RefreshTokenName); err == nil {
		return cookie.Value
	}
	return ""
}

func clientIP(r *http.Request) string {
	if value := r.Header.Get("X-Forwarded-For"); value != "" {
		parts := strings.Split(value, ",")
		return strings.TrimSpace(parts[0])
	}
	if value := r.Header.Get("X-Real-IP"); value != "" {
		return value
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
