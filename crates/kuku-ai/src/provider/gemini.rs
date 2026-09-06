use async_stream::stream;
use async_trait::async_trait;
use futures::StreamExt;
use rig::{
    OneOrMany,
    client::CompletionClient,
    completion::{AssistantContent, CompletionModel, GetTokenUsage, Message},
    message::{Text, ToolCall, ToolFunction},
    providers::gemini,
    streaming::StreamedAssistantContent,
};
use std::sync::Arc;

use crate::{
    AiError,
    provider::{CompletionBackend, CompletionEvent, CompletionTurnRequest, CompletionTurnStream},
    tools::ToolDescriptor,
    types::{ChatMessage, FinishReason, ModelToolCall, TokenUsage},
};

pub struct GeminiBackend {
    client: gemini::Client,
    model_id: String,
    // rig authenticates in the request URL. Keep the value only in native
    // memory so transport/provider errors can be redacted before IPC emission.
    api_key: Arc<str>,
}

impl GeminiBackend {
    pub fn new(api_key: &str, model: &str) -> Result<Self, AiError> {
        let client = gemini::Client::new(api_key)
            .map_err(|error| AiError::ProviderInit(redact_error(error, api_key)))?;
        Ok(Self {
            client,
            model_id: model.to_string(),
            api_key: Arc::from(api_key),
        })
    }
}

fn redact_error(error: impl std::fmt::Display, api_key: &str) -> String {
    let message = error.to_string();
    let message = if api_key.is_empty() {
        message
    } else {
        message.replace(api_key, "[REDACTED]")
    };
    // Also redact URL-encoded credentials without depending on how the HTTP
    // error formatted its URL. Keep the model path, HTTP status, and provider
    // response intact so missing models, rate limits, and bad schemas remain
    // actionable. This covers repeated URLs and either query parameter order.
    let mut output = String::with_capacity(message.len());
    let mut remaining = message.as_str();
    while let Some(index) = remaining.as_bytes().windows(5).position(|value| {
        value.eq_ignore_ascii_case(b"?key=") || value.eq_ignore_ascii_case(b"&key=")
    }) {
        output.push_str(&remaining[..index + 5]);
        output.push_str("[REDACTED]");
        let value = &remaining[index + 5..];
        let end = value
            .find(|ch: char| {
                ch.is_whitespace() || matches!(ch, '&' | '#' | '"' | '\'' | ')' | '<' | '>' | '\\')
            })
            .unwrap_or(value.len());
        remaining = &value[end..];
    }
    output.push_str(remaining);
    output
}

#[async_trait]
impl CompletionBackend for GeminiBackend {
    async fn stream_turn(
        &self,
        request: CompletionTurnRequest,
    ) -> Result<CompletionTurnStream, AiError> {
        // The desktop build pins the Gemini SKU in AiConfig. Per-turn model
        // overrides are ignored so no caller can drift away from that default.
        let model_name = self.model_id.clone();
        let model = self.client.completion_model(model_name.clone());

        let (history, prompt) = split_history(request.messages)?;
        let mut builder = model
            .completion_request(prompt)
            .messages(history)
            .model(model_name)
            .additional_params(function_parameters(request.tools));

        if let Some(system_prompt) = request.system_prompt {
            builder = builder.preamble(system_prompt);
        }

        let stream = builder
            .stream()
            .await
            .map_err(|error| AiError::ProviderError(redact_error(error, &self.api_key)))?;
        let api_key = self.api_key.clone();

        let adapted = stream! {
            let mut inner = stream;
            let mut saw_tool_calls = false;
            let mut yielded_finished = false;

            while let Some(item) = inner.next().await {
                match item {
                    Err(error) => {
                        yield Err::<CompletionEvent, AiError>(AiError::ProviderError(redact_error(error, &api_key)));
                        break;
                    }
                    Ok(StreamedAssistantContent::Text(Text { text })) => {
                        if !text.is_empty() {
                            yield Ok(CompletionEvent::TextDelta(text));
                        }
                    }
                    Ok(StreamedAssistantContent::ToolCall {
                        tool_call,
                        internal_call_id,
                    }) => {
                        saw_tool_calls = true;
                        yield Ok(CompletionEvent::ToolCalls(vec![ModelToolCall {
                            call_id: internal_call_id,
                            tool_name: tool_call.function.name,
                            arguments: tool_call.function.arguments,
                            // rig still models the signature as a String
                            // (it was before we realized Gemini hands
                            // them out as binary). Round-trip the raw
                            // bytes as-is so the server-side proto
                            // marshal doesn't re-validate UTF-8.
                            signature: tool_call.signature.map(String::into_bytes),
                            tool_call_id: Some(tool_call.id),
                            provider_call_id: tool_call.call_id,
                        }]));
                    }
                    Ok(StreamedAssistantContent::ToolCallDelta { .. }) => {}
                    Ok(StreamedAssistantContent::Reasoning(_)) => {}
                    Ok(StreamedAssistantContent::ReasoningDelta { .. }) => {}
                    Ok(StreamedAssistantContent::Final(response)) => {
                        yielded_finished = true;
                        yield Ok(CompletionEvent::Finished {
                            finish_reason: if saw_tool_calls {
                                FinishReason::ToolCalls
                            } else {
                                FinishReason::Stop
                            },
                            usage: GetTokenUsage::token_usage(&response).map(into_token_usage),
                        });
                    }
                }
            }

            if !yielded_finished {
                yield Ok(CompletionEvent::Finished {
                    finish_reason: if saw_tool_calls {
                        FinishReason::ToolCalls
                    } else {
                        FinishReason::Stop
                    },
                    usage: None,
                });
            }
        };

        Ok(Box::pin(adapted))
    }

