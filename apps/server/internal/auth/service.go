package auth

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kuku-mom/kuku/apps/server/internal/config"
	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/kuku-mom/kuku/apps/server/internal/database/sqlc"
)

var (
	ErrUserNotFound       = errors.New("user not found")
	ErrSessionNotFound    = errors.New("session not found")
	ErrInvalidCode        = errors.New("invalid code")
	ErrCodeExpired        = errors.New("code expired")
	ErrInvalidToken       = errors.New("invalid token")
	ErrTokenExpired       = errors.New("token expired")
	ErrFlowStateExpired   = errors.New("flow state expired")
	ErrOAuthNotConfigured = errors.New("oauth provider is not configured")
	// ErrNoVerifiedEmail signals that an OAuth provider returned a profile
	// without a usable email address. With GitHub this happens when the
	// user keeps every email private and we can't fall back through
	// `/user/emails` (no `user:email` scope, no verified primary, etc).
	// Distinct from `ErrInvalidCode` so the callback handler can surface
	// an actionable message instead of "invalid code".
	ErrNoVerifiedEmail = errors.New("oauth provider returned no verified email")
)

const (
	otpExpiry            = 10 * time.Minute
	flowExpiry           = 10 * time.Minute
	webAccessExpiry      = 15 * time.Minute
	webRefreshExpiry     = 30 * 24 * time.Hour
	desktopAccessExpiry  = time.Hour
	desktopRefreshExpiry = 90 * 24 * time.Hour
)

type AuthService struct {
	cfg     *config.Config
	pool    *pgxpool.Pool
	queries *sqlc.Queries
	email   EmailSender
	log     *slog.Logger
	client  *http.Client
}

type Claims struct {
	jwt.RegisteredClaims
	SessionID string `json:"sid"`
	Email     string `json:"email"`
}

type TokenPair struct {
	AccessToken  string
	RefreshToken string
	ExpiresIn    int64
}

func NewAuthService(cfg *config.Config, pool *pgxpool.Pool, queries *sqlc.Queries, email EmailSender, log *slog.Logger) *AuthService {
	return &AuthService{
		cfg:     cfg,
		pool:    pool,
		queries: queries,
		email:   email,
		log:     log,
		client:  &http.Client{Timeout: 15 * time.Second},
	}
}

// withTx runs `fn` inside a database transaction. The closure receives a
// `*sqlc.Queries` bound to the tx so all writes share the same atomic unit.
// We commit on a nil return and roll back on any error or panic — the
// `defer` rollback is a no-op once the commit has succeeded, so this stays
// safe under either path.
func (s *AuthService) withTx(ctx context.Context, fn func(*sqlc.Queries) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()
	if err := fn(s.queries.WithTx(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}

func (s *AuthService) GoogleAuthURL(ctx context.Context) (string, error) {
	state, err := s.createFlowState(ctx, "google", "oauth", "", uuid.Nil, "")
	if err != nil {
		return "", err
	}
	values := url.Values{
		"client_id":     {s.cfg.GoogleClientID},
		"redirect_uri":  {s.cfg.GoogleRedirectURL},
		"response_type": {"code"},
		"scope":         {"openid email profile"},
		"state":         {state},
	}
	return "https://accounts.google.com/o/oauth2/v2/auth?" + values.Encode(), nil
}

func (s *AuthService) GithubAuthURL(ctx context.Context) (string, error) {
	state, err := s.createFlowState(ctx, "github", "oauth", "", uuid.Nil, "")
	if err != nil {
		return "", err
	}
	values := url.Values{
		"client_id":    {s.cfg.GitHubClientID},
		"redirect_uri": {s.cfg.GitHubRedirectURL},
		"scope":        {"user:email"},
		"state":        {state},
	}
	return "https://github.com/login/oauth/authorize?" + values.Encode(), nil
}

func (s *AuthService) DesktopAuthURL(ctx context.Context) (string, error) {
	state, err := s.createFlowState(ctx, "desktop", "desktop_auth", "", uuid.Nil, "")
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s/auth/desktop?state=%s", strings.TrimRight(s.cfg.ClientWebURL, "/"), url.QueryEscape(state)), nil
}

func (s *AuthService) EmailAuth(ctx context.Context, email, ipAddress, userAgent string) (string, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	if email == "" || !strings.Contains(email, "@") {
		return "", ErrInvalidCode
	}

	code, err := generateOTP()
	if err != nil {
		return "", err
	}
	flow, err := s.createFlowState(ctx, "email", "email_auth", email, uuid.Nil, "")
	if err != nil {
		return "", err
	}

	user, userErr := s.queries.GetUserByEmail(ctx, email)
	var userID uuid.NullUUID
	if userErr == nil {
		userID = uuid.NullUUID{UUID: user.ID, Valid: true}
	} else if !errors.Is(userErr, pgx.ErrNoRows) {
		return "", userErr
	}

	if err := s.queries.InvalidateOneTimeTokensByEmail(ctx, sqlc.InvalidateOneTimeTokensByEmailParams{
		Email:     email,
		TokenType: sqlc.AuthOneTimeTokenTypeEmailAuth,
	}); err != nil {
		return "", err
	}
	if _, err := s.queries.CreateOneTimeToken(ctx, sqlc.CreateOneTimeTokenParams{
		UserID:    userID,
		Email:     email,
		TokenType: sqlc.AuthOneTimeTokenTypeEmailAuth,
		TokenHash: hashToken(code),
		ExpiresAt: database.Timestamptz(time.Now().Add(otpExpiry)),
	}); err != nil {
		return "", err
	}
	if err := s.email.SendAuthCode(ctx, email, code); err != nil {
		return "", err
	}
	_ = s.logAuthEvent(ctx, userID.UUID, email, sqlc.AuditLogAuthActionEmailOtpRequested, nil, ipAddress, userAgent)
	return flow, nil
}

func (s *AuthService) EmailResend(ctx context.Context, flow, ipAddress, userAgent string) (string, error) {
	state, err := s.queries.GetFlowStateByCode(ctx, flow)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrFlowStateExpired
		}
		return "", err
	}
	if state.AuthenticationMethod != "email_auth" || !state.Email.Valid {
		return "", ErrInvalidCode
	}
	return s.EmailAuth(ctx, state.Email.String, ipAddress, userAgent)
}

