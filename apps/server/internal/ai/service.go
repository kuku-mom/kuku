package ai

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"iter"
	"strings"
	"time"

	"google.golang.org/genai"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/structpb"

	aiv1 "github.com/kuku-mom/kuku/packages/contract/gen/go/kuku/ai/v1"

	"github.com/kuku-mom/kuku/apps/server/internal/config"
)

const (
	// completeTimeout caps any single Gemini call. The SDK's default is no
	// timeout (`HTTPClient.Timeout`, `HTTPOptions.Timeout`, and `ctx.Deadline`
	// all unset → unbounded), which would let a wedged upstream pin a worker
	// forever. 120s comfortably covers Flash latency + tool-call rounds while
	// surfacing genuine hangs as a clean error rather than a stuck handler.
	completeTimeout = 120 * time.Second

	// Server-side model pin. Client-sent models and deployment env overrides
	// are intentionally ignored so all traffic stays on the same provisioned
	// Gemini SKU.
	defaultModel = "gemini-3.1-flash-lite"
)

var ErrNotConfigured = errors.New("remote ai is not configured")

// Service is a thin wrapper around the official genai SDK that translates
// between our proto contract types and the SDK's native types. The previous
// implementation hand-rolled the entire Gemini REST request/response shape;
// the SDK takes over JSON marshaling, retry, and (critically) auth header
// handling so the API key never ends up in the request URL.
type Service struct {
	client *genai.Client
}

type CompleteInput struct {
	Mode         aiv1.ConversationMode
	Message      string
	ContextFiles []string
	Model        string
	Messages     []*aiv1.ChatMessage
	Tools        []*aiv1.ToolDescriptor
	SystemPrompt string
}

func NewService(cfg *config.Config) (*Service, error) {
	apiKey := strings.TrimSpace(cfg.GeminiAPIKey)
	if apiKey == "" {
		// Service is intentionally constructible without a key so the rest
		// of the server can boot for non-AI features. Complete() returns
		// ErrNotConfigured at call time.
		return &Service{}, nil
	}
	client, err := genai.NewClient(context.Background(), &genai.ClientConfig{
		APIKey:  apiKey,
		Backend: genai.BackendGeminiAPI,
	})
	if err != nil {
		return nil, fmt.Errorf("create genai client: %w", err)
	}
	return &Service{client: client}, nil
}

// CompleteStream drives one Gemini turn and yields proto CompleteResponse
// events in the order the handler should forward them to the client:
// text deltas as the upstream stream produces them, a single buffered
// ToolCallsEvent (if any calls were made), then a terminal FinishedEvent
// carrying the derived finish_reason and the last-observed usage metadata.
//
// Tool calls are deliberately batched: the desktop runtime consumes
// CompletionEvent::ToolCalls as a Vec, and Gemini emits whole function
// calls (not argument fragments) by default, so there is no per-token
// benefit to emitting them individually.
func (s *Service) CompleteStream(ctx context.Context, input CompleteInput) iter.Seq2[*aiv1.CompleteResponse, error] {
	return func(yield func(*aiv1.CompleteResponse, error) bool) {
		if s.client == nil {
			yield(nil, ErrNotConfigured)
			return
		}
		// Work around google.golang.org/genai v1.54.0 streaming bug:
		// sendStreamRequest wraps the request context with WithTimeout(...)
		// and `defer cancel()`s before the returned iterator is consumed,
		// which truncates the SSE stream with `context canceled`.
		// Keep the timeout on our side instead so the cancel lifetime spans
		// the full streaming loop.
		ctx, cancel := context.WithTimeout(ctx, completeTimeout)
		defer cancel()

		// Model is pinned server-side. `input.Model` is ignored so a client
		// cannot steer traffic to a different Gemini SKU.
		model := defaultModel
		model = strings.TrimPrefix(model, "models/")

		contents, err := buildContents(input)
		if err != nil {
			yield(nil, err)
			return
		}
		cfg, err := buildConfig(input)
		if err != nil {
			yield(nil, err)
			return
		}

		stream := translateGenerateContentStream(
			ctx,
			s.client.Models.GenerateContentStream(ctx, model, contents, cfg),
		)
		for response, err := range stream {
			if !yield(response, err) {
				return
			}
		}
	}
}

