use crate::{tools::ToolDescriptor, types::ChatMode};

pub fn build_system_prompt(mode: ChatMode, tools: &[ToolDescriptor]) -> String {
    let mode_instruction = match mode {
        ChatMode::Ask => {
            "You are Kuku AI in Ask mode. Answer clearly. You may use read-only tools when useful."
        }
        ChatMode::Agent => {
            "You are Kuku AI in Agent mode. You may read from the vault and, when needed, propose edits through tools."
        }
        ChatMode::Inline => {
            "You are Kuku AI in Inline mode. Work from the active editor context. You may use read-only tools and may propose edits only with edit_file on the current active file. Never create, delete, move, or rename files in Inline mode. If the selected text is only an excerpt, read the active file before proposing edits and preserve unrelated content."
        }
    };

    if tools.is_empty() {
        return mode_instruction.to_string();
    }

    let tool_lines = tools
        .iter()
        .map(|tool| format!("- {}: {}", tool.name, tool.description))
        .collect::<Vec<_>>()
        .join("\n");

    let widget_instruction = if tools.iter().any(|tool| tool.name == "create_widget") {
        "\n\nWidget embeds: Call list_widgets before create_widget for requests that may match an existing widget. If a suitable widget exists, reuse its markdownEmbed and do not call create_widget unless the user asks to change it. Make new widgets interactive whenever possible. JavaScript is allowed for local DOM interaction, timers, calculations, and widget UI state. Do not use inline event handlers, external URLs, network APIs, navigation APIs, iframes, forms, top navigation, dynamic code generation, or computed access to browser globals; use inline data/blob assets only. For widget visual design, unless the user explicitly asks for a visual style, use a minimal black, white, and gray design system. Do not introduce accent colors unless the user's prompt requests them. When create_widget returns markdownEmbed, insert that exact fenced kuku-widget block into the note. Use edit_file for the note edit. Do not use provider-side file patching for note edits. Never insert raw iframe HTML for widgets."
    } else {
        ""
    };

    format!(
        "{mode_instruction}\n\nAll tool paths are vault-relative. Use an empty string for the vault root, never '/'.{widget_instruction}\n\nAvailable tools:\n{tool_lines}"
    )
}

#[cfg(test)]
mod tests {
    use super::build_system_prompt;
    use crate::{tools::ToolDescriptor, types::ChatMode};

    #[test]
    fn inline_prompt_mentions_active_file_edit_limit() {
        let prompt = build_system_prompt(ChatMode::Inline, &[] as &[ToolDescriptor]);

        assert!(prompt.contains("current active file"));
        assert!(prompt.contains("edit_file"));
        assert!(prompt.contains("Never create, delete, move, or rename files"));
    }

    #[test]
    fn prompt_tells_agent_to_embed_widget_markdown_not_iframes() {
        let tools = vec![ToolDescriptor {
            tool_id: "widget.create_widget".to_string(),
            name: "create_widget".to_string(),
            description: "Create a widget".to_string(),
            parameters: serde_json::json!({}),
            category: "widget".to_string(),
            access: crate::tools::ToolAccess::ProposesMutation,
            source: crate::tools::ToolSource::Proxy,
        }];

        let prompt = build_system_prompt(ChatMode::Agent, &tools);

        assert!(prompt.contains("markdownEmbed"));
        assert!(prompt.contains("Never insert raw iframe"));
    }

    #[test]
    fn widget_prompt_tells_agent_to_insert_with_edit_file() {
        let tools = vec![
            ToolDescriptor {
                tool_id: "widget.create_widget".to_string(),
                name: "create_widget".to_string(),
                description: "Create a widget".to_string(),
                parameters: serde_json::json!({}),
                category: "widget".to_string(),
                access: crate::tools::ToolAccess::ProposesMutation,
                source: crate::tools::ToolSource::Proxy,
            },
            ToolDescriptor {
                tool_id: "builtin.edit_file".to_string(),
                name: "edit_file".to_string(),
                description: "Edit a file".to_string(),
                parameters: serde_json::json!({}),
                category: "file".to_string(),
                access: crate::tools::ToolAccess::ProposesMutation,
                source: crate::tools::ToolSource::Native,
            },
        ];

        let prompt = build_system_prompt(ChatMode::Agent, &tools);

        assert!(prompt.contains("Use edit_file"));
        assert!(prompt.contains("Do not use provider-side file patching"));
    }

    #[test]
    fn widget_prompt_tells_agent_to_reuse_existing_widgets_first() {
        let tools = vec![
            ToolDescriptor {
                tool_id: "widget.create_widget".to_string(),
                name: "create_widget".to_string(),
                description: "Create a widget".to_string(),
                parameters: serde_json::json!({}),
                category: "widget".to_string(),
                access: crate::tools::ToolAccess::ProposesMutation,
                source: crate::tools::ToolSource::Proxy,
            },
            ToolDescriptor {
                tool_id: "widget.list_widgets".to_string(),
                name: "list_widgets".to_string(),
                description: "List widgets".to_string(),
                parameters: serde_json::json!({}),
                category: "widget".to_string(),
                access: crate::tools::ToolAccess::ReadOnly,
                source: crate::tools::ToolSource::Proxy,
            },
        ];

        let prompt = build_system_prompt(ChatMode::Agent, &tools);

        assert!(prompt.contains("Call list_widgets before create_widget"));
        assert!(prompt.contains("reuse its markdownEmbed"));
    }

    #[test]
    fn widget_prompt_tells_agent_to_make_widgets_interactive_when_possible() {
        let tools = vec![ToolDescriptor {
            tool_id: "widget.create_widget".to_string(),
            name: "create_widget".to_string(),
            description: "Create a widget".to_string(),
            parameters: serde_json::json!({}),
            category: "widget".to_string(),
            access: crate::tools::ToolAccess::ProposesMutation,
            source: crate::tools::ToolSource::Proxy,
        }];

        let prompt = build_system_prompt(ChatMode::Agent, &tools);

        assert!(prompt.contains("Make new widgets interactive whenever possible"));
        assert!(prompt.contains("JavaScript is allowed for local DOM interaction"));
        assert!(prompt.contains("network APIs"));
        assert!(prompt.contains("navigation APIs"));
        assert!(prompt.contains("dynamic code generation"));
        assert!(prompt.contains("computed access to browser globals"));
    }

    #[test]
    fn widget_prompt_defaults_to_minimal_grayscale_design() {
        let tools = vec![ToolDescriptor {
            tool_id: "widget.create_widget".to_string(),
            name: "create_widget".to_string(),
            description: "Create a widget".to_string(),
            parameters: serde_json::json!({}),
            category: "widget".to_string(),
            access: crate::tools::ToolAccess::ProposesMutation,
            source: crate::tools::ToolSource::Proxy,
        }];

        let prompt = build_system_prompt(ChatMode::Agent, &tools);

        assert!(prompt.contains("unless the user explicitly asks for a visual style"));
        assert!(prompt.contains("minimal black, white, and gray design system"));
        assert!(prompt.contains("Do not introduce accent colors"));
    }
}
