package memory

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"github.com/kuku-mom/kuku/apps/server/internal/auth"
)

func randomToken() string {
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic("secure randomness unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(bytes[:])
}
func challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}
func decode(r *http.Request, out any) error {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return errors.New("application/json required")
	}
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1_048_576))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return errors.New("invalid JSON request")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("invalid trailing JSON")
	}
	return nil
}
func safeRedirect(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.Fragment != "" || u.User != nil {
		return false
	}
	return u.Scheme == "https" || u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")
}

type registeredClient struct {
	Name          string   `json:"client_name"`
	Redirects     []string `json:"redirect_uris"`
	GrantTypes    []string `json:"grant_types,omitempty"`
	ResponseTypes []string `json:"response_types,omitempty"`
	AuthMethod    string   `json:"token_endpoint_auth_method,omitempty"`
	Scope         string   `json:"scope,omitempty"`
	ClientURI     string   `json:"client_uri,omitempty"`
	LogoURI       string   `json:"logo_uri,omitempty"`
	Contacts      []string `json:"contacts,omitempty"`
}

func (h *Handler) register(w http.ResponseWriter, r *http.Request) {
	var c registeredClient
	if err := decode(r, &c); err != nil {
		fail(w, 400, err.Error())
		return
	}
	if !validText(c.Name, 160) || len(c.Redirects) < 1 || len(c.Redirects) > 10 || c.AuthMethod != "" && c.AuthMethod != "none" {
		fail(w, 400, "invalid_client_metadata")
		return
	}
	for _, redirect := range c.Redirects {
		if len(redirect) > 2000 || !safeRedirect(redirect) {
			fail(w, 400, "invalid_redirect_uri")
			return
		}
	}
	for _, grant := range c.GrantTypes {
		if grant != "authorization_code" && grant != "refresh_token" {
			fail(w, 400, "unsupported_grant_type")
			return
		}
	}
	for _, response := range c.ResponseTypes {
		if response != "code" {
			fail(w, 400, "unsupported_response_type")
			return
		}
	}
	id := randomToken()
	_, err := h.store.Pool.Exec(r.Context(), `INSERT INTO kuku.memory_oauth_clients(id,name,redirect_uris) VALUES($1,$2,$3)`, id, c.Name, encode(c.Redirects))
	if err != nil {
		fail(w, 500, "registration failed")
		return
	}
	writeJSON(w, 201, map[string]any{"client_id": id, "client_name": c.Name, "redirect_uris": c.Redirects, "token_endpoint_auth_method": "none", "grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"}})
}

type authorizeParams struct {
	ClientID        string `json:"client_id"`
	RedirectURI     string `json:"redirect_uri"`
	State           string `json:"state"`
	Challenge       string `json:"code_challenge"`
	ChallengeMethod string `json:"code_challenge_method"`
	ResponseType    string `json:"response_type"`
	Resource        string `json:"resource"`
	Scope           string `json:"scope"`
}

func (h *Handler) validateAuthorize(ctx context.Context, a authorizeParams) (string, error) {
	if a.ResponseType != "code" || a.ChallengeMethod != "S256" || len(a.Challenge) != 43 || len(a.State) > 2000 || a.Resource != h.issuer+"/mcp" {
		return "", errors.New("invalid authorization request: code, S256 and the exact MCP resource are required")
	}
	if _, err := base64.RawURLEncoding.DecodeString(a.Challenge); err != nil {
		return "", errors.New("invalid PKCE challenge")
	}
	for _, scope := range strings.Fields(a.Scope) {
		if scope != "memory:read" && scope != "memory:write" && scope != "offline_access" {
			return "", errors.New("invalid OAuth scope")
		}
	}
	var name string
	var redirects []byte
	if err := h.store.Pool.QueryRow(ctx, `SELECT name,redirect_uris FROM kuku.memory_oauth_clients WHERE id=$1`, a.ClientID).Scan(&name, &redirects); err != nil {
		return "", errors.New("unknown OAuth client")
	}
	var allowed []string
	if err := json.Unmarshal(redirects, &allowed); err != nil {
		return "", err
	}
	for _, redirect := range allowed {
		if redirect == a.RedirectURI {
			return name, nil
		}
	}
	return "", errors.New("redirect URI is not registered")
}
func authorizationFromQuery(q url.Values) authorizeParams {
	return authorizeParams{ClientID: q.Get("client_id"), RedirectURI: q.Get("redirect_uri"), State: q.Get("state"), Challenge: q.Get("code_challenge"), ChallengeMethod: q.Get("code_challenge_method"), ResponseType: q.Get("response_type"), Resource: q.Get("resource"), Scope: q.Get("scope")}
}
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) {
	a := authorizationFromQuery(r.URL.Query())
	if _, err := h.validateAuthorize(r.Context(), a); err != nil {
		fail(w, 400, err.Error())
		return
	}
	target := h.webURL + "/memory/connect?" + r.URL.RawQuery
	http.Redirect(w, r, target, http.StatusSeeOther)
}

