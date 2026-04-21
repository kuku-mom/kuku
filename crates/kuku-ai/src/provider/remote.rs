use async_stream::try_stream;
use async_trait::async_trait;

use connectrpc::ErrorCode;
use connectrpc::client::{CallOptions, HttpClient};
use kuku_contract::connect::kuku::ai::v1::AiServiceClient;
use kuku_contract::proto::kuku::ai::v1::{
    self as aiv1, ChatMessage as ProtoChatMessage, ChatMessageRole, CompleteRequest,
    ConversationMode, FinishReason as ProtoFinishReason, ModelToolCall as ProtoModelToolCall,
    ToolDescriptor as ProtoToolDescriptor, complete_response::Event as ProtoCompleteEvent,
};

use crate::{
    AiError,
    contract::build_ai_service_client,
    provider::{CompletionBackend, CompletionEvent, CompletionTurnRequest, CompletionTurnStream},
    tools::ToolDescriptor,
    types::{ChatMessage, FinishReason, ModelToolCall, TokenUsage},
};

pub struct RemoteBackend {
    model: String,
    client: AiServiceClient<HttpClient>,
}

impl RemoteBackend {
    pub fn new(base_url: &str, model: &str) -> Result<Self, AiError> {
        let client = build_ai_service_client(base_url).map_err(AiError::ProviderInit)?;
        Ok(Self {
            model: model.to_string(),
            client,
        })
    }
}

#[async_trait]
impl CompletionBackend for RemoteBackend {
    async fn stream_turn(
        &self,
        request: CompletionTurnRequest,
    ) -> Result<CompletionTurnStream, AiError> {
        let authorization_header = request
            .authorization_header
            .clone()
            .ok_or(AiError::NotConfigured)?;

        let proto_request = CompleteRequest {
            mode: Some(kuku_contract::buffa::EnumValue::Known(mode_for(&request))),
            message: Some(last_user_message(&request)),
            context_files: Vec::new(),
            model: Some(self.model.clone()),
            messages: request
                .messages
                .iter()
                .map(proto_message_from)
                .collect::<Result<Vec<_>, _>>()?,
            tools: request
                .tools
                .iter()
                .map(proto_tool_from)
                .collect::<Result<Vec<_>, _>>()?,
            system_prompt: request.system_prompt.clone(),
            ..Default::default()
        };

        let options = CallOptions::default().with_header("authorization", authorization_header);

        let mut server_stream = self
            .client
            .complete_with_options(proto_request, options)
            .await
            .map_err(connect_to_ai_error)?;

        // Translate the proto CompleteResponse event stream into the local
        // CompletionEvent enum as messages arrive. No batching — each proto
        // event yields exactly one CompletionEvent, preserving the server's
        // ordering (text deltas → tool calls → finished).
        let stream = try_stream! {
            let mut saw_finished = false;
            while let Some(view) = server_stream
                .message()
                .await
                .map_err(connect_to_ai_error)?
            {
                let message = view.to_owned_message();
                if let Some(event) = completion_event_from_proto_message(message, &mut saw_finished)? {
                    yield event;
                }
            }

            ensure_finished_event(saw_finished)?;
        };

        Ok(Box::pin(stream))
    }

    async fn list_models(&self) -> Result<Vec<String>, AiError> {
        Ok(vec![self.model.clone()])
    }
}

fn mode_for(request: &CompletionTurnRequest) -> ConversationMode {
    if request
        .system_prompt
        .as_deref()
        .is_some_and(|prompt| prompt.contains("Inline"))
    {
        return ConversationMode::CONVERSATION_MODE_INLINE;
    }
    if request
        .system_prompt
        .as_deref()
        .is_some_and(|prompt| prompt.contains("Ask mode"))
    {
        return ConversationMode::CONVERSATION_MODE_ASK;
    }
    if request.tools.is_empty() {
        return ConversationMode::CONVERSATION_MODE_ASK;
    }
    ConversationMode::CONVERSATION_MODE_AGENT
}

