package memory

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kuku-mom/kuku/apps/server/internal/auth"
	"github.com/kuku-mom/kuku/apps/server/internal/database"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func fixture(t *testing.T) (*Handler, Principal) {
	t.Helper()
	dsn := os.Getenv("KUKU_MEMORY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set KUKU_MEMORY_TEST_DATABASE_URL to an isolated PostgreSQL database")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err = database.RunMigrations(ctx, pool, filepath.Join("..", "..", "sql", "migrations")); err != nil {
		t.Fatal(err)
	}
	user := uuid.New()
	_, err = pool.Exec(ctx, `INSERT INTO auth.users(id,email,name) VALUES($1,$2,'Memory Test')`, user, user.String()+"@example.test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM auth.users WHERE id=$1`, user) })
	_, err = pool.Exec(ctx, `INSERT INTO kuku.memory_scopes VALUES($1,'personal',true),($1,'project',false)`, user)
	if err != nil {
		t.Fatal(err)
	}
	h := New(pool, "https://memory.example.test", "https://app.example.test", true, true, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return h, Principal{User: user, Client: "test", Scopes: []string{"personal"}, CanWrite: true}
}
func TestPKCEAndValidation(t *testing.T) {
	if got := challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"); got != "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" {
		t.Fatal(got)
	}
	for _, u := range []string{"javascript:alert(1)", "https://user:pass@example.com/callback", "http://remote.example/callback", "https://example.com/callback#fragment"} {
		if safeRedirect(u) {
			t.Errorf("accepted %s", u)
		}
	}
	r := Remember{RequestID: "req_1", Scope: "personal", Title: "선호", Body: "한국어"}
	if err := validate(r); err != nil {
		t.Fatal(err)
	}
	r.ID = new(string)
	if validate(r) == nil {
		t.Fatal("unversioned update accepted")
	}
}
func TestScopedMemoryLifecycle(t *testing.T) {
	h, p := fixture(t)
	ctx := context.Background()
	r := Remember{RequestID: "save", Scope: "personal", Title: "Language", Body: "설명은 한국어. English comments."}
	saved, err := h.store.Remember(ctx, p, r)
	if err != nil {
		t.Fatal(err)
	}
	id := saved["id"].(string)
	retry, err := h.store.Remember(ctx, p, r)
	if err != nil || retry["id"] != id {
		t.Fatalf("retry: %v %v", retry, err)
	}
	r.Body = "different"
	if _, err = h.store.Remember(ctx, p, r); err == nil {
		t.Fatal("reused request accepted")
	}
	for _, q := range []string{"한국어", "English"} {
		matches, err := h.store.Search(ctx, p, Query{Query: q})
		if err != nil || len(matches) != 1 {
			t.Fatalf("search %s: %v %v", q, matches, err)
		}
	}
	other := p
	other.Scopes = []string{"project"}
	if _, err = h.store.Read(ctx, other, id, false); err == nil {
		t.Fatal("cross-scope read")
	}
	attempted := RequestCorrection(id, 1, "cross-scope-correction")
	attempted.Scope = "project"
	attemptedResult, err := h.store.Remember(ctx, other, attempted)
	if err != nil {
		t.Fatal(err)
	}
	if attemptedResult["status"] != "conflict" || attemptedResult["memory"] != nil {
		t.Fatalf("cross-scope correction leaked memory: %v", attemptedResult)
	}
	other.User = uuid.New()
	if records, err := h.store.Search(ctx, other, Query{}); err != nil || len(records) != 0 {
		t.Fatal("cross-user search")
	}
	version := int64(1)
	r = RequestCorrection(id, version, "correct")
	var results [2]map[string]any
	var failures [2]error
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			copy := r
			copy.RequestID += "-" + string(rune('a'+i))
			results[i], failures[i] = h.store.Remember(ctx, p, copy)
		}(i)
	}
	wg.Wait()
	committed, conflicts := 0, 0
	for i, result := range results {
		if failures[i] != nil {
			t.Fatal(failures[i])
		}
		if result["status"] == "committed" {
			committed++
		}
		if result["status"] == "conflict" {
			conflicts++
		}
	}
	if committed != 1 || conflicts != 1 {
		t.Fatal(results)
	}
	current, err := h.store.Read(ctx, p, id, false)
	if err != nil {
		t.Fatal(err)
	}
	current.Status = "deleted"
	publication := Publication{ID: id, ExpectedVersion: current.Version, Memory: current, RequestID: "delete"}
	result, err := h.store.Publish(ctx, p, publication)
	if err != nil || result["status"] != "committed" {
		t.Fatalf("delete: %v %v", result, err)
	}
	if _, err = h.store.Read(ctx, p, id, false); err == nil {
		t.Fatal("deleted memory readable")
	}
	publication.RequestID = "stale"
	publication.Memory.Status = "active"
	if result, err = h.store.Publish(ctx, p, publication); err != nil || result["status"] != "conflict" {
		t.Fatalf("resurrected stale memory: %v %v", result, err)
	}
	deleted, err := h.store.Read(ctx, p, id, true)
	if err != nil {
		t.Fatal(err)
	}
	publication.ExpectedVersion = deleted.Version
	publication.Memory = deleted
	publication.Memory.Status = "active"
	publication.RequestID = "unapproved-restore"
	if result, err = h.store.Publish(ctx, p, publication); err != nil || result["status"] != "conflict" {
		t.Fatal("implicit resurrection accepted")
	}
	publication.Memory.RestoredFrom = &deleted.Version
	publication.RequestID = "explicit-undo"
	if result, err = h.store.Publish(ctx, p, publication); err != nil || result["status"] != "committed" {
		t.Fatalf("explicit undo failed: %v %v", result, err)
	}
	changes, err := h.store.Changes(ctx, p, 0)
	if err != nil || len(changes["memories"].([]Memory)) != 4 {
		t.Fatalf("changes: %v %v", changes, err)
	}
}
func RequestCorrection(id string, version int64, request string) Remember {
	return Remember{ID: &id, ExpectedVersion: &version, RequestID: request, Scope: "personal", Title: "Updated", Body: "corrected"}
}