type consentRequest struct {
	Authorization authorizeParams `json:"authorization"`
	Scopes        []string        `json:"scopes"`
	CanWrite      bool            `json:"can_write"`
}

func (h *Handler) consent(w http.ResponseWriter, r *http.Request) {
	user, _, err := auth.FromContext(r.Context())
	if err != nil {
		fail(w, 401, "sign in required")
		return
	}
	var c consentRequest
	if err = decode(r, &c); err != nil {
		fail(w, 400, err.Error())
		return
	}
	a := c.Authorization
	if _, err = h.validateAuthorize(r.Context(), a); err != nil {
		fail(w, 400, err.Error())
		return
	}
	if len(c.Scopes) == 0 || len(c.Scopes) > 100 {
		fail(w, 400, "select at least one memory scope")
		return
	}
	if c.CanWrite && !strings.Contains(" "+a.Scope+" ", " memory:write ") {
		fail(w, 400, "write access was not requested by this client")
		return
	}
	for _, scope := range c.Scopes {
		var exists bool
		if err = h.store.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM kuku.memory_scopes WHERE user_id=$1 AND name=$2)`, user, scope).Scan(&exists); err != nil || !exists {
			fail(w, 400, "unknown memory scope")
			return
		}
	}
	grant := uuid.New()
	code := randomToken()
	tx, err := h.store.Pool.Begin(r.Context())
	if err != nil {
		fail(w, 500, "authorization failed")
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `INSERT INTO kuku.memory_grants(id,user_id,client_id,scopes,can_write) VALUES($1,$2,$3,$4,$5)`, grant, user, a.ClientID, c.Scopes, c.CanWrite); err == nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO kuku.memory_oauth_codes(hash,grant_id,redirect_uri,challenge,resource,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')`, hash(code), grant, a.RedirectURI, a.Challenge, a.Resource)
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		fail(w, 500, "authorization failed")
		return
	}
	redirect, _ := url.Parse(a.RedirectURI)
	q := redirect.Query()
	q.Set("code", code)
	q.Set("state", a.State)
	q.Set("iss", h.issuer)
	redirect.RawQuery = q.Encode()
	writeJSON(w, 200, map[string]any{"redirect_url": redirect.String()})
}
func (h *Handler) token(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	if err := r.ParseForm(); err != nil {
		fail(w, 400, "invalid_request")
		return
	}
	clientID := r.PostForm.Get("client_id")
	resource := r.PostForm.Get("resource")
	if resource != "" && resource != h.issuer+"/mcp" {
		fail(w, 400, "invalid_target")
		return
	}
	tx, err := h.store.Pool.Begin(r.Context())
	if err != nil {
		fail(w, 500, "token exchange failed")
		return
	}
	defer tx.Rollback(r.Context())
	var grant uuid.UUID
	var boundClient string
	var revoked bool
	var scopes []string
	var write bool
	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		verifier := r.PostForm.Get("code_verifier")
		if len(verifier) < 43 || len(verifier) > 128 {
			fail(w, 400, "invalid_grant")
			return
		}
		var redirect, pkce, boundResource string
		err = tx.QueryRow(r.Context(), `SELECT grant_id,redirect_uri,challenge,resource FROM kuku.memory_oauth_codes WHERE hash=$1 AND expires_at>now() FOR UPDATE`, hash(r.PostForm.Get("code"))).Scan(&grant, &redirect, &pkce, &boundResource)
		if err != nil || redirect != r.PostForm.Get("redirect_uri") || pkce != challenge(verifier) || resource != "" && resource != boundResource {
			fail(w, 400, "invalid_grant")
			return
		}
		_, err = tx.Exec(r.Context(), `DELETE FROM kuku.memory_oauth_codes WHERE hash=$1`, hash(r.PostForm.Get("code")))
	case "refresh_token":
		err = tx.QueryRow(r.Context(), `DELETE FROM kuku.memory_oauth_tokens WHERE hash=$1 AND kind='refresh' AND expires_at>now() RETURNING grant_id`, hash(r.PostForm.Get("refresh_token"))).Scan(&grant)
	default:
		fail(w, 400, "unsupported_grant_type")
		return
	}
	if err != nil {
		fail(w, 400, "invalid_grant")
		return
	}
	if err = tx.QueryRow(r.Context(), `SELECT client_id,revoked,scopes,can_write FROM kuku.memory_grants WHERE id=$1 FOR UPDATE`, grant).Scan(&boundClient, &revoked, &scopes, &write); err != nil || revoked || clientID != boundClient {
		fail(w, 400, "invalid_grant")
		return
	}
	access, refresh := randomToken(), randomToken()
	if _, err = tx.Exec(r.Context(), `INSERT INTO kuku.memory_oauth_tokens VALUES($1,$2,'access',now()+interval '1 hour'),($3,$2,'refresh',now()+interval '30 days')`, hash(access), grant, hash(refresh)); err != nil || tx.Commit(r.Context()) != nil {
		fail(w, 500, "token exchange failed")
		return
	}
	oauthScope := "memory:read offline_access"
	if write {
		oauthScope += " memory:write"
	}
	writeJSON(w, 200, map[string]any{"access_token": access, "refresh_token": refresh, "token_type": "Bearer", "expires_in": 3600, "scope": oauthScope})
}
func (h *Handler) revoke(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	if r.ParseForm() != nil {
		fail(w, 400, "invalid_request")
		return
	}
	_, err := h.store.Pool.Exec(r.Context(), `UPDATE kuku.memory_grants SET revoked=true WHERE id IN(SELECT grant_id FROM kuku.memory_oauth_tokens WHERE hash=$1) AND client_id=$2`, hash(r.PostForm.Get("token")), r.PostForm.Get("client_id"))
	if err != nil {
		fail(w, 500, "revocation failed")
		return
	}
	w.WriteHeader(200)
}
func (h *Handler) principal(ctx context.Context, token string) (Principal, error) {
	var p Principal
	err := h.store.Pool.QueryRow(ctx, `SELECT g.user_id,g.id,g.client_id,g.scopes,g.can_write FROM kuku.memory_oauth_tokens t JOIN kuku.memory_grants g ON g.id=t.grant_id JOIN auth.users u ON u.id=g.user_id WHERE u.deleted_at IS NULL AND t.hash=$1 AND t.kind='access' AND t.expires_at>now() AND NOT g.revoked`, hash(token)).Scan(&p.User, &p.Grant, &p.Client, &p.Scopes, &p.CanWrite)
	if err != nil {
		return p, errors.New("invalid token")
	}
	p.Client = p.Grant.String()
	return p, nil
}
func (h *Handler) metadata(w http.ResponseWriter, r *http.Request) {
	if strings.Contains(r.URL.Path, "oauth-protected-resource") {
		writeJSON(w, 200, map[string]any{"resource": h.issuer + "/mcp", "authorization_servers": []string{h.issuer}, "scopes_supported": []string{"memory:read", "memory:write"}})
		return
	}
	writeJSON(w, 200, map[string]any{"issuer": h.issuer, "authorization_endpoint": h.issuer + "/oauth/authorize", "token_endpoint": h.issuer + "/oauth/token", "registration_endpoint": h.issuer + "/oauth/register", "revocation_endpoint": h.issuer + "/oauth/revoke", "response_types_supported": []string{"code"}, "grant_types_supported": []string{"authorization_code", "refresh_token"}, "code_challenge_methods_supported": []string{"S256"}, "token_endpoint_auth_methods_supported": []string{"none"}, "scopes_supported": []string{"memory:read", "memory:write", "offline_access"}})
}