    async fn list_models(&self) -> Result<Vec<String>, AiError> {
        Ok(vec![
            "gemini-2.5-flash".to_string(),
            "gemini-2.5-pro".to_string(),
            "gemini-2.0-flash".to_string(),
        ])
    }
}

fn split_history(messages: Vec<ChatMessage>) -> Result<(Vec<Message>, Message), AiError> {
    let mut iter = messages.into_iter();
    let Some(last) = iter.next_back() else {
        return Err(AiError::InvalidArguments(
            "Completion request requires at least one message".to_string(),
        ));
    };

    let history = iter
        .map(into_rig_message)
        .collect::<Result<Vec<_>, AiError>>()?;
    let prompt = into_rig_message(last)?;
    Ok((history, prompt))
}

// rig 0.32's OpenAPI Schema conversion drops JSON Schema composition and can
// serialize enum/const-only members with an empty type. Send Google's native
// JSON Schema field instead. Keep the registry schema intact: local validation
// and mutation approval remain authoritative even for provider-ignored keywords.
// Do not also populate builder.tools(), which would duplicate the wire field.
fn function_parameters(tools: Vec<ToolDescriptor>) -> serde_json::Value {
    if tools.is_empty() {
        return serde_json::json!({});
    }
    let declarations: Vec<_> = tools
        .into_iter()
        .map(|tool| {
            let mut declaration = serde_json::json!({
                "name": tool.name,
                "description": tool.description,
            });
            if !parameterless_schema(&tool.parameters) {
                declaration["parametersJsonSchema"] = tool.parameters;
            }
            declaration
        })
        .collect();
    serde_json::json!({"tools": [{"functionDeclarations": declarations}]})
}

fn parameterless_schema(schema: &serde_json::Value) -> bool {
    let Some(object) = schema.as_object() else {
        return false;
    };
    object.get("type").and_then(serde_json::Value::as_str) == Some("object")
        && object.get("properties").is_none_or(|value| {
            value
                .as_object()
                .is_some_and(|properties| properties.is_empty())
        })
        && object
            .get("required")
            .is_none_or(|value| value.as_array().is_some_and(|required| required.is_empty()))
        && object
            .get("additionalProperties")
            .is_none_or(|value| value == false)
        && object.keys().all(|key| {
            matches!(
                key.as_str(),
                "type"
                    | "properties"
                    | "required"
                    | "additionalProperties"
                    | "description"
                    | "title"
                    | "$schema"
            )
        })
}

fn into_token_usage(usage: rig::completion::Usage) -> TokenUsage {
    TokenUsage {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
        cached_input_tokens: usage.cached_input_tokens,
    }
}

