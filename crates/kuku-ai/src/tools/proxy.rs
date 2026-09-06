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
    #[serde(default = "default_proxy_access")]
    pub access: ToolAccess,
}

fn default_proxy_access() -> ToolAccess {
    ToolAccess::ReadOnly
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::ProxyToolDescriptor;
    use crate::{
        tools::{ToolAccess, ToolSource, allowed_tools},
        types::ChatMode,
    };

    fn descriptor() -> serde_json::Value {
        json!({
            "toolId": "planner.update_task",
            "name": "planner_update_task",
            "description": "Update the requested Planner task",
            "parameters": { "type": "object", "properties": {} },
            "category": "Planner"
        })
    }

    #[test]
    fn legacy_proxy_descriptors_remain_read_only() {
        let proxy: ProxyToolDescriptor = serde_json::from_value(descriptor()).unwrap();
        assert_eq!(proxy.as_tool_descriptor().access, ToolAccess::ReadOnly);
        assert_eq!(proxy.as_tool_descriptor().source, ToolSource::Proxy);
    }

    #[test]
    fn mutating_proxies_are_only_available_in_agent_mode() {
        let mut value = descriptor();
        value["access"] = json!("proposesMutation");
        let proxy: ProxyToolDescriptor = serde_json::from_value(value).unwrap();
        let tools = vec![proxy.as_tool_descriptor()];
        assert_eq!(tools[0].access, ToolAccess::ProposesMutation);
        assert!(allowed_tools(ChatMode::Ask, &tools).is_empty());
        assert!(allowed_tools(ChatMode::Inline, &tools).is_empty());
        assert_eq!(allowed_tools(ChatMode::Agent, &tools).len(), 1);
        assert_eq!(
            serde_json::to_value(proxy).unwrap()["access"],
            json!("proposesMutation")
        );
    }

    #[test]
    fn unknown_proxy_access_is_rejected_instead_of_becoming_read_only() {
        let mut value = descriptor();
        value["access"] = json!("write");
        assert!(serde_json::from_value::<ProxyToolDescriptor>(value).is_err());
    }
}