func TestCorrectionsPreserveOmittedMetadata(t *testing.T) {
	h, p := fixture(t)
	ctx := context.Background()
	kind, expiry := "preference", "2099-01-01T00:00:00Z"
	r := Remember{RequestID: "metadata-save", Scope: "personal", Title: "Metadata", Body: "Original", Kind: &kind, Tags: []string{"retained-tag"}, Sources: []Source{{Path: "approved-excerpt", CapturedAt: "2026-01-01T00:00:00Z"}}, ExpiresAt: &expiry}
	saved, err := h.store.Remember(ctx, p, r)
	if err != nil {
		t.Fatal(err)
	}
	id := saved["id"].(string)
	edit := RequestCorrection(id, 1, "metadata-correct")
	if _, err = h.store.Remember(ctx, p, edit); err != nil {
		t.Fatal(err)
	}
	corrected, err := h.store.Read(ctx, p, id, false)
	if err != nil {
		t.Fatal(err)
	}
	if corrected.Kind == nil || *corrected.Kind != kind || len(corrected.Tags) != 1 || len(corrected.Sources) != 1 || corrected.ExpiresAt == nil || *corrected.ExpiresAt != expiry {
		t.Fatalf("metadata lost during correction: %+v", corrected)
	}
	edit.Tags = []string{}
	if _, err = h.store.Remember(ctx, p, edit); err == nil {
		t.Fatal("receipt treated omitted and empty arrays as identical")
	}
	edit = RequestCorrection(id, 2, "metadata-clear")
	edit.Tags, edit.Sources = []string{}, []Source{}
	if _, err = h.store.Remember(ctx, p, edit); err != nil {
		t.Fatal(err)
	}
	cleared, err := h.store.Read(ctx, p, id, false)
	if err != nil || len(cleared.Tags) != 0 || len(cleared.Sources) != 0 {
		t.Fatalf("explicit clear failed: %+v %v", cleared, err)
	}
}
func TestOAuthAndRemoteMCP(t *testing.T) {
	h, p := fixture(t)
	ctx := context.Background()
	clientID := randomToken()
	redirect := "https://client.example/callback"
	_, err := h.store.Pool.Exec(ctx, `INSERT INTO kuku.memory_oauth_clients VALUES($1,'Test Client',$2,now())`, clientID, encode([]string{redirect}))
	if err != nil {
		t.Fatal(err)
	}
	verifier := randomToken()
	a := authorizeParams{ClientID: clientID, RedirectURI: redirect, State: "state", Challenge: challenge(verifier), ChallengeMethod: "S256", ResponseType: "code", Resource: h.issuer + "/mcp", Scope: "memory:read memory:write offline_access"}
	consent := httptest.NewRequest("POST", "/api/memory/oauth/consent", bytes.NewReader(encode(consentRequest{Authorization: a, Scopes: []string{"personal"}, CanWrite: true})))
	consent.Header.Set("Content-Type", "application/json")
	consent = consent.WithContext(auth.WithAuth(ctx, p.User, uuid.New()))
	w := httptest.NewRecorder()
	h.consent(w, consent)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var response map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &response)
	callback, _ := url.Parse(response["redirect_url"])
	code := callback.Query().Get("code")
	if code == "" {
		t.Fatal(response)
	}
	exchange := func(verifier, code string) *httptest.ResponseRecorder {
		form := url.Values{"grant_type": {"authorization_code"}, "client_id": {clientID}, "redirect_uri": {redirect}, "code": {code}, "code_verifier": {verifier}, "resource": {h.issuer + "/mcp"}}
		r := httptest.NewRequest("POST", "/oauth/token", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		out := httptest.NewRecorder()
		h.token(out, r)
		return out
	}
	if exchange(randomToken(), code).Code != 400 {
		t.Fatal("bad verifier accepted")
	}
	w = exchange(verifier, code)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var tokens map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &tokens)
	access := tokens["access_token"].(string)
	if exchange(verifier, code).Code != 400 {
		t.Fatal("code replay accepted")
	}
	refreshForm := url.Values{"grant_type": {"refresh_token"}, "client_id": {clientID}, "refresh_token": {tokens["refresh_token"].(string)}, "resource": {h.issuer + "/mcp"}}
	refresh := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/oauth/token", strings.NewReader(refreshForm.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		h.token(w, r)
		return w
	}
	if result := refresh(); result.Code != 200 {
		t.Fatalf("refresh failed: %s", result.Body.String())
	}
	if refresh().Code != 400 {
		t.Fatal("refresh replay accepted")
	}

	mux := http.NewServeMux()
	h.Mount(mux)
	server := httptest.NewServer(mux)
	defer server.Close()
	transport := &mcp.StreamableClientTransport{Endpoint: server.URL + "/mcp", HTTPClient: &http.Client{Transport: tokenTransport{token: access}}}
	session, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil).Connect(ctx, transport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	tools, err := session.ListTools(ctx, nil)
	if err != nil || len(tools.Tools) != 4 {
		t.Fatalf("tools: %v %v", tools, err)
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "memory_remember", Arguments: Remember{RequestID: "mcp-save", Scope: "personal", Title: "MCP preference", Body: "한국어 설명"}})
	if err != nil || result.IsError {
		t.Fatalf("remember: %v %v", result, err)
	}
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "memory_context", Arguments: Query{Query: "한국어"}})
	if err != nil || result.IsError {
		t.Fatalf("context: %v %v", result, err)
	}
	principal, err := h.principal(ctx, access)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.store.Pool.Exec(ctx, `UPDATE kuku.memory_grants SET revoked=true WHERE id=$1`, principal.Grant)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.principal(ctx, access); err == nil {
		t.Fatal("revoked token accepted")
	}
	request := httptest.NewRequest("POST", "/mcp", nil)
	request.Header.Set("Authorization", "Bearer "+access)
	w = httptest.NewRecorder()
	h.remote(w, request)
	if w.Code != 401 {
		t.Fatal("revocation not immediate")
	}
}

type tokenTransport struct{ token string }

func (t tokenTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+t.token)
	return http.DefaultTransport.RoundTrip(r)
}
func TestDisabledFeature(t *testing.T) {
	h := New(nil, "https://example.test", "https://app.example.test", false, false, slog.Default())
	mux := http.NewServeMux()
	h.Mount(mux)
	for _, path := range []string{"/mcp", "/.well-known/oauth-protected-resource/mcp"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 404 {
			t.Fatal(path, w.Code)
		}
	}
}