func translateGenerateContentStream(
	ctx context.Context,
	stream iter.Seq2[*genai.GenerateContentResponse, error],
) iter.Seq2[*aiv1.CompleteResponse, error] {
	return func(yield func(*aiv1.CompleteResponse, error) bool) {
		var (
			toolCalls         []*aiv1.ModelToolCall
			lastUsage         *genai.GenerateContentResponseUsageMetadata
			sawAnyOutput      bool
			sawTerminalFinish bool
		)

		for chunk, err := range stream {
			if err != nil {
				yield(nil, fmt.Errorf("genai stream: %w", err))
				return
			}
			if chunk == nil {
				continue
			}
			text := chunk.Text()
			_, hasUpstreamFinish := terminalFinishReason(chunk)
			if hasUpstreamFinish {
				sawTerminalFinish = true
			}

			// Text part — forward immediately.
			if text != "" {
				sawAnyOutput = true
				if !yield(&aiv1.CompleteResponse{
					Event: &aiv1.CompleteResponse_TextDelta{
						TextDelta: &aiv1.TextDeltaEvent{Text: proto.String(text)},
					},
				}, nil) {
					return
				}
			}

			// Function call parts — buffer until the stream ends.
			chunkCalls, err := extractToolCalls(chunk)
			if err != nil {
				yield(nil, err)
				return
			}
			if len(chunkCalls) > 0 {
				sawAnyOutput = true
				toolCalls = append(toolCalls, chunkCalls...)
			}

			// UsageMetadata may arrive on any chunk (typically the last);
			// keep the latest observation so FinishedEvent carries a
			// complete picture.
			if chunk.UsageMetadata != nil {
				lastUsage = chunk.UsageMetadata
			}
		}

		if !sawAnyOutput {
			yield(nil, errors.New("gemini response did not include text or tool calls"))
			return
		}

		if !sawTerminalFinish {
			if ctx.Err() != nil {
				yield(nil, fmt.Errorf("gemini stream ended before terminal finish reason: %w", ctx.Err()))
				return
			}
			yield(nil, errors.New("gemini stream ended before terminal finish reason"))
			return
		}

		if len(toolCalls) > 0 {
			if !yield(&aiv1.CompleteResponse{
				Event: &aiv1.CompleteResponse_ToolCalls{
					ToolCalls: &aiv1.ToolCallsEvent{ToolCalls: toolCalls},
				},
			}, nil) {
				return
			}
		}

		finishReason := aiv1.FinishReason_FINISH_REASON_STOP
		if len(toolCalls) > 0 {
			finishReason = aiv1.FinishReason_FINISH_REASON_TOOL_CALLS
		}
		yield(&aiv1.CompleteResponse{
			Event: &aiv1.CompleteResponse_Finished{
				Finished: &aiv1.FinishedEvent{
					FinishReason: finishReason.Enum(),
					Usage:        extractUsage(lastUsage),
				},
			},
		}, nil)
	}
}

// buildContents flattens the proto chat history into genai's `[]*Content`
// shape. The single-message fast path mirrors the old behavior: when no
// history is provided, send `Message` (plus inline ContextFiles) as a
// single user turn.
func buildContents(input CompleteInput) ([]*genai.Content, error) {
	if len(input.Messages) == 0 {
		prompt := input.Message
		if len(input.ContextFiles) > 0 {
			prompt = fmt.Sprintf(
				"%s\n\n<context_files>\n%s\n</context_files>",
				input.Message,
				strings.Join(input.ContextFiles, "\n---\n"),
			)
		}
		return []*genai.Content{
			genai.NewContentFromText(prompt, genai.RoleUser),
		}, nil
	}

	contents := make([]*genai.Content, 0, len(input.Messages))
	for _, message := range input.Messages {
		if message == nil {
			continue
		}
		content, err := messageToContent(message)
		if err != nil {
			return nil, err
		}
		if content != nil && len(content.Parts) > 0 {
			contents = append(contents, content)
		}
	}
	if len(contents) == 0 {
		return nil, errors.New("completion request requires at least one message")
	}
	return contents, nil
}

