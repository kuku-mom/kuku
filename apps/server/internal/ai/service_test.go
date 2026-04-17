package ai

import (
	"testing"

	"google.golang.org/genai"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/structpb"

	aiv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/ai/v1"
)

// TestBuildContentsAndConfigPreserveToolFlow exercises the proto → genai
// translation for a representative agent turn: tool declaration on the
// config, prior assistant tool call + tool result echoed back into the
// conversation history. Catches regressions where role/ID round-tripping
// breaks the multi-turn handshake the desktop runtime relies on.
func TestBuildContentsAndConfigPreserveToolFlow(t *testing.T) {
	params, err := structpb.NewStruct(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path": map[string]any{"type": "string"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	args, err := structpb.NewStruct(map[string]any{"path": "notes.md"})
	if err != nil {
		t.Fatal(err)
	}

	input := CompleteInput{
		Mode: aiv1.ConversationMode_CONVERSATION_MODE_AGENT,
		Tools: []*aiv1.ToolDescriptor{{
			Name:        proto.String("read_file"),
			Description: proto.String("Read a file"),
			Parameters:  params,
		}},
		Messages: []*aiv1.ChatMessage{
			{
				Role:    aiv1.ChatMessageRole_CHAT_MESSAGE_ROLE_USER.Enum(),
				Content: proto.String("Read notes.md"),
			},
			{
				Role: aiv1.ChatMessageRole_CHAT_MESSAGE_ROLE_ASSISTANT.Enum(),
				ToolCalls: []*aiv1.ModelToolCall{{
					CallId:         proto.String("call-1"),
					ToolName:       proto.String("read_file"),
					Arguments:      args,
					ToolCallId:     proto.String("call-1"),
					ProviderCallId: proto.String("call-1"),
				}},
			},
			{
				Role:           aiv1.ChatMessageRole_CHAT_MESSAGE_ROLE_TOOL_RESULT.Enum(),
				CallId:         proto.String("call-1"),
				ToolName:       proto.String("read_file"),
				Content:        proto.String("hello"),
				ToolCallId:     proto.String("call-1"),
				ProviderCallId: proto.String("call-1"),
			},
		},
	}

	contents, err := buildContents(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(contents) != 3 {
		t.Fatalf("len(contents) = %d, want 3", len(contents))
	}

	// Assistant turn: should carry the FunctionCall part with the original
	// id so the next round can stitch the result back in.
	assistant := contents[1]
	if assistant.Role != genai.RoleModel {
		t.Fatalf("assistant role = %q, want model", assistant.Role)
	}
	if len(assistant.Parts) != 1 || assistant.Parts[0].FunctionCall == nil {
		t.Fatalf("expected assistant part to be a FunctionCall, got %+v", assistant.Parts)
	}
	if got := assistant.Parts[0].FunctionCall.ID; got != "call-1" {
		t.Fatalf("function call id = %q, want call-1", got)
	}

	// Tool-result turn: FunctionResponse echoes the same id and carries
	// the textual result inside the response map.
	toolResult := contents[2]
	if len(toolResult.Parts) != 1 || toolResult.Parts[0].FunctionResponse == nil {
		t.Fatalf("expected tool-result part to be a FunctionResponse, got %+v", toolResult.Parts)
	}
	if got := toolResult.Parts[0].FunctionResponse.ID; got != "call-1" {
		t.Fatalf("function response id = %q, want call-1", got)
	}
	if got := toolResult.Parts[0].FunctionResponse.Response["result"]; got != "hello" {
		t.Fatalf("function response result = %v, want hello", got)
	}

	// Config: tool declaration with the original name + description ends
	// up under Tools[0].FunctionDeclarations[0]. ParametersJsonSchema
	// holds the raw schema map so model-side parameter validation works.
	cfg, err := buildConfig(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Tools) != 1 || len(cfg.Tools[0].FunctionDeclarations) != 1 {
		t.Fatalf("expected one tool with one declaration, got %+v", cfg.Tools)
	}
	decl := cfg.Tools[0].FunctionDeclarations[0]
	if decl.Name != "read_file" {
		t.Fatalf("tool declaration name = %q, want read_file", decl.Name)
	}
}

// TestExtractToolCallsRoundTripsSignature ensures the opaque ThoughtSignature
// from the model is preserved through proto so subsequent turns can echo it
// back — without it, multi-turn tool conversations against newer Gemini
// models silently break.
func TestExtractToolCallsRoundTripsSignature(t *testing.T) {
	response := &genai.GenerateContentResponse{
		Candidates: []*genai.Candidate{{
			Content: &genai.Content{
				Parts: []*genai.Part{{
					FunctionCall: &genai.FunctionCall{
						ID:   "call-1",
						Name: "search_vault",
						Args: map[string]any{"query": "kuku"},
					},
					ThoughtSignature: []byte("sig"),
				}},
			},
		}},
	}

	calls, err := extractToolCalls(response)
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 {
		t.Fatalf("len(calls) = %d, want 1", len(calls))
	}
	if got := calls[0].GetProviderCallId(); got != "call-1" {
		t.Fatalf("provider call id = %q, want call-1", got)
	}
	if got := calls[0].GetArguments().AsMap()["query"]; got != "kuku" {
		t.Fatalf("argument query = %v, want kuku", got)
	}
	if got := calls[0].GetSignature(); got != "sig" {
		t.Fatalf("signature = %q, want sig", got)
	}
}

// TestBuildContentsFastPathWithContextFiles covers the no-history call site
// (initial turn) where ContextFiles get inlined into the user prompt. This
// shape is what the desktop sends on the very first message of a session.
func TestBuildContentsFastPathWithContextFiles(t *testing.T) {
	contents, err := buildContents(CompleteInput{
		Message:      "summarize",
		ContextFiles: []string{"file-a", "file-b"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(contents) != 1 {
		t.Fatalf("len(contents) = %d, want 1", len(contents))
	}
	if contents[0].Role != genai.RoleUser {
		t.Fatalf("role = %q, want user", contents[0].Role)
	}
	if len(contents[0].Parts) != 1 {
		t.Fatalf("len(parts) = %d, want 1", len(contents[0].Parts))
	}
	got := contents[0].Parts[0].Text
	for _, want := range []string{"summarize", "file-a", "file-b"} {
		if !contains(got, want) {
			t.Fatalf("expected text to contain %q, got %q", want, got)
		}
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
