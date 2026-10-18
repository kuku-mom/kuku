package memory

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRegistrationExtensionMetadata(t *testing.T) {
	h, _ := fixture(t)
	base := `{"client_name":"Claude","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"],"scope":"memory:read memory:write offline_access","application_type":"web","future_extension":{"value":true}}`
	for _, tc := range []struct {
		name, body, contentType string
		want                    int
	}{
		{"claude_metadata", base, "application/json", 201},
		{"unsafe_redirect", strings.Replace(base, "https://claude.ai/api/mcp/auth_callback", "http://remote.example/callback", 1), "application/json", 400},
		{"unsupported_auth", strings.Replace(base, `"none"`, `"client_secret_post"`, 1), "application/json", 400},
		{"trailing_json", base + `{}`, "application/json", 400},
		{"wrong_content_type", base, "text/plain", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/oauth/register", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", tc.contentType)
			response := httptest.NewRecorder()
			h.register(response, req)
			if response.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", response.Code, tc.want, response.Body.String())
			}
			if response.Code == 201 {
				var result map[string]any
				if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				clientID, _ := result["client_id"].(string)
				if clientID == "" || result["token_endpoint_auth_method"] != "none" {
					t.Fatalf("invalid registration response: %s", response.Body.String())
				}
				if _, present := result["future_extension"]; present {
					t.Fatal("unsupported metadata was retained")
				}
			}
		})
	}
}

func TestInternalDecodeStillRejectsUnknownFields(t *testing.T) {
	req := httptest.NewRequest("POST", "/api/memory", strings.NewReader(`{"id":"mem_test","application_type":"web"}`))
	req.Header.Set("Content-Type", "application/json")
	var read Read
	if err := decode(req, &read); err == nil {
		t.Fatal("internal API accepted an unknown field")
	}
}
