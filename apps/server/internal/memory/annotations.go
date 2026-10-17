package memory

import (
	"context"
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func memoryAnnotations(readOnly bool) *mcp.ToolAnnotations {
	destructive, openWorld := !readOnly, false
	return &mcp.ToolAnnotations{ReadOnlyHint: readOnly, DestructiveHint: &destructive, OpenWorldHint: &openWorld, IdempotentHint: true}
}

// go-sdk v1.4.1 omits a false readOnlyHint during JSON serialization. Hosts
// require explicit booleans for their tool review/approval UI. Keep the SDK's
// transport and dispatch, and normalize only its tools/list response.
type explicitToolList struct{ *mcp.ListToolsResult }

func (r *explicitToolList) MarshalJSON() ([]byte, error) {
	data, err := json.Marshal(r.ListToolsResult)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err = json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	tools, _ := result["tools"].([]any)
	for i, value := range tools {
		tool, ok := value.(map[string]any)
		if !ok || i >= len(r.Tools) || r.Tools[i].Annotations == nil {
			continue
		}
		annotations, ok := tool["annotations"].(map[string]any)
		if !ok {
			annotations = map[string]any{}
			tool["annotations"] = annotations
		}
		annotations["readOnlyHint"] = r.Tools[i].Annotations.ReadOnlyHint
	}
	return json.Marshal(result)
}

func explicitAnnotations(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		result, err := next(ctx, method, req)
		if list, ok := result.(*mcp.ListToolsResult); method == "tools/list" && err == nil && ok {
			return &explicitToolList{list}, nil
		}
		return result, err
	}
}
