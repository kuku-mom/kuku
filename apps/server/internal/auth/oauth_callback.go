package auth

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/kuku-mom/kuku/apps/server/internal/config"
)

type OAuthCallbackHandler struct {
	cfg    *config.Config
	auth   *AuthService
	log    *slog.Logger
	secure bool
}

func NewOAuthCallbackHandler(cfg *config.Config, auth *AuthService, log *slog.Logger, secure bool) *OAuthCallbackHandler {
	return &OAuthCallbackHandler{cfg: cfg, auth: auth, log: log, secure: secure}
}

func (h *OAuthCallbackHandler) GoogleCallback(w http.ResponseWriter, r *http.Request) {
	h.handle(w, r, "google")
}

func (h *OAuthCallbackHandler) GithubCallback(w http.ResponseWriter, r *http.Request) {
	h.handle(w, r, "github")
}

func (h *OAuthCallbackHandler) handle(w http.ResponseWriter, r *http.Request, provider string) {
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if code == "" || state == "" {
		h.redirectError(w, r, "missing_oauth_params")
		return
	}
	pair, err := h.auth.OAuthCallback(r.Context(), provider, code, state, clientIP(r.Context()), r.UserAgent())
	if err != nil {
		h.log.Error("oauth callback failed", "provider", provider, "error", err)
		h.redirectError(w, r, oauthErrorCode(err))
		return
	}
	AddAuthCookies(w.Header(), pair.AccessToken, pair.RefreshToken, h.secure)
	http.Redirect(w, r, h.cfg.ClientSuccessURL, http.StatusFound)
}

// oauthErrorCode classifies callback failures into stable codes the web app
// can render specific messages for. Anything not matched falls back to the
// generic "oauth_failed" so the user still sees an error page.
func oauthErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrNoVerifiedEmail):
		// User opted out of every email being public on their provider
		// account, or didn't grant the email scope. Web app should hint
		// at making an email public / re-running with the right scope
		// rather than blaming the auth code.
		return "no_verified_email"
	case errors.Is(err, ErrOAuthNotConfigured):
		return "oauth_not_configured"
	default:
		return "oauth_failed"
	}
}

func (h *OAuthCallbackHandler) redirectError(w http.ResponseWriter, r *http.Request, code string) {
	target := h.cfg.ClientErrorURL
	parsed, err := url.Parse(target)
	if err == nil {
		query := parsed.Query()
		query.Set("error", code)
		parsed.RawQuery = query.Encode()
		target = parsed.String()
	}
	http.Redirect(w, r, target, http.StatusFound)
}
