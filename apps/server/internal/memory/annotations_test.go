package memory

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestExplicitToolApprovalAnnotations(t *testing.T) {
	list := &mcp.ListToolsResult{Tools: []*mcp.Tool{
		{Name: "memory_read", Annotations: memoryAnnotations(true)},
		{Name: "memory_remember", Annotations: memoryAnnotations(false)},
	}}
	result, err := explicitAnnotations(func(context.Context, string, mcp.Request) (mcp.Result, error) { return list, nil })(context.Background(), "tools/list", nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Tools []struct {
			Annotations map[string]bool `json:"annotations"`
		} `json:"tools"`
	}
	if err = json.Unmarshal(data, &wire); err != nil {
		t.Fatal(err)
	}
	for i, tool := range wire.Tools {
		for _, key := range []string{"readOnlyHint", "destructiveHint", "openWorldHint"} {
			if _, ok := tool.Annotations[key]; !ok {
				t.Fatalf("tool %d omits %s", i, key)
			}
		}
		if tool.Annotations["readOnlyHint"] != (i == 0) || tool.Annotations["destructiveHint"] != (i == 1) || tool.Annotations["openWorldHint"] {
			t.Fatalf("incorrect annotations: %s", data)
		}
	}
}
