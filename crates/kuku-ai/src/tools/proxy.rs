use std::{collections::HashMap, sync::Arc};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

use crate::{
    AiError,
    tools::{ToolAccess, ToolDescriptor, ToolKind, ToolRiskLevel, ToolSource},
    types::ChatMode,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyToolDescriptor {
    pub tool_id: String,
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub category: String,
    #[serde(default)]
    pub kind: Option<ToolKind>,
    #[serde(default)]
    pub requires_approval: Option<bool>,
    #[serde(default)]
    pub risk_level: Option<ToolRiskLevel>,
    #[serde(default)]
    pub mode_availability: Option<Vec<ChatMode>>,
    #[serde(default)]
    pub permission_rule_key: Option<String>,
    #[serde(default)]
    pub access: Option<ToolAccess>,
}

impl ProxyToolDescriptor {
    pub fn as_tool_descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            tool_id: self.tool_id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            parameters: self.parameters.clone(),
            category: self.category.clone(),
            kind: self.kind.clone().unwrap_or(ToolKind::Other),
            requires_approval: self.requires_approval.unwrap_or(false),
            risk_level: self.risk_level.clone().unwrap_or(ToolRiskLevel::Low),
            mode_availability: self.mode_availability.clone().unwrap_or_default(),
            permission_rule_key: self
                .permission_rule_key
                .clone()
                .unwrap_or_else(|| self.tool_id.clone()),
            access: self.access.clone().unwrap_or(ToolAccess::ReadOnly),
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
    use crate::{tools::allowed_tools, types::ChatMode, ToolAccess};

    #[test]
    fn proxy_descriptor_preserves_explicit_proposes_mutation_access() {
        let descriptor: ProxyToolDescriptor = serde_json::from_value(json!({
            "toolId": "knowledge.memory_propose",
            "name": "memory_propose",
            "description": "Create a Knowledge decision document for review.",
            "parameters": { "type": "object", "properties": {} },
            "category": "knowledge",
            "access": "proposesMutation"
        }))
        .expect("proxy descriptor should deserialize");

        let tool = descriptor.as_tool_descriptor();

        assert_eq!(tool.access, ToolAccess::ProposesMutation);
    }

    #[test]
    fn proxy_proposal_tools_are_not_available_in_ask_or_inline_modes() {
        let descriptor: ProxyToolDescriptor = serde_json::from_value(json!({
            "toolId": "knowledge.wiki_propose_page",
            "name": "wiki_propose_page",
            "description": "Create a Knowledge decision document for review.",
            "parameters": { "type": "object", "properties": {} },
            "category": "knowledge",
            "access": "proposesMutation"
        }))
        .expect("proxy descriptor should deserialize");
        let tools = vec![descriptor.as_tool_descriptor()];

        assert!(allowed_tools(ChatMode::Ask, &tools).is_empty());
        assert!(allowed_tools(ChatMode::Inline, &tools).is_empty());
        assert_eq!(allowed_tools(ChatMode::Agent, &tools).len(), 1);
    }
}
