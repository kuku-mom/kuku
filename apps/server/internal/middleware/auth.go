package middleware

import (
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/google/uuid"

	authpkg "github.com/kuku-mom/kuku/apps/server/internal/auth"
)

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
					next.ServeHTTP(w, r)
					return
				}
				tokens, err = authService.RefreshTokens(r.Context(), refreshToken, clientIP(r), r.UserAgent())
				if err != nil {
					log.Debug("refresh token failed", "error", err)
					next.ServeHTTP(w, r)
					return
				}
				claims, err = authService.ParseAccessToken(tokens.AccessToken)
				if err != nil {
					next.ServeHTTP(w, r)
					return
				}
				refreshed = true
			}

			userID, err := uuid.Parse(claims.Subject)
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			sessionID, err := uuid.Parse(claims.SessionID)
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			if err := authService.ValidateSession(r.Context(), sessionID); err != nil {
				log.Debug("session validation failed", "error", err)
				next.ServeHTTP(w, r)
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