fn last_user_message(request: &CompletionTurnRequest) -> String {
    request
        .messages
        .iter()
        .rev()
        .find_map(|message| match message {
            ChatMessage::User { content, .. } => Some(content.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

fn proto_message_from(message: &ChatMessage) -> Result<ProtoChatMessage, AiError> {
    let role = match message {
        ChatMessage::System { .. } => ChatMessageRole::CHAT_MESSAGE_ROLE_SYSTEM,
        ChatMessage::User { .. } => ChatMessageRole::CHAT_MESSAGE_ROLE_USER,
        ChatMessage::Assistant { .. } => ChatMessageRole::CHAT_MESSAGE_ROLE_ASSISTANT,
        ChatMessage::ToolResult { .. } => ChatMessageRole::CHAT_MESSAGE_ROLE_TOOL_RESULT,
    };
    let mut proto = ProtoChatMessage {
        role: Some(kuku_contract::buffa::EnumValue::Known(role)),
        ..Default::default()
    };
    match message {
        ChatMessage::System { content } | ChatMessage::User { content, .. } => {
            proto.content = Some(content.clone());
        }
        ChatMessage::Assistant {
            content,
            tool_calls,
        } => {
            if !content.is_empty() {
                proto.content = Some(content.clone());
            }
            proto.tool_calls = tool_calls
                .iter()
                .map(proto_model_tool_call_from)
                .collect::<Result<Vec<_>, _>>()?;
        }
        ChatMessage::ToolResult {
            call_id,
            tool_name,
            output,
            is_error,
            tool_call_id,
            provider_call_id,
        } => {
            proto.content = Some(output.clone());
            proto.call_id = Some(call_id.clone());
            proto.tool_name = Some(tool_name.clone());
            proto.is_error = Some(*is_error);
            proto.tool_call_id = tool_call_id.clone();
            proto.provider_call_id = provider_call_id.clone();
        }
    }
    Ok(proto)
}

fn proto_tool_from(tool: &ToolDescriptor) -> Result<ProtoToolDescriptor, AiError> {
    Ok(ProtoToolDescriptor {
        name: Some(tool.name.clone()),
        description: Some(tool.description.clone()),
        parameters: kuku_contract::buffa::MessageField::some(json_to_struct(
            tool.parameters.clone(),
        )?),
        ..Default::default()
    })
}

fn proto_model_tool_call_from(call: &ModelToolCall) -> Result<ProtoModelToolCall, AiError> {
    Ok(ProtoModelToolCall {
        call_id: Some(call.call_id.clone()),
        tool_name: Some(call.tool_name.clone()),
        arguments: kuku_contract::buffa::MessageField::some(json_to_struct(
            call.arguments.clone(),
        )?),
        signature: call.signature.clone(),
        tool_call_id: call.tool_call_id.clone(),
        provider_call_id: call.provider_call_id.clone(),
        ..Default::default()
    })
}

fn model_tool_call_from(call: ProtoModelToolCall) -> Result<ModelToolCall, AiError> {
    let arguments = call
        .arguments
        .into_option()
        .map(struct_to_json)
        .unwrap_or(serde_json::Value::Null);
    Ok(ModelToolCall {
        call_id: call.call_id.unwrap_or_default(),
        tool_name: call.tool_name.unwrap_or_default(),
        arguments,
        signature: call.signature,
        tool_call_id: call.tool_call_id,
        provider_call_id: call.provider_call_id,
    })
}

fn connect_to_ai_error(error: connectrpc::ConnectError) -> AiError {
    match error.code {
        ErrorCode::Unauthenticated => AiError::Unauthorized,
        _ => AiError::ProviderError(format!(
            "Remote AI request failed: {}",
            error.message.unwrap_or_else(|| format!("{:?}", error.code))
        )),
    }
}

fn finish_reason_from(
    value: Option<kuku_contract::buffa::EnumValue<ProtoFinishReason>>,
) -> FinishReason {
    match value {
        Some(kuku_contract::buffa::EnumValue::Known(
            ProtoFinishReason::FINISH_REASON_TOOL_CALLS,
        )) => FinishReason::ToolCalls,
        _ => FinishReason::Stop,
    }
}

fn token_usage_from(usage: aiv1::TokenUsage) -> TokenUsage {
    TokenUsage {
        input_tokens: usage.input_tokens.unwrap_or_default(),
        output_tokens: usage.output_tokens.unwrap_or_default(),
        total_tokens: usage.total_tokens.unwrap_or_default(),
        cached_input_tokens: usage.cached_input_tokens.unwrap_or_default(),
    }
}

// `google.protobuf.Struct` and `serde_json::Value` represent the same JSON
// shape but are distinct Rust types. The proto Struct has serde Serialize/
// Deserialize impls that match standard JSON, so a serde round-trip is the
// simplest correct conversion. Cost is one allocation per tool call —
// negligible vs the network hop.
fn json_to_struct(
    value: serde_json::Value,
) -> Result<kuku_contract::buffa_types::google::protobuf::Struct, AiError> {
    serde_json::from_value(value).map_err(|error| {
        AiError::InvalidArguments(format!(
            "tool parameters not encodable as proto Struct: {error}"
        ))
    })
}

fn struct_to_json(
    value: kuku_contract::buffa_types::google::protobuf::Struct,
) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

fn completion_event_from_proto_message(
    message: aiv1::CompleteResponse,
    saw_finished: &mut bool,
) -> Result<Option<CompletionEvent>, AiError> {
    let Some(event) = message.event else {
        return Ok(None);
    };
    match event {
        ProtoCompleteEvent::TextDelta(delta) => {
            let delta = *delta;
            Ok(delta
                .text
                .filter(|text| !text.is_empty())
                .map(CompletionEvent::TextDelta))
        }
        ProtoCompleteEvent::ToolCalls(batch) => {
            let batch = *batch;
            if batch.tool_calls.is_empty() {
                return Ok(None);
            }
            let calls = batch
                .tool_calls
                .into_iter()
                .map(model_tool_call_from)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Some(CompletionEvent::ToolCalls(calls)))
        }
        ProtoCompleteEvent::Finished(finished) => {
            let finished = *finished;
            *saw_finished = true;
            Ok(Some(CompletionEvent::Finished {
                finish_reason: finish_reason_from(finished.finish_reason),
                usage: finished.usage.into_option().map(token_usage_from),
            }))
        }
    }
}

fn ensure_finished_event(saw_finished: bool) -> Result<(), AiError> {
    if saw_finished {
        return Ok(());
    }
    Err(AiError::ProviderError(
        "remote stream ended without finished event".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        ProtoCompleteEvent, completion_event_from_proto_message, ensure_finished_event,
        finish_reason_from,
    };
    use crate::{AiError, provider::CompletionEvent, types::FinishReason};
    use kuku_contract::proto::kuku::ai::v1::{
        self as aiv1, CompleteResponse, FinishedEvent, ModelToolCall, TextDeltaEvent,
        ToolCallsEvent,
    };

    #[test]
    fn proto_messages_preserve_event_order_until_finished() {
        let mut saw_finished = false;
        let mut events = Vec::new();

        for message in [
            CompleteResponse {
                event: Some(ProtoCompleteEvent::TextDelta(Box::new(TextDeltaEvent {
                    text: Some("alpha".to_string()),
                    ..Default::default()
                }))),
                ..Default::default()
            },
            CompleteResponse {
                event: Some(ProtoCompleteEvent::ToolCalls(Box::new(ToolCallsEvent {
                    tool_calls: vec![ModelToolCall {
                        call_id: Some("call-1".to_string()),
                        tool_name: Some("read_file".to_string()),
                        ..Default::default()
                    }],
                    ..Default::default()
                }))),
                ..Default::default()
            },
            CompleteResponse {
                event: Some(ProtoCompleteEvent::Finished(Box::new(FinishedEvent {
                    finish_reason: Some(kuku_contract::buffa::EnumValue::Known(
                        aiv1::FinishReason::FINISH_REASON_TOOL_CALLS,
                    )),
                    ..Default::default()
                }))),
                ..Default::default()
            },
        ] {
            if let Some(event) = completion_event_from_proto_message(message, &mut saw_finished)
                .expect("proto message should convert")
            {
                events.push(event);
            }
        }

        ensure_finished_event(saw_finished).expect("finished event should be required");

        assert_eq!(events.len(), 3);
        match &events[0] {
            CompletionEvent::TextDelta(text) => assert_eq!(text, "alpha"),
            event => panic!("unexpected first event: {event:?}"),
        }
        match &events[1] {
            CompletionEvent::ToolCalls(calls) => {
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].tool_name, "read_file");
            }
            event => panic!("unexpected second event: {event:?}"),
        }
        match &events[2] {
            CompletionEvent::Finished { finish_reason, .. } => {
                assert_eq!(*finish_reason, FinishReason::ToolCalls);
            }
            event => panic!("unexpected third event: {event:?}"),
        }
    }

    #[test]
    fn missing_finished_event_is_rejected() {
        let mut saw_finished = false;
        let message = CompleteResponse {
            event: Some(ProtoCompleteEvent::TextDelta(Box::new(TextDeltaEvent {
                text: Some("partial".to_string()),
                ..Default::default()
            }))),
            ..Default::default()
        };

        let event = completion_event_from_proto_message(message, &mut saw_finished)
            .expect("text delta should convert");
        assert!(matches!(event, Some(CompletionEvent::TextDelta(_))));

        let error = ensure_finished_event(saw_finished).expect_err("missing finish must error");
        assert!(matches!(
            error,
            AiError::ProviderError(message) if message == "remote stream ended without finished event"
        ));
    }

    #[test]
    fn finish_reason_defaults_to_stop() {
        assert_eq!(finish_reason_from(None), FinishReason::Stop);
    }
}