func (s *AuthService) EmailVerify(ctx context.Context, code, ipAddress, userAgent string) (*TokenPair, error) {
	// Atomic consume-and-return: only the first concurrent caller for a given
	// code wins the row lock and gets a row back; everyone else (including
	// retries against an already-consumed code) gets pgx.ErrNoRows. This
	// fuses the prior SELECT + UPDATE pair to close the TOCTOU window.
	// Expiry is enforced inside the WHERE clause, so a stale code surfaces
	// the same way as wrong/used — `ErrInvalidCode`.
	token, err := s.queries.ConsumeOneTimeToken(ctx, hashToken(code))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrInvalidCode
		}
		return nil, err
	}

	user, isNew, err := s.getOrCreateEmailUser(ctx, token.Email, token.UserID)
	if err != nil {
		return nil, err
	}
	userID := user.ID
	_ = s.queries.UpdateUserLastSignIn(ctx, user.ID)
	if isNew {
		_ = s.logAuthEvent(ctx, userID, user.Email, sqlc.AuditLogAuthActionSignup, map[string]any{"method": "email"}, ipAddress, userAgent)
	}
	_ = s.logAuthEvent(ctx, userID, user.Email, sqlc.AuditLogAuthActionEmailOtpVerified, nil, ipAddress, userAgent)
	_ = s.logAuthEvent(ctx, userID, user.Email, sqlc.AuditLogAuthActionLogin, map[string]any{"method": "email"}, ipAddress, userAgent)

	return s.createSessionAndTokens(ctx, user, userAgent, ipAddress, webAccessExpiry, webRefreshExpiry)
}

func (s *AuthService) CreateDesktopToken(ctx context.Context, userID uuid.UUID, state string) (string, error) {
	if _, err := s.queries.GetFlowStateByCode(ctx, state); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrFlowStateExpired
		}
		return "", err
	}
	user, err := s.queries.GetUserByID(ctx, userID)
	if err != nil {
		return "", err
	}
	token := generateSecureToken(32)
	if _, err := s.queries.CreateOneTimeToken(ctx, sqlc.CreateOneTimeTokenParams{
		UserID:    uuid.NullUUID{UUID: user.ID, Valid: true},
		Email:     user.Email,
		TokenType: sqlc.AuthOneTimeTokenTypeDesktopAuth,
		TokenHash: hashToken(token),
		ExpiresAt: database.Timestamptz(time.Now().Add(otpExpiry)),
	}); err != nil {
		return "", err
	}
	return token, nil
}

