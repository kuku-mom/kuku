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

    let planner_instruction = if tools
        .iter()
        .any(|tool| tool.tool_id.starts_with("planner."))
    {
        "\n\nPlanner: Use Planner tools for tasks and calendar changes instead of editing task metadata or Planner Links.md with file tools. Read the current date and time zone from Planner before interpreting relative dates. Discover calendars and items first; reuse the opaque references and revisions returned by the tools, never identify an item by title alone. Search and availability are read-only: suggesting a time does not schedule it. Task due dates are independent of work blocks; completed work blocks remain as history. In Agent mode, Planner mutation tools apply immediately through the app's normal save path. Use them only for the concrete action the user requested. Report saved, pending, failed, or conflicting results accurately. On conflict, read the latest item and ask which change to keep; never automatically force an overwrite. On a failed or uncertain creation, reuse the same request ID and inspect the returned operation before retrying to avoid duplicates. Do not claim that an external account has synchronized unless the tool confirms it."
    } else {
        ""
    };

    format!(
        "{mode_instruction}\n\nAll tool paths are vault-relative. Use an empty string for the vault root, never '/'.{planner_instruction}\n\nAvailable tools:\n{tool_lines}"
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
    fn planner_guidance_is_scoped_to_available_tools() {
        use crate::tools::{ToolAccess, ToolSource};
        let descriptor = ToolDescriptor {
            tool_id: "planner.tasks_search".into(),
            name: "planner_tasks_search".into(),
            description: "Search tasks".into(),
            parameters: serde_json::json!({}),
            category: "planner".into(),
            access: ToolAccess::ReadOnly,
            source: ToolSource::Proxy,
        };
        let prompt = build_system_prompt(ChatMode::Agent, &[descriptor]);
        assert!(prompt.contains("opaque references and revisions"));
        assert!(prompt.contains("mutation tools apply immediately"));
        assert!(prompt.contains("same request ID"));
        assert!(!build_system_prompt(ChatMode::Agent, &[]).contains("Planner:"));
    }
}
