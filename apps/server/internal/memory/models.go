package memory

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type Source struct {
	Path       string  `json:"path"`
	Origin     *string `json:"origin,omitempty"`
	Title      *string `json:"title,omitempty"`
	Quote      *string `json:"quote,omitempty"`
	CapturedAt string  `json:"captured_at"`
}
type Memory struct {
	Record           *ProjectRecord `json:"record,omitempty"`
	ID               string         `json:"id"`
	Scope            string         `json:"scope"`
	Client           string         `json:"client"`
	Title            string         `json:"title"`
	Body             string         `json:"body"`
	Kind             *string        `json:"kind"`
	Status           string         `json:"status"`
	Tags             []string       `json:"tags"`
	Sources          []Source       `json:"source_refs"`
	Version          int64          `json:"version"`
	Supersedes       *string        `json:"supersedes"`
	ExpiresAt        *string        `json:"expires_at"`
	CreatedAt        string         `json:"created_at"`
	UpdatedAt        string         `json:"updated_at"`
	ProposalID       string         `json:"proposal_id"`
	DecisionDocument string         `json:"decision_document"`
	Shared           bool           `json:"shared"`
	RestoredFrom     *int64         `json:"restored_from,omitempty"`
}
type Remember struct {
	Record          *ProjectRecord `json:"record,omitempty"`
	RequestID       string         `json:"request_id"`
	Scope           string         `json:"scope"`
	Title           string         `json:"title"`
	Body            string         `json:"body"`
	ID              *string        `json:"id,omitempty"`
	ExpectedVersion *int64         `json:"expected_version,omitempty"`
	Kind            *string        `json:"kind,omitempty"`
	Tags            []string       `json:"tags,omitempty"`
	Sources         []Source       `json:"source_refs,omitempty"`
	ExpiresAt       *string        `json:"expires_at,omitempty"`
}
type Query struct {
	TaskID   string `json:"task_id,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Purpose  string `json:"purpose,omitempty"`
	MaxChars int    `json:"max_chars,omitempty"`
	Query    string `json:"query,omitempty"`
	Scope    string `json:"scope,omitempty"`
	Limit    int    `json:"limit,omitempty"`
}
type Read struct {
	ID string `json:"id"`
}

var identifier = regexp.MustCompile(`^[A-Za-z0-9_-]{1,160}$`)

func hash(s string) string { d := sha256.Sum256([]byte(s)); return hex.EncodeToString(d[:]) }
func validText(s string, max int) bool {
	return strings.TrimSpace(s) != "" && utf8.RuneCountInString(s) <= max
}
func validate(r Remember) error {
	if r.Record != nil {
		if err := r.Record.validate(); err != nil {
			return err
		}
		if strings.TrimSpace(r.Body) != strings.TrimSpace(r.Record.body()) {
			return errors.New("checkpoint body must match its structured record")
		}
	}
	if !identifier.MatchString(r.RequestID) || !identifier.MatchString(r.Scope) || !validText(r.Title, 160) || !validText(r.Body, 20000) {
		return errors.New("invalid request, scope, title or body")
	}
	if (r.ID == nil) != (r.ExpectedVersion == nil) {
		return errors.New("updates require an ID and expected_version")
	}
	if r.ID != nil && (!identifier.MatchString(*r.ID) || !strings.HasPrefix(*r.ID, "mem_") || *r.ExpectedVersion < 1) {
		return errors.New("invalid memory ID or version")
	}
	if r.Kind != nil && !validText(*r.Kind, 40) {
		return errors.New("invalid memory kind")
	}
	if len(r.Tags) > 30 || len(r.Sources) > 30 {
		return errors.New("too many tags or sources")
	}
	for _, t := range r.Tags {
		if !validText(t, 40) {
			return errors.New("invalid tag")
		}
	}
	for _, s := range r.Sources {
		if !validText(s.Path, 2000) || (s.Quote != nil && utf8.RuneCountInString(*s.Quote) > 4000) || (s.Title != nil && utf8.RuneCountInString(*s.Title) > 160) || (s.Origin != nil && utf8.RuneCountInString(*s.Origin) > 2000) {
			return errors.New("invalid source")
		}
		if _, err := time.Parse(time.RFC3339, s.CapturedAt); err != nil {
			return errors.New("invalid source timestamp")
		}
	}
	if r.ExpiresAt != nil {
		t, err := time.Parse(time.RFC3339, *r.ExpiresAt)
		if err != nil || !t.After(time.Now()) {
			return errors.New("expiry must be in the future")
		}
	}
	return nil
}
func brief(memories []Memory) []map[string]any {
	result := make([]map[string]any, 0, len(memories))
	for _, m := range memories {
		r := []rune(m.Body)
		if len(r) > 240 {
			r = r[:240]
		}
		sources := []map[string]any{}
		for i, source := range m.Sources {
			if i >= 3 {
				break
			}
			path := []rune(source.Path)
			if len(path) > 240 {
				path = path[:240]
			}
			sources = append(sources, map[string]any{"path": string(path), "title": source.Title, "captured_at": source.CapturedAt})
		}
		result = append(result, map[string]any{"id": m.ID, "scope": m.Scope, "title": m.Title, "summary": string(r), "version": m.Version, "source_refs": sources, "updated_at": m.UpdatedAt, "kind": m.Kind})
	}
	return result
}
func encode(v any) []byte { b, _ := json.Marshal(v); return b }