func (s *AuthService) ExchangeDesktopToken(ctx context.Context, token, state, ipAddress, userAgent string) (*TokenPair, error) {
	if _, err := s.queries.GetFlowStateByCode(ctx, state); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrFlowStateExpired
		}
		return nil, err
	}
	// Atomic consume — see EmailVerify for the TOCTOU rationale.
	oneTime, err := s.queries.ConsumeOneTimeToken(ctx, hashToken(token))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrInvalidCode
		}
		return nil, err
	}
	if oneTime.TokenType != sqlc.AuthOneTimeTokenTypeDesktopAuth {
		return nil, ErrInvalidCode
	}
	if !oneTime.UserID.Valid {
		return nil, ErrInvalidCode
	}
	user, err := s.queries.GetUserByID(ctx, oneTime.UserID.UUID)
	if err != nil {
		return nil, err
	}
	_ = s.queries.UpdateUserLastSignIn(ctx, user.ID)
	_ = s.logAuthEvent(ctx, user.ID, user.Email, sqlc.AuditLogAuthActionLogin, map[string]any{"method": "desktop"}, ipAddress, userAgent)
	return s.createSessionAndTokens(ctx, user, userAgent, ipAddress, desktopAccessExpiry, desktopRefreshExpiry)
}

func (s *AuthService) SignOut(ctx context.Context, userID, sessionID uuid.UUID, ipAddress, userAgent string) error {
	// Wrap both revocations in one tx so a mid-failure can't leave the
	// session row alive after its refresh tokens are gone — that state lets
	// the holder of the existing access token keep working past logout.
	if err := s.withTx(ctx, func(q *sqlc.Queries) error {
		if err := q.RevokeSessionRefreshTokens(ctx, sessionID); err != nil {
			return err
		}
		return q.RevokeSession(ctx, sessionID)
	}); err != nil {
		return err
	}
	_ = s.logAuthEvent(ctx, userID, "", sqlc.AuditLogAuthActionLogout, nil, ipAddress, userAgent)
	return nil
}

func (s *AuthService) GetProfile(ctx context.Context, userID uuid.UUID) (sqlc.AuthUser, error) {
	user, err := s.queries.GetUserByID(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.AuthUser{}, ErrUserNotFound
	}
	return user, err
}

func (s *AuthService) UpdateProfile(ctx context.Context, userID uuid.UUID, name, ipAddress, userAgent string) (sqlc.AuthUser, error) {
	user, err := s.queries.UpdateUserName(ctx, sqlc.UpdateUserNameParams{
		ID:   userID,
		Name: strings.TrimSpace(name),
	})
	if err == nil {
		_ = s.logAuthEvent(ctx, userID, user.Email, sqlc.AuditLogAuthActionUserModified, nil, ipAddress, userAgent)
	}
	return user, err
}

func (s *AuthService) DeleteAccount(ctx context.Context, userID uuid.UUID, ipAddress, userAgent string) error {
	// Best-effort fetch — used only to enrich the audit log entry below
	// with the user's email at deletion time. A failure here means the
	// audit entry will lack the email but the deletion still proceeds; we
	// log so the gap is traceable rather than silent.
	user, err := s.queries.GetUserByID(ctx, userID)
	if err != nil {
		s.log.Warn("delete account: failed to load user for audit log", "user_id", userID, "error", err)
	}
	// Three-step deletion in one tx: a mid-failure used to leave the user
	// soft-deleted-or-not in arbitrary combination with revoked sessions,
	// stranding accounts that couldn't log in but also couldn't retry the
	// delete cleanly.
	if err := s.withTx(ctx, func(q *sqlc.Queries) error {
		if err := q.MarkSyncObjectsDeletedByOwner(ctx, userID); err != nil {
			return err
		}
		if err := q.RevokeSyncDevicesByOwner(ctx, userID); err != nil {
			return err
		}
		if err := q.SoftDeleteSyncWorkspacesByOwner(ctx, userID); err != nil {
			return err
		}
		if err := q.ResetSyncUsageWorkspacesByOwner(ctx, userID); err != nil {
			return err
		}
		if err := q.ResetSyncUsageAccount(ctx, userID); err != nil {
			return err
		}
		if err := q.RevokeAllUserRefreshTokens(ctx, userID); err != nil {
			return err
		}
		if err := q.RevokeAllUserSessions(ctx, userID); err != nil {
			return err
		}
		return q.SoftDeleteUser(ctx, userID)
	}); err != nil {
		return err
	}
	_ = s.logAuthEvent(ctx, userID, user.Email, sqlc.AuditLogAuthActionUserDeleted, nil, ipAddress, userAgent)
	return nil
}

