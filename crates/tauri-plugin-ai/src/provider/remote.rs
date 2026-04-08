use async_stream::try_stream;
use async_trait::async_trait;
use serde::{Deserialize, Deserializer, Serialize, de};

use crate::{
    AiError,
    provider::{CompletionBackend, CompletionEvent, CompletionTurnRequest, CompletionTurnStream},
    tools::ToolDescriptor,
    types::{ChatMessage, FinishReason, ModelToolCall, TokenUsage},
};

pub struct RemoteBackend {
    base_url: String,
    model: String,
    client: reqwest::Client,
}

impl RemoteBackend {
    pub fn new(base_url: &str, model: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            model: model.to_string(),
            client: reqwest::Client::new(),
        }
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
        let endpoint = format!("{}/kuku.ai.v1.AIService/Complete", self.base_url);
        let body = CompleteRequest {
            mode: mode_name(&request),
            message: last_user_message(&request),
            context_files: Vec::new(),
            model: self.model.clone(),
            messages: request.messages.iter().map(remote_message_from).collect(),
            tools: request.tools.iter().map(remote_tool_from).collect(),
            system_prompt: request.system_prompt.clone().unwrap_or_default(),
        };
        let response = self
            .client
            .post(endpoint)
            .header("Authorization", authorization_header)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                AiError::ProviderError(format!("Remote AI request failed: {error}"))
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(AiError::ProviderError(format!(
                "Remote AI returned {status}: {}",
                truncate(&text, 512)
            )));
        }

        let text = response.text().await.map_err(|error| {
            AiError::ProviderError(format!("Remote AI response read failed: {error}"))
        })?;
        let output = serde_json::from_str::<CompleteResponse>(&text).map_err(|error| {
            AiError::ProviderError(format!(
                "Remote AI response decode failed: {error}. Body: {}",
                truncate(&text, 512)
            ))
        })?;

        let stream = try_stream! {
            if !output.text.is_empty() {
                yield CompletionEvent::TextDelta(output.text);
            }
            if !output.tool_calls.is_empty() {
                yield CompletionEvent::ToolCalls(output.tool_calls.into_iter().map(model_tool_call_from).collect());
            }
            yield CompletionEvent::Finished {
                finish_reason: finish_reason_from(&output.finish_reason),
                usage: output.usage.map(token_usage_from),
            };
        };

        Ok(Box::pin(stream))
    }

    async fn list_models(&self) -> Result<Vec<String>, AiError> {
        Ok(vec![self.model.clone()])
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompleteRequest {
    mode: &'static str,
    message: String,
    context_files: Vec<String>,
    model: String,
    messages: Vec<RemoteChatMessage>,
    tools: Vec<RemoteToolDescriptor>,
    system_prompt: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteResponse {
    #[serde(default)]
    text: String,
    #[serde(default)]
    tool_calls: Vec<RemoteModelToolCall>,
    #[serde(default)]
    finish_reason: String,
    usage: Option<RemoteTokenUsage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteChatMessage {
    role: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    content: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<RemoteModelToolCall>,
    #[serde(skip_serializing_if = "String::is_empty")]
    call_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    tool_name: String,
    is_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_call_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteToolDescriptor {
    name: String,
    description: String,
    parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteModelToolCall {
    call_id: String,
    tool_name: String,
    #[serde(default)]
    arguments: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_call_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTokenUsage {
    #[serde(default, deserialize_with = "deserialize_proto_u64")]
    input_tokens: u64,
    #[serde(default, deserialize_with = "deserialize_proto_u64")]
    output_tokens: u64,
    #[serde(default, deserialize_with = "deserialize_proto_u64")]
    total_tokens: u64,
    #[serde(default, deserialize_with = "deserialize_proto_u64")]
    cached_input_tokens: u64,
}

fn mode_name(request: &CompletionTurnRequest) -> &'static str {
    if request
        .system_prompt
        .as_deref()
        .is_some_and(|prompt| prompt.contains("Inline"))
    {
        return "CONVERSATION_MODE_INLINE";
    }
    if request
        .system_prompt
        .as_deref()
        .is_some_and(|prompt| prompt.contains("Ask mode"))
    {
        return "CONVERSATION_MODE_ASK";
    }
    if request.tools.is_empty() {
        return "CONVERSATION_MODE_ASK";
    }
    "CONVERSATION_MODE_AGENT"
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

fn remote_message_from(message: &ChatMessage) -> RemoteChatMessage {
    match message {
        ChatMessage::System { content } => RemoteChatMessage {
            role: "CHAT_MESSAGE_ROLE_SYSTEM",
            content: content.clone(),
            tool_calls: Vec::new(),
            call_id: String::new(),
            tool_name: String::new(),
            is_error: false,
            tool_call_id: None,
            provider_call_id: None,
        },
        ChatMessage::User { content, .. } => RemoteChatMessage {
            role: "CHAT_MESSAGE_ROLE_USER",
            content: content.clone(),
            tool_calls: Vec::new(),
            call_id: String::new(),
            tool_name: String::new(),
            is_error: false,
            tool_call_id: None,
            provider_call_id: None,
        },
        ChatMessage::Assistant {
            content,
            tool_calls,
        } => RemoteChatMessage {
            role: "CHAT_MESSAGE_ROLE_ASSISTANT",
            content: content.clone(),
            tool_calls: tool_calls.iter().map(remote_model_tool_call_from).collect(),
            call_id: String::new(),
            tool_name: String::new(),
            is_error: false,
            tool_call_id: None,
            provider_call_id: None,
        },
        ChatMessage::ToolResult {
            call_id,
            tool_name,
            output,
            is_error,
            tool_call_id,
            provider_call_id,
        } => RemoteChatMessage {
            role: "CHAT_MESSAGE_ROLE_TOOL_RESULT",
            content: output.clone(),
            tool_calls: Vec::new(),
            call_id: call_id.clone(),
            tool_name: tool_name.clone(),
            is_error: *is_error,
            tool_call_id: tool_call_id.clone(),
            provider_call_id: provider_call_id.clone(),
        },
    }
}

fn remote_tool_from(tool: &ToolDescriptor) -> RemoteToolDescriptor {
    RemoteToolDescriptor {
        name: tool.name.clone(),
        description: tool.description.clone(),
        parameters: tool.parameters.clone(),
    }
}

fn remote_model_tool_call_from(call: &ModelToolCall) -> RemoteModelToolCall {
    RemoteModelToolCall {
        call_id: call.call_id.clone(),
        tool_name: call.tool_name.clone(),
        arguments: call.arguments.clone(),
        signature: call.signature.clone(),
        tool_call_id: call.tool_call_id.clone(),
        provider_call_id: call.provider_call_id.clone(),
    }
}

fn model_tool_call_from(call: RemoteModelToolCall) -> ModelToolCall {
    ModelToolCall {
        call_id: call.call_id,
        tool_name: call.tool_name,
        arguments: call.arguments,
        signature: call.signature,
        tool_call_id: call.tool_call_id,
        provider_call_id: call.provider_call_id,
    }
}

fn finish_reason_from(value: &str) -> FinishReason {
    match value {
        "FINISH_REASON_TOOL_CALLS" => FinishReason::ToolCalls,
        _ => FinishReason::Stop,
    }
}

fn token_usage_from(usage: RemoteTokenUsage) -> TokenUsage {
    TokenUsage {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
        cached_input_tokens: usage.cached_input_tokens,
    }
}

fn deserialize_proto_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum ProtoU64 {
        Number(u64),
        String(String),
    }

    let value = Option::<ProtoU64>::deserialize(deserializer)?;
    match value {
        Some(ProtoU64::Number(value)) => Ok(value),
        Some(ProtoU64::String(value)) if value.is_empty() => Ok(0),
        Some(ProtoU64::String(value)) => value.parse::<u64>().map_err(de::Error::custom),
        None => Ok(0),
    }
}

fn truncate(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    format!("{}...", &value[..limit])
}
