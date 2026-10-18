package memory

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

type Experience struct {
	Conditions string `json:"conditions"`
	Method     string `json:"method"`
	Result     string `json:"result"`
	Outcome    string `json:"outcome"`
}
type ProjectRecord struct {
	TaskID        string       `json:"task_id"`
	Goal          string       `json:"goal"`
	State         string       `json:"state"`
	Decisions     []string     `json:"decisions,omitempty"`
	OpenQuestions []string     `json:"open_questions,omitempty"`
	NextActions   []string     `json:"next_actions,omitempty"`
	Experiences   []Experience `json:"experiences,omitempty"`
	OccurredAt    string       `json:"occurred_at"`
}

func (r ProjectRecord) validate() error {
	_, err := time.Parse(time.RFC3339, r.OccurredAt)
	if err != nil || !identifier.MatchString(r.TaskID) || strings.TrimSpace(r.Goal) == "" || strings.TrimSpace(r.State) == "" || len(r.Decisions) > 20 || len(r.OpenQuestions) > 20 || len(r.NextActions) > 20 || len(r.Experiences) > 10 || utf8.RuneCount(encode(r)) > 16000 {
		return errors.New("invalid project record")
	}
	for _, e := range r.Experiences {
		if (e.Outcome != "success" && e.Outcome != "failure" && e.Outcome != "unverified") || strings.TrimSpace(e.Conditions) == "" || strings.TrimSpace(e.Method) == "" || strings.TrimSpace(e.Result) == "" {
			return errors.New("invalid experience")
		}
	}
	return nil
}
func (r ProjectRecord) body() string {
	var b strings.Builder
	b.WriteString("Goal: " + r.Goal + "\nCurrent state: " + r.State + "\nOccurred: " + r.OccurredAt + "\n")
	for _, section := range []struct {
		label  string
		values []string
	}{{"Decisions", r.Decisions}, {"Open questions", r.OpenQuestions}, {"Suggested next actions", r.NextActions}} {
		b.WriteString("\n" + section.label + ":\n")
		for _, v := range section.values {
			b.WriteString("- " + v + "\n")
		}
	}
	for _, e := range r.Experiences {
		b.WriteString("\nExperience (" + e.Outcome + "):\nConditions: " + e.Conditions + "\nMethod: " + e.Method + "\nResult: " + e.Result + "\n")
	}
	return b.String()
}

type Checkpoint struct {
	RequestID       string        `json:"request_id"`
	Scope           string        `json:"scope"`
	Title           string        `json:"title"`
	Record          ProjectRecord `json:"record"`
	ID              *string       `json:"id,omitempty"`
	ExpectedVersion *int64        `json:"expected_version,omitempty"`
	Sources         []Source      `json:"source_refs,omitempty"`
	ExpiresAt       *string       `json:"expires_at,omitempty"`
}

func (c Checkpoint) remember() (Remember, error) {
	if err := c.Record.validate(); err != nil {
		return Remember{}, err
	}
	kind := "project_checkpoint"
	return Remember{RequestID: c.RequestID, Scope: c.Scope, Title: c.Title, Body: c.Record.body(), Record: &c.Record, ID: c.ID, ExpectedVersion: c.ExpectedVersion, Kind: &kind, Sources: c.Sources, ExpiresAt: c.ExpiresAt}, nil
}
func projectContext(records []Memory, maxChars int) map[string]any {
	if maxChars == 0 {
		maxChars = 6000
	}
	if maxChars < 256 {
		maxChars = 256
	}
	if maxChars > 12000 {
		maxChars = 12000
	}
	selected := []map[string]any{}
	omitted := []string{}
	used := 0
	for _, m := range records {
		if m.Record == nil {
			continue
		}
		entry := map[string]any{"id": m.ID, "version": m.Version, "scope": m.Scope, "record": m.Record}
		size := utf8.RuneCount(encode(entry))
		if used+size > maxChars {
			omitted = append(omitted, m.ID)
			continue
		}
		used += size
		selected = append(selected, entry)
	}
	return map[string]any{"checkpoints": selected, "omitted_ids": omitted, "note": "Independent records are not automatically reconciled. Next actions are suggestions; verify current project state."}
}
