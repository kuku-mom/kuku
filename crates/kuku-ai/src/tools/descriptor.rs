use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::ChatMode;

const INLINE_EDIT_TOOL_ID: &str = "builtin.edit_file";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolAccess {
    ReadOnly,
    ProposesMutation,
}

fn default_tool_access() -> ToolAccess {
    ToolAccess::ReadOnly
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolSource {
    Native,
    Proxy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolKind {
    Read,
    Search,
    Edit,
    Proposal,
    Navigation,
    Other,
}

fn default_tool_kind() -> ToolKind {
    ToolKind::Other
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolRiskLevel {
    Low,
    Medium,
    High,
}

fn default_tool_risk_level() -> ToolRiskLevel {
    ToolRiskLevel::Low
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub tool_id: String,
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub category: String,
    #[serde(default = "default_tool_kind")]
    pub kind: ToolKind,
    #[serde(default)]
    pub requires_approval: bool,
    #[serde(default = "default_tool_risk_level")]
    pub risk_level: ToolRiskLevel,
    #[serde(default)]
    pub mode_availability: Vec<ChatMode>,
    #[serde(default)]
    pub permission_rule_key: String,
    #[serde(default = "default_tool_access")]
    pub access: ToolAccess,
    pub source: ToolSource,
}

#[derive(Debug, Clone)]
pub struct ToolCatalog {
    descriptors: Vec<ToolDescriptor>,
}

impl ToolCatalog {
    pub fn new(descriptors: Vec<ToolDescriptor>) -> Self {
        Self { descriptors }
    }

    pub fn enabled_tools(&self, mode: ChatMode) -> Vec<ToolDescriptor> {
        allowed_tools(mode, &self.descriptors)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPermissionDecision {
    Allow,
    Confirm,
    Deny,
}

pub fn tool_permission_decision(
    mode: ChatMode,
    descriptor: &ToolDescriptor,
) -> ToolPermissionDecision {
    if !descriptor.mode_availability.contains(&mode) {
        return ToolPermissionDecision::Deny;
    }

    match mode {
        ChatMode::Ask if descriptor.access != ToolAccess::ReadOnly => {
            return ToolPermissionDecision::Deny;
        }
        ChatMode::Inline
            if descriptor.access != ToolAccess::ReadOnly
                && descriptor.tool_id != INLINE_EDIT_TOOL_ID
                && descriptor.name != "edit_file" =>
        {
            return ToolPermissionDecision::Deny;
        }
        _ => {}
    }

    if descriptor.requires_approval || descriptor.access == ToolAccess::ProposesMutation {
        ToolPermissionDecision::Confirm
    } else {
        ToolPermissionDecision::Allow
    }
}

pub fn allowed_tools(mode: ChatMode, descriptors: &[ToolDescriptor]) -> Vec<ToolDescriptor> {
    descriptors
        .iter()
        .filter(|tool| tool_permission_decision(mode.clone(), tool) != ToolPermissionDecision::Deny)
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        ToolAccess, ToolCatalog, ToolDescriptor, ToolKind, ToolPermissionDecision, ToolRiskLevel,
        ToolSource, allowed_tools, tool_permission_decision,
    };
    use crate::types::ChatMode;

    fn tool(name: &str, tool_id: &str, access: ToolAccess) -> ToolDescriptor {
        tool_with_modes(
            name,
            tool_id,
            access,
            vec![ChatMode::Ask, ChatMode::Inline, ChatMode::Agent],
        )
    }

    fn tool_with_modes(
        name: &str,
        tool_id: &str,
        access: ToolAccess,
        mode_availability: Vec<ChatMode>,
    ) -> ToolDescriptor {
        ToolDescriptor {
            tool_id: tool_id.to_string(),
            name: name.to_string(),
            description: format!("{name} tool"),
            parameters: json!({}),
            category: "test".to_string(),
            kind: ToolKind::Other,
            requires_approval: access == ToolAccess::ProposesMutation,
            risk_level: ToolRiskLevel::Low,
            mode_availability,
            permission_rule_key: tool_id.to_string(),
            access,
            source: ToolSource::Native,
        }
    }

    #[test]
    fn inline_mode_allows_read_only_tools_and_edit_file_only() {
        let tools = vec![
            tool("read_file", "builtin.read_file", ToolAccess::ReadOnly),
            tool(
                "edit_file",
                "builtin.edit_file",
                ToolAccess::ProposesMutation,
            ),
            tool(
                "create_file",
                "builtin.create_file",
                ToolAccess::ProposesMutation,
            ),
        ];

        let allowed = allowed_tools(ChatMode::Inline, &tools);
        let names = allowed
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["read_file", "edit_file"]);
    }

    #[test]
    fn ask_mode_allows_only_read_only_tools() {
        let tools = vec![
            tool("read_file", "builtin.read_file", ToolAccess::ReadOnly),
            tool(
                "edit_file",
                "builtin.edit_file",
                ToolAccess::ProposesMutation,
            ),
        ];

        let allowed = allowed_tools(ChatMode::Ask, &tools);
        let names = allowed
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["read_file"]);
    }

    #[test]
    fn mode_availability_limits_tools_within_access_policy() {
        let tools = vec![tool_with_modes(
            "agent_only_read",
            "builtin.agent_only_read",
            ToolAccess::ReadOnly,
            vec![ChatMode::Agent],
        )];

        assert!(allowed_tools(ChatMode::Ask, &tools).is_empty());
        assert!(allowed_tools(ChatMode::Inline, &tools).is_empty());
        assert_eq!(allowed_tools(ChatMode::Agent, &tools).len(), 1);
    }

    #[test]
    fn tool_catalog_filters_enabled_tools_for_mode() {
        let catalog = ToolCatalog::new(vec![
            tool("read_file", "builtin.read_file", ToolAccess::ReadOnly),
            tool(
                "create_file",
                "builtin.create_file",
                ToolAccess::ProposesMutation,
            ),
            tool_with_modes(
                "memory_propose",
                "knowledge.memory_propose",
                ToolAccess::ProposesMutation,
                vec![ChatMode::Agent],
            ),
        ]);

        let ask_tools = catalog.enabled_tools(ChatMode::Ask);
        let agent_tools = catalog.enabled_tools(ChatMode::Agent);

        assert_eq!(
            ask_tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            vec!["read_file"],
        );
        assert_eq!(agent_tools.len(), 3);
    }

    #[test]
    fn permission_decision_separates_allow_confirm_and_deny() {
        let read = tool("read_file", "builtin.read_file", ToolAccess::ReadOnly);
        let edit = tool(
            "edit_file",
            "builtin.edit_file",
            ToolAccess::ProposesMutation,
        );
        let proposal = tool_with_modes(
            "memory_propose",
            "knowledge.memory_propose",
            ToolAccess::ProposesMutation,
            vec![ChatMode::Agent],
        );

        assert_eq!(
            tool_permission_decision(ChatMode::Ask, &read),
            ToolPermissionDecision::Allow,
        );
        assert_eq!(
            tool_permission_decision(ChatMode::Ask, &proposal),
            ToolPermissionDecision::Deny,
        );
        assert_eq!(
            tool_permission_decision(ChatMode::Inline, &edit),
            ToolPermissionDecision::Confirm,
        );
        assert_eq!(
            tool_permission_decision(ChatMode::Agent, &proposal),
            ToolPermissionDecision::Confirm,
        );
    }
}