// buildConfig wires the system instruction + tool declarations into a
// `*GenerateContentConfig`. SystemInstruction is always set so Gemini gets
// a deterministic role prompt even when the caller doesn't provide one.
func buildConfig(input CompleteInput) (*genai.GenerateContentConfig, error) {
	system := strings.TrimSpace(input.SystemPrompt)
	if system == "" {
		system = systemPrompt(input.Mode)
	}
	cfg := &genai.GenerateContentConfig{
		SystemInstruction: genai.NewContentFromText(system, genai.RoleUser),
		// Gemini 3 enables dynamic thinking by default (`thinkingLevel=HIGH`),
		// which reasons internally before emitting any output tokens — with
		// Flash Lite that stalls the whole response until the end and arrives
		// as a single stream chunk, defeating server streaming. LOW keeps a
		// little reasoning headroom without measurably delaying first token.
		// See https://ai.google.dev/gemini-api/docs/gemini-3 §Thinking.
		ThinkingConfig: &genai.ThinkingConfig{
			ThinkingLevel: genai.ThinkingLevelLow,
		},
	}

	declarations := make([]*genai.FunctionDeclaration, 0, len(input.Tools))
	for _, tool := range input.Tools {
		if tool == nil || strings.TrimSpace(tool.GetName()) == "" {
			continue
		}
		// Use ParametersJsonSchema (any) instead of Parameters (*Schema) —
		// our tool descriptors arrive as opaque JSON Schema maps from the
		// desktop runtime, and converting them through genai's `*Schema`
		// would lose extension fields the model side may rely on.
		declarations = append(declarations, &genai.FunctionDeclaration{
			Name:                 tool.GetName(),
			Description:          tool.GetDescription(),
			ParametersJsonSchema: parametersFromStruct(tool.GetParameters()),
		})
	}
	if len(declarations) > 0 {
		cfg.Tools = []*genai.Tool{{FunctionDeclarations: declarations}}
	}
	return cfg, nil
}

func messageToContent(message *aiv1.ChatMessage) (*genai.Content, error) {
	switch message.GetRole() {
	case aiv1.ChatMessageRole_CHAT_MESSAGE_ROLE_SYSTEM:
		// Gemini has a dedicated SystemInstruction slot on the request
		// (set in buildConfig), but in-history system messages still need
		// to land somewhere. Inline-prefix into a user turn so the model
		// sees the content while keeping role validity.
		if strings.TrimSpace(message.GetContent()) == "" {
			return nil, nil
		}
		return genai.NewContentFromText("System:\n"+message.GetContent(), genai.RoleUser), nil
	case aiv1.ChatMessageRole_CHAT_MESSAGE_ROLE_USER:
		if strings.TrimSpace(message.GetContent()) == "" {
			return nil, nil
		}
		return genai.NewContentFromText(message.GetContent(), genai.RoleUser), nil
	case aiv1.ChatMessageRole_CHAT_MESSAGE_ROLE_ASSISTANT:
		parts := make([]*genai.Part, 0, 1+len(message.GetToolCalls()))
		if content := message.GetContent(); content != "" {
			parts = append(parts, genai.NewPartFromText(content))
		}
		for _, call := range message.GetToolCalls() {
			if call == nil {
				continue
			}
			parts = append(parts, &genai.Part{
				FunctionCall: &genai.FunctionCall{
					ID:   firstNonEmpty(call.GetProviderCallId(), call.GetToolCallId(), call.GetCallId()),
					Name: call.GetToolName(),
					Args: structToMap(call.GetArguments()),
				},
				// Round-trip the opaque thought signature so multi-turn
				// tool-call conversations preserve provider state. Signature
				// is `bytes` on the wire so non-UTF-8 payloads round-trip
				// unchanged — no conversion needed here.
				ThoughtSignature: call.GetSignature(),
			})
		}
		return &genai.Content{Role: genai.RoleModel, Parts: parts}, nil
	case aiv1.ChatMessageRole_CHAT_MESSAGE_ROLE_TOOL_RESULT:
		id := firstNonEmpty(message.GetProviderCallId(), message.GetToolCallId(), message.GetCallId())
		return &genai.Content{
			Role: genai.RoleUser,
			Parts: []*genai.Part{{
				FunctionResponse: &genai.FunctionResponse{
					ID:   id,
					Name: message.GetToolName(),
					Response: map[string]any{
						"result":  message.GetContent(),
						"isError": message.GetIsError(),
					},
				},
			}},
		}, nil
	default:
		return nil, fmt.Errorf("unsupported chat message role: %s", message.GetRole())
	}
}