func (s *AuthService) ValidateSession(ctx context.Context, sessionID uuid.UUID) error {
	_, err := s.queries.GetValidSession(ctx, sqlc.GetValidSessionParams{
		ID:                sessionID,
		InactivityTimeout: database.Interval(s.cfg.SessionInactivity),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSessionNotFound
	}
	if err != nil {
		return err
	}
	return s.queries.UpdateSessionRefreshedAt(ctx, sessionID)
}

func (s *AuthService) ParseAccessToken(tokenString string) (*Claims, error) {
	claims := &Claims{}
	token, err := jwt.ParseWithClaims(tokenString, claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, ErrInvalidToken
		}
		return []byte(s.cfg.JWTSecret), nil
	})
	if err != nil || !token.Valid {
		return nil, ErrInvalidToken
	}
	return claims, nil
}

func (s *AuthService) RefreshTokens(ctx context.Context, refreshToken, ipAddress, userAgent string) (*TokenPair, error) {
	return s.refreshTokens(ctx, refreshToken, ipAddress, userAgent, webAccessExpiry, webRefreshExpiry)
}

func (s *AuthService) RefreshDesktopTokens(ctx context.Context, refreshToken, ipAddress, userAgent string) (*TokenPair, error) {
	return s.refreshTokens(ctx, refreshToken, ipAddress, userAgent, desktopAccessExpiry, desktopRefreshExpiry)
}

func (s *AuthService) refreshTokens(ctx context.Context, refreshToken, ipAddress, userAgent string, accessTTL, refreshTTL time.Duration) (*TokenPair, error) {
	var user sqlc.AuthUser
	var pair *TokenPair
	if err := s.withTx(ctx, func(q *sqlc.Queries) error {
		row, err := q.ConsumeRefreshTokenByHash(ctx, sqlc.ConsumeRefreshTokenByHashParams{
			TokenHash:         hashToken(refreshToken),
			InactivityTimeout: database.Interval(s.cfg.SessionInactivity),
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrInvalidToken
			}
			return err
		}

		user, err = q.GetUserByID(ctx, row.UserID)
		if err != nil {
			return err
		}
		if err := q.UpdateSessionRefreshedAt(ctx, row.SessionID); err != nil {
			return err
		}
		pair, err = s.createTokensWithQueries(ctx, q, user, row.SessionID, accessTTL, refreshTTL)
		return err
	}); err != nil {
		return nil, err
	}
	_ = s.logAuthEvent(ctx, user.ID, user.Email, sqlc.AuditLogAuthActionTokenRefreshed, nil, ipAddress, userAgent)
	return pair, nil
}

func (s *AuthService) OAuthCallback(ctx context.Context, provider, code, state, ipAddress, userAgent string) (*TokenPair, error) {
	flow, err := s.queries.GetFlowStateByCode(ctx, state)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrFlowStateExpired
		}
		return nil, err
	}
	if flow.ProviderType != provider || flow.AuthenticationMethod != "oauth" {
		return nil, ErrInvalidCode
	}

	profile, err := s.fetchOAuthProfile(ctx, provider, code)
	if err != nil {
		return nil, err
	}
	user, isNew, err := s.getOrCreateOAuthUser(ctx, provider, profile)
	if err != nil {
		return nil, err
	}
	_ = s.queries.DeleteFlowState(ctx, flow.ID)
	_ = s.queries.UpdateUserLastSignIn(ctx, user.ID)
	userID := user.ID
	if isNew {
		_ = s.logAuthEvent(ctx, userID, user.Email, sqlc.AuditLogAuthActionSignup, map[string]any{"method": provider}, ipAddress, userAgent)
	}
	_ = s.logAuthEvent(ctx, userID, user.Email, sqlc.AuditLogAuthActionLogin, map[string]any{"method": provider}, ipAddress, userAgent)
	return s.createSessionAndTokens(ctx, user, userAgent, ipAddress, webAccessExpiry, webRefreshExpiry)
}

type oauthProfile struct {
	ProviderID string
	Email      string
	Name       string
	Raw        []byte
}

