use std::{collections::HashMap, sync::Arc};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

use crate::{
    AiError,
    tools::{ToolAccess, ToolDescriptor, ToolSource},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyToolDescriptor {
    pub tool_id: String,
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub category: String,
    #[serde(default = "default_proxy_tool_access")]
    pub access: ToolAccess,
}

impl ProxyToolDescriptor {
    pub fn as_tool_descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            tool_id: self.tool_id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            parameters: self.parameters.clone(),
            category: self.category.clone(),
            access: self.access.clone(),
            source: ToolSource::Proxy,
        }
    }
}

fn default_proxy_tool_access() -> ToolAccess {
    ToolAccess::ReadOnly
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyToolResult {
    pub output: String,
    pub is_error: bool,
}

#[derive(Clone, Default)]
pub struct ProxyBroker {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<ProxyToolResult>>>>,
}

impl ProxyBroker {
    pub fn register_pending(&self, call_id: String) -> oneshot::Receiver<ProxyToolResult> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(call_id, tx);
        rx
    }

    pub fn resolve(&self, call_id: &str, result: ProxyToolResult) -> Result<(), AiError> {
        let sender = self
            .pending
            .lock()
            .remove(call_id)
            .ok_or_else(|| AiError::ToolNotFound(call_id.to_string()))?;
        sender
            .send(result)
            .map_err(|_| AiError::State(format!("Proxy call {call_id} is no longer pending")))
    }

    pub fn clear(&self, call_id: &str) {
        self.pending.lock().remove(call_id);
    }
}