// extractToolCalls walks every candidate's parts and converts each
// FunctionCall into our proto `ModelToolCall`. We don't use the SDK's
// `FunctionCalls()` helper because it discards ThoughtSignature, which the
// desktop runtime needs to echo back on the next turn.
func extractToolCalls(response *genai.GenerateContentResponse) ([]*aiv1.ModelToolCall, error) {
	if response == nil {
		return nil, nil
	}
	var calls []*aiv1.ModelToolCall
	for _, candidate := range response.Candidates {
		if candidate == nil || candidate.Content == nil {
			continue
		}
		for index, part := range candidate.Content.Parts {
			if part == nil || part.FunctionCall == nil {
				continue
			}
			id := part.FunctionCall.ID
			if id == "" {
				id = newCallID(part.FunctionCall.Name, index)
			}
			args, err := structpb.NewStruct(part.FunctionCall.Args)
			if err != nil {
				return nil, fmt.Errorf("decode gemini function call arguments: %w", err)
			}
			calls = append(calls, &aiv1.ModelToolCall{
				CallId:    proto.String(id),
				ToolName:  proto.String(part.FunctionCall.Name),
				Arguments: args,
				// Pass ThoughtSignature through as-is — proto field is
				// `bytes`, not `string`, so no UTF-8 validation happens
				// during marshal and Gemini's raw binary survives.
				Signature:      part.ThoughtSignature,
				ToolCallId:     proto.String(id),
				ProviderCallId: proto.String(id),
			})
		}
	}
	return calls, nil
}

func extractUsage(meta *genai.GenerateContentResponseUsageMetadata) *aiv1.TokenUsage {
	if meta == nil {
		return nil
	}
	return &aiv1.TokenUsage{
		InputTokens:  proto.Uint64(uint64(meta.PromptTokenCount)),
		OutputTokens: proto.Uint64(uint64(meta.CandidatesTokenCount)),
		TotalTokens:  proto.Uint64(uint64(meta.TotalTokenCount)),
	}
}

func systemPrompt(mode aiv1.ConversationMode) string {
	switch mode {
	case aiv1.ConversationMode_CONVERSATION_MODE_AGENT:
		return "You are Kuku, a concise PKM assistant. Use the provided tools when they are helpful. The desktop app will execute tool calls and send the results back to you."
	case aiv1.ConversationMode_CONVERSATION_MODE_INLINE:
		return "You are Kuku, a concise writing assistant. Return only the edited or suggested text unless the user asks for explanation."
	default:
		return "You are Kuku, a concise PKM assistant. Answer directly."
	}
}

func parametersFromStruct(value *structpb.Struct) any {
	if value == nil {
		// Default to an empty object schema so Gemini accepts the
		// declaration even for zero-arg tools.
		return map[string]any{"type": "object"}
	}
	return value.AsMap()
}

func structToMap(value *structpb.Struct) map[string]any {
	if value == nil {
		return nil
	}
	return value.AsMap()
}

func newCallID(name string, index int) string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err == nil {
		return fmt.Sprintf("%s-%s", name, hex.EncodeToString(raw[:]))
	}
	return fmt.Sprintf("%s-%d", name, index)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func terminalFinishReason(response *genai.GenerateContentResponse) (genai.FinishReason, bool) {
	if response == nil {
		return genai.FinishReasonUnspecified, false
	}
	for _, candidate := range response.Candidates {
		if candidate == nil || isMissingFinishReason(candidate.FinishReason) {
			continue
		}
		return candidate.FinishReason, true
	}
	return genai.FinishReasonUnspecified, false
}

func isMissingFinishReason(reason genai.FinishReason) bool {
	return reason == "" || reason == genai.FinishReasonUnspecified
}
