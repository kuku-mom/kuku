package memory

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

func TestCheckpointSharedContract(t *testing.T) {
	data, err := os.ReadFile("../../../../tests/fixtures/memory/checkpoints.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []Checkpoint
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) != 40 {
		t.Fatal(len(cases))
	}
	for _, c := range cases {
		r, err := c.remember()
		if err != nil {
			t.Fatal(err)
		}
		if err = validate(r); err != nil {
			t.Fatal(err)
		}
		m := Memory{ID: "mem_test", Scope: c.Scope, Version: 1, Record: r.Record}
		context := projectContext([]Memory{m}, 6000)
		if len(context["checkpoints"].([]map[string]any)) != 1 {
			t.Fatal(context)
		}
		r.Record.Experiences[0].Outcome = "invented"
		if validate(r) == nil {
			t.Fatal("accepted unsupported outcome")
		}
	}
}

func TestCheckpointPersistenceAndConflict(t *testing.T) {
	h, p := fixture(t)
	ctx := context.Background()
	c := Checkpoint{RequestID: "checkpoint-1", Scope: "personal", Title: "Project progress", Record: ProjectRecord{TaskID: "release", Goal: "Release", State: "Verified", OccurredAt: "2026-10-18T00:00:00Z", Experiences: []Experience{{Conditions: "OAuth", Method: "Validate metadata", Result: "Success", Outcome: "success"}}}}
	r, err := c.remember()
	if err != nil {
		t.Fatal(err)
	}
	first, err := h.store.Remember(ctx, p, r)
	if err != nil || first["status"] != "committed" {
		t.Fatalf("%v %v", first, err)
	}
	retry, err := h.store.Remember(ctx, p, r)
	if err != nil || first["id"] != retry["id"] {
		t.Fatal("duplicate checkpoint", err)
	}
	records, err := h.store.Search(ctx, p, Query{TaskID: "release"})
	if err != nil || len(records) != 1 || records[0].Record.State != "Verified" {
		t.Fatalf("%v %v", records, err)
	}
	id := records[0].ID
	v := int64(1)
	c.ID = &id
	c.ExpectedVersion = &v
	c.RequestID = "checkpoint-old"
	c.Record.OccurredAt = "2020-01-01T00:00:00Z"
	r, _ = c.remember()
	result, err := h.store.Remember(ctx, p, r)
	if err != nil || result["status"] != "conflict" {
		t.Fatalf("stale checkpoint %v %v", result, err)
	}
	hidden := p
	hidden.Scopes = []string{"other"}
	records, err = h.store.Search(ctx, hidden, Query{TaskID: "release"})
	if err != nil || len(records) != 0 {
		t.Fatal("cross-scope checkpoint")
	}
}
