use async_stream::stream;
use async_trait::async_trait;
use futures::StreamExt;
use rig::{
    OneOrMany,
    client::CompletionClient,
    completion::{AssistantContent, CompletionModel, GetTokenUsage, Message, ToolDefinition},
    message::{Text, ToolCall, ToolFunction},
    providers::gemini,
    streaming::StreamedAssistantContent,
};

use crate::{
    AiError,
    provider::{CompletionBackend, CompletionEvent, CompletionTurnRequest, CompletionTurnStream},
    tools::ToolDescriptor,
    types::{ChatMessage, FinishReason, ModelToolCall, TokenUsage},
};

pub struct GeminiBackend {
    client: gemini::Client,
    model_id: String,
}

impl GeminiBackend {
    pub fn new(api_key: &str, model: &str) -> Result<Self, AiError> {
        let client = gemini::Client::new(api_key)
            .map_err(|error| AiError::ProviderInit(error.to_string()))?;
        Ok(Self {
            client,
            model_id: model.to_string(),
        })
    }
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
            .tools(
                request
                    .tools
                    .into_iter()
                    .map(tool_definition_from)
                    .collect(),
            );

        if let Some(system_prompt) = request.system_prompt {
            builder = builder.preamble(system_prompt);
        }

        let stream = builder.stream().await?;

        let adapted = stream! {
            let mut inner = stream;
            let mut saw_tool_calls = false;
            let mut yielded_finished = false;

            while let Some(item) = inner.next().await {
                match item {
                    Err(error) => {
                        yield Err::<CompletionEvent, AiError>(error.into());
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

fn tool_definition_from(tool: ToolDescriptor) -> ToolDefinition {
    ToolDefinition {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
    }
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
    use rig::completion::{AssistantContent, Message, message::UserContent};

    use super::into_rig_message;
    use crate::types::{ChatMessage, ModelToolCall};

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
