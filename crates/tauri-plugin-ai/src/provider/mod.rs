use std::pin::Pin;

use async_trait::async_trait;
use futures::Stream;

use crate::{
    AiError,
    tools::ToolDescriptor,
    types::{ChatMessage, FinishReason, ModelToolCall, TokenUsage},
};

pub mod gemini;
pub mod remote;

#[derive(Debug, Clone)]
pub struct CompletionTurnRequest {
    pub model: String,
    pub system_prompt: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDescriptor>,
    pub authorization_header: Option<String>,
}

#[derive(Debug, Clone)]
pub enum CompletionEvent {
    TextDelta(String),
    ToolCalls(Vec<ModelToolCall>),
    Finished {
        finish_reason: FinishReason,
        usage: Option<TokenUsage>,
    },
}

pub type CompletionTurnStream =
    Pin<Box<dyn Stream<Item = Result<CompletionEvent, AiError>> + Send>>;

#[async_trait]
pub trait CompletionBackend: Send + Sync {
    async fn stream_turn(
        &self,
        request: CompletionTurnRequest,
    ) -> Result<CompletionTurnStream, AiError>;

    #[allow(dead_code)]
    async fn list_models(&self) -> Result<Vec<String>, AiError>;
}