fn into_rig_message(message: ChatMessage) -> Result<Message, AiError> {
    Ok(match message {
        ChatMessage::System { .. } => {
            return Err(AiError::InvalidArguments(
                "System messages should be passed via the system prompt".to_string(),
            ));
        }
        ChatMessage::User { content, .. } => Message::user(content),
        ChatMessage::ToolResult {
            call_id,
            output,
            tool_call_id,
            provider_call_id,
            ..
        } => {
            let tool_result_id = tool_call_id.unwrap_or(call_id.clone());
            match provider_call_id {
                Some(provider_call_id) => Message::tool_result_with_call_id(
                    tool_result_id,
                    Some(provider_call_id),
                    output,
                ),
                None => Message::tool_result(tool_result_id, output),
            }
        }
        ChatMessage::Assistant {
            content,
            tool_calls,
        } => {
            let mut items = Vec::new();
            if !content.is_empty() {
                items.push(AssistantContent::Text(Text { text: content }));
            }

            for tool_call in tool_calls {
                items.push(AssistantContent::ToolCall(ToolCall {
                    id: tool_call
                        .tool_call_id
                        .clone()
                        .unwrap_or_else(|| tool_call.call_id.clone()),
                    call_id: tool_call
                        .provider_call_id
                        .clone()
                        .or_else(|| Some(tool_call.call_id.clone())),
                    function: ToolFunction::new(tool_call.tool_name, tool_call.arguments),
                    // Convert our raw bytes back into rig's String
                    // signature. Gemini's actual bytes aren't guaranteed
                    // UTF-8, but rig's Gemini backend ultimately wants a
                    // String — `from_utf8_lossy` keeps the round-trip
                    // alive by replacing any invalid byte with U+FFFD.
                    // In practice Gemini's signatures we've observed are
                    // ASCII-only; the lossy fallback exists only so a
                    // future Gemini change can't crash the conversion.
                    signature: tool_call
                        .signature
                        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()),
                    additional_params: None,
                }));
            }

            let content = OneOrMany::many(items).map_err(|_| {
                AiError::InvalidArguments("Assistant message cannot be empty".to_string())
            })?;

            Message::Assistant { id: None, content }
        }
    })
}

#[cfg(test)]
mod tests {
    use rig::completion::{AssistantContent, CompletionError, Message, message::UserContent};
    use serde_json::json;

    use super::{function_parameters, into_rig_message, redact_error};
    use crate::tools::{ToolAccess, ToolDescriptor, ToolSource};
    use crate::types::{ChatMessage, ModelToolCall};

    fn planner_tool(name: &str, parameters: serde_json::Value) -> ToolDescriptor {
        ToolDescriptor {
            name: name.into(),
            tool_id: format!("planner.{name}"),
            description: "Planner mutation".into(),
            category: "planner".into(),
            access: ToolAccess::ProposesMutation,
            source: ToolSource::Proxy,
            parameters,
        }
    }

    #[test]
    fn native_json_schema_preserves_unions_nulls_and_constraints_on_wire() {
        use rig::providers::gemini::completion::gemini_api_types::{
            AdditionalParameters, GenerateContentRequest,
        };
        let parameters = json!({
            "type": "object", "properties": {
                "calendar_ref": {"type": ["string", "null"]},
                "effect": {"oneOf": [{"type": "null"}, {"enum": ["soft", "hard"]}]},
                "edit": {"oneOf": [
                    {"type": "object", "properties": {"kind": {"const": "replace"}}},
                    {"type": "object", "properties": {"kind": {"const": "insert"}}}
                ]}
            },
            "required": ["calendar_ref"], "additionalProperties": false
        });
        let descriptor = planner_tool("task_update", parameters.clone());
        let extra = function_parameters(vec![descriptor.clone()]);
        // Exercise the pinned rig request's actual flatten/skip serialization.
        let parsed: AdditionalParameters = serde_json::from_value(extra).unwrap();
        let request = GenerateContentRequest {
            contents: vec![],
            tools: None,
            tool_config: None,
            generation_config: parsed.generation_config,
            safety_settings: None,
            system_instruction: None,
            additional_params: parsed.additional_params,
        };
        let wire = serde_json::to_string(&request).unwrap();
        assert_eq!(wire.matches("\"tools\":").count(), 1);
        let wire: serde_json::Value = serde_json::from_str(&wire).unwrap();
        let declaration = &wire["tools"][0]["functionDeclarations"][0];
        assert_eq!(declaration["parametersJsonSchema"], parameters);
        assert!(declaration.get("parameters").is_none());
        assert_eq!(descriptor.parameters, parameters);
    }

    #[test]
    fn native_json_schema_omits_only_truly_parameterless_arguments() {
        let empty = json!({
            "type": "object", "properties": {}, "required": [], "additionalProperties": false
        });
        let extra = function_parameters(vec![planner_tool("list", empty)]);
        assert!(
            extra["tools"][0]["functionDeclarations"][0]
                .get("parametersJsonSchema")
                .is_none()
        );
        for parameters in [
            json!({"type":"object","properties":{"query":{"type":"string"}},"required":[]}),
            json!({"type":"object","properties":{},"additionalProperties":{"type":"string"}}),
        ] {
            let extra = function_parameters(vec![planner_tool("query", parameters.clone())]);
            assert_eq!(
                extra["tools"][0]["functionDeclarations"][0]["parametersJsonSchema"],
                parameters
            );
        }
        assert_eq!(function_parameters(vec![]), json!({}));
    }