func (s *AuthService) fetchOAuthProfile(ctx context.Context, provider, code string) (oauthProfile, error) {
	switch provider {
	case "google":
		if s.cfg.GoogleClientID == "" || s.cfg.GoogleClientSecret == "" {
			return oauthProfile{}, ErrOAuthNotConfigured
		}
		token, err := s.exchangeForm(ctx, "https://oauth2.googleapis.com/token", url.Values{
			"client_id":     {s.cfg.GoogleClientID},
			"client_secret": {s.cfg.GoogleClientSecret},
			"redirect_uri":  {s.cfg.GoogleRedirectURL},
			"grant_type":    {"authorization_code"},
			"code":          {code},
		})
		if err != nil {
			return oauthProfile{}, err
		}
		var user struct {
			ID    string `json:"id"`
			Email string `json:"email"`
			Name  string `json:"name"`
		}
		raw, err := s.getJSON(ctx, "https://www.googleapis.com/oauth2/v2/userinfo", token, &user)
		if err != nil {
			return oauthProfile{}, err
		}
		return oauthProfile{ProviderID: user.ID, Email: user.Email, Name: user.Name, Raw: raw}, nil
	case "github":
		if s.cfg.GitHubClientID == "" || s.cfg.GitHubClientSecret == "" {
			return oauthProfile{}, ErrOAuthNotConfigured
		}
		token, err := s.exchangeForm(ctx, "https://github.com/login/oauth/access_token", url.Values{
			"client_id":     {s.cfg.GitHubClientID},
			"client_secret": {s.cfg.GitHubClientSecret},
			"redirect_uri":  {s.cfg.GitHubRedirectURL},
			"code":          {code},
		})
		if err != nil {
			return oauthProfile{}, err
		}
		var user struct {
			ID    int64  `json:"id"`
			Login string `json:"login"`
			Name  string `json:"name"`
			Email string `json:"email"`
		}
		raw, err := s.getJSON(ctx, "https://api.github.com/user", token, &user)
		if err != nil {
			return oauthProfile{}, err
		}
		email := user.Email
		if email == "" {
			// Don't swallow the error here — without it, "missing scope",
			// "GitHub API down", and "user has no verified email" all
			// silently produce an empty email and surface as a generic
			// "invalid code" downstream. Letting it propagate gives the
			// callback handler a chance to map specific failure modes.
			fetched, err := s.fetchGitHubPrimaryEmail(ctx, token)
			if err != nil {
				return oauthProfile{}, err
			}
			email = fetched
		}
		name := user.Name
		if name == "" {
			name = user.Login
		}
		return oauthProfile{ProviderID: strconv.FormatInt(user.ID, 10), Email: email, Name: name, Raw: raw}, nil
	default:
		return oauthProfile{}, ErrInvalidCode
	}
}

func (s *AuthService) exchangeForm(ctx context.Context, endpoint string, form url.Values) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() {
		_ = resp.Body.Close()
	}()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("oauth token exchange failed: %s", resp.Status)
	}
	var payload struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	if payload.AccessToken == "" {
		return "", ErrInvalidToken
	}
	return payload.AccessToken, nil
}

func (s *AuthService) getJSON(ctx context.Context, endpoint, bearer string, out any) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = resp.Body.Close()
	}()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("oauth profile request failed: %s", resp.Status)
	}
	if err := json.NewDecoder(bytes.NewReader(raw)).Decode(out); err != nil {
		return nil, err
	}
	return raw, nil
}

func (s *AuthService) fetchGitHubPrimaryEmail(ctx context.Context, bearer string) (string, error) {
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if _, err := s.getJSON(ctx, "https://api.github.com/user/emails", bearer, &emails); err != nil {
		return "", err
	}
	for _, email := range emails {
		if email.Primary && email.Verified {
			return email.Email, nil
		}
	}
	return "", ErrNoVerifiedEmail
}

func (s *AuthService) getOrCreateOAuthUser(ctx context.Context, provider string, profile oauthProfile) (sqlc.AuthUser, bool, error) {
	if profile.ProviderID == "" || profile.Email == "" {
		return sqlc.AuthUser{}, false, ErrInvalidCode
	}
	if identity, err := s.queries.GetIdentityByProviderID(ctx, sqlc.GetIdentityByProviderIDParams{
		Provider:   provider,
		ProviderID: profile.ProviderID,
	}); err == nil {
		_ = s.queries.UpdateIdentityLastSignIn(ctx, sqlc.UpdateIdentityLastSignInParams{
			Provider:     provider,
			ProviderID:   profile.ProviderID,
			IdentityData: profile.Raw,
			Email:        database.Text(profile.Email),
		})
		user, err := s.queries.GetUserByID(ctx, identity.UserID)
		return user, false, err
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return sqlc.AuthUser{}, false, err
	}

	user, isNew, err := s.getOrCreateEmailUser(ctx, profile.Email, uuid.NullUUID{})
	if err != nil {
		return sqlc.AuthUser{}, false, err
	}
	_, err = s.queries.CreateIdentity(ctx, sqlc.CreateIdentityParams{
		UserID:       user.ID,
		Provider:     provider,
		ProviderID:   profile.ProviderID,
		IdentityData: profile.Raw,
		Email:        database.Text(profile.Email),
	})
	if err != nil {
		return sqlc.AuthUser{}, false, err
	}
	return user, isNew, nil
}

