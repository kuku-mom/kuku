package memory

// Opt-in browser fixture, compiled only by go test. It authenticates an
// isolated test user; it is never registered by the production server.
import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/kuku-mom/kuku/apps/server/internal/auth"
)

func TestBrowserFixture(t *testing.T) {
	path := os.Getenv("KUKU_MEMORY_BROWSER_FIXTURE")
	if path == "" {
		t.Skip("opt-in browser fixture")
	}
	h, p := fixture(t)
	mux := http.NewServeMux()
	h.Mount(mux)
	stop := make(chan struct{})
	mux.HandleFunc("GET /__stop", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200); close(stop) })
	mux.HandleFunc("GET /callback", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("Kuku OAuth callback received")) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "http://localhost:4322")
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		mux.ServeHTTP(w, r.WithContext(auth.WithAuth(r.Context(), p.User, uuid.New())))
	}))
	defer server.Close()
	h.issuer = server.URL
	client := randomToken()
	redirect := server.URL + "/callback"
	_, err := h.store.Pool.Exec(context.Background(), `INSERT INTO kuku.memory_oauth_clients(id,name,redirect_uris) VALUES($1,'Browser Test',$2)`, client, encode([]string{redirect}))
	if err != nil {
		t.Fatal(err)
	}
	q := url.Values{"client_id": {client}, "redirect_uri": {redirect}, "state": {"browser-test"}, "code_challenge": {challenge(randomToken())}, "code_challenge_method": {"S256"}, "response_type": {"code"}, "resource": {server.URL + "/mcp"}, "scope": {"memory:read memory:write offline_access"}}
	data, _ := json.Marshal(map[string]string{"api_url": server.URL, "consent_url": "http://localhost:4322/memory/connect?" + q.Encode()})
	if err = os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stop:
	case <-time.After(5 * time.Minute):
	}
}