    #[test]
    fn transport_error_redacts_query_key_without_losing_model_or_failure_reason() {
        let key = "synthetic-gemini-key";
        let error = CompletionError::ProviderError(format!(
            "error sending request for url (https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse&key={key}): connection timed out"
        ));
        let safe = redact_error(error, key);
        assert!(!safe.contains(key));
        assert!(safe.contains("models/gemini-test:streamGenerateContent"));
        assert!(safe.contains("&key=[REDACTED]"));
        assert!(safe.contains("connection timed out"));
    }

    #[test]
    fn stream_provider_error_redacts_encoded_and_repeated_query_keys() {
        let error = CompletionError::ProviderError(
            "Invalid status code 404 Not Found: model gemini-unavailable is not supported; URLs \"https://example.test/models/gemini-unavailable?key=%73ecret&alt=sse\" and (https://example.test/?alt=sse&KEY=other%2Dencoded). Credential: synthetic-key".into(),
        );
        let safe = redact_error(error, "synthetic-key");
        assert!(!safe.contains("%73ecret"));
        assert!(!safe.contains("other%2Dencoded"));
        assert!(!safe.contains("synthetic-key"));
        assert!(safe.contains("404 Not Found"));
        assert!(safe.contains("gemini-unavailable is not supported"));
        assert!(safe.contains("?key=[REDACTED]&alt=sse"));
        assert!(safe.contains("&KEY=[REDACTED])"));
    }

    #[test]
    fn provider_diagnostics_without_credentials_are_preserved() {
        let error = "429 RESOURCE_EXHAUSTED: quota exceeded for model gemini-test";
        assert_eq!(redact_error(error, "synthetic-key"), error);
        assert_eq!(
            redact_error("Invalid API credential", ""),
            "Invalid API credential"
        );
    }

    #[test]
    fn tool_result_uses_original_tool_call_ids() {
        let message = ChatMessage::ToolResult {
            call_id: "internal-call".into(),
            tool_name: "list_files".into(),
            output: "{\"files\":[]}".into(),
            is_error: false,
            tool_call_id: Some("gemini-tool-id".into()),
            provider_call_id: Some("provider-call-id".into()),
        };

        let rig_message = into_rig_message(message).expect("tool result should convert");

        let Message::User { content } = rig_message else {
            panic!("tool result should convert into a user message");
        };
        let Some(UserContent::ToolResult(tool_result)) = content.iter().next() else {
            panic!("user message should contain a tool result");
        };

        assert_eq!(tool_result.id, "gemini-tool-id");
        assert_eq!(tool_result.call_id.as_deref(), Some("provider-call-id"));
    }

    #[test]
    fn tool_result_without_provider_call_id_still_uses_tool_call_id() {
        let message = ChatMessage::ToolResult {
            call_id: "internal-call".into(),
            tool_name: "list_files".into(),
            output: "plain text".into(),
            is_error: false,
            tool_call_id: Some("gemini-tool-id".into()),
            provider_call_id: None,
        };

        let rig_message = into_rig_message(message).expect("tool result should convert");

        let Message::User { content } = rig_message else {
            panic!("tool result should convert into a user message");
        };
        let Some(UserContent::ToolResult(tool_result)) = content.iter().next() else {
            panic!("user message should contain a tool result");
        };

        assert_eq!(tool_result.id, "gemini-tool-id");
        assert_eq!(tool_result.call_id, None);
    }

    #[test]
    fn assistant_tool_call_preserves_signature() {
        let message = ChatMessage::Assistant {
            content: String::new(),
            tool_calls: vec![ModelToolCall {
                call_id: "internal-call".into(),
                tool_name: "list_files".into(),
                arguments: serde_json::json!({ "path": "" }),
                signature: Some(b"sig-123".to_vec()),
                tool_call_id: Some("gemini-tool-id".into()),
                provider_call_id: Some("provider-call-id".into()),
            }],
        };

        let rig_message = into_rig_message(message).expect("assistant tool call should convert");

        let Message::Assistant { content, .. } = rig_message else {
            panic!("assistant tool call should convert into an assistant message");
        };
        let Some(AssistantContent::ToolCall(tool_call)) = content.iter().next() else {
            panic!("assistant message should contain a tool call");
        };

        assert_eq!(tool_call.id, "gemini-tool-id");
        assert_eq!(tool_call.call_id.as_deref(), Some("provider-call-id"));
        assert_eq!(tool_call.signature.as_deref(), Some("sig-123"));
    }
}