func (s *AuthService) getOrCreateEmailUser(ctx context.Context, email string, userID uuid.NullUUID) (sqlc.AuthUser, bool, error) {
	if userID.Valid {
		user, err := s.queries.GetUserByID(ctx, userID.UUID)
		return user, false, err
	}
	if user, err := s.queries.GetUserByEmail(ctx, email); err == nil {
		return user, false, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return sqlc.AuthUser{}, false, err
	}
	defaultName := strings.Split(email, "@")[0]
	user, err := s.queries.CreateUser(ctx, sqlc.CreateUserParams{
		Email:            email,
		Name:             defaultName,
		EmailConfirmedAt: database.Timestamptz(time.Now()),
	})
	if err != nil {
		return sqlc.AuthUser{}, false, err
	}
	return user, true, nil
}

func (s *AuthService) createFlowState(ctx context.Context, provider, method, email string, userID uuid.UUID, redirectURI string) (string, error) {
	state := generateSecureToken(32)
	_, err := s.queries.CreateFlowState(ctx, sqlc.CreateFlowStateParams{
		AuthCode:             state,
		ProviderType:         provider,
		AuthenticationMethod: method,
		Email:                database.Text(email),
		UserID:               uuid.NullUUID{UUID: userID, Valid: userID != uuid.Nil},
		RedirectUri:          database.Text(redirectURI),
		ExpiresAt:            database.Timestamptz(time.Now().Add(flowExpiry)),
	})
	return state, err
}

func (s *AuthService) createSessionAndTokens(ctx context.Context, user sqlc.AuthUser, userAgent, ipAddress string, accessTTL, refreshTTL time.Duration) (*TokenPair, error) {
	session, err := s.queries.CreateSession(ctx, sqlc.CreateSessionParams{
		UserID:    user.ID,
		NotAfter:  database.Timestamptz(time.Now().Add(s.cfg.SessionMaxAge)),
		UserAgent: database.Text(userAgent),
		IpAddress: database.Text(ipAddress),
	})
	if err != nil {
		return nil, err
	}
	return s.createTokensWithQueries(ctx, s.queries, user, session.ID, accessTTL, refreshTTL)
}

func (s *AuthService) createTokensWithQueries(ctx context.Context, q *sqlc.Queries, user sqlc.AuthUser, sessionID uuid.UUID, accessTTL, refreshTTL time.Duration) (*TokenPair, error) {
	userID := user.ID
	now := time.Now()
	claims := &Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID.String(),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(accessTTL)),
		},
		SessionID: sessionID.String(),
		Email:     user.Email,
	}
	accessToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(s.cfg.JWTSecret))
	if err != nil {
		return nil, err
	}
	refreshToken := generateSecureToken(32)
	_, err = q.CreateRefreshToken(ctx, sqlc.CreateRefreshTokenParams{
		TokenHash: hashToken(refreshToken),
		SessionID: sessionID,
		UserID:    user.ID,
		ExpiresAt: database.Timestamptz(now.Add(refreshTTL)),
	})
	if err != nil {
		return nil, err
	}
	return &TokenPair{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresIn:    int64(accessTTL.Seconds()),
	}, nil
}

func (s *AuthService) logAuthEvent(ctx context.Context, userID uuid.UUID, email string, action sqlc.AuditLogAuthAction, payload map[string]any, ipAddress, userAgent string) error {
	raw := []byte(`{}`)
	if payload != nil {
		if encoded, err := json.Marshal(payload); err == nil {
			raw = encoded
		}
	}
	return s.queries.CreateAuthEvent(ctx, sqlc.CreateAuthEventParams{
		ActorID:    uuid.NullUUID{UUID: userID, Valid: userID != uuid.Nil},
		ActorEmail: database.Text(email),
		Action:     action,
		Payload:    raw,
		IpAddress:  database.Text(ipAddress),
		UserAgent:  database.Text(userAgent),
	})
}

func generateOTP() (string, error) {
	max := big.NewInt(1000000)
	n, err := rand.Int(rand.Reader, max)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

func generateSecureToken(byteLen int) string {
	buf := make([]byte, byteLen)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
