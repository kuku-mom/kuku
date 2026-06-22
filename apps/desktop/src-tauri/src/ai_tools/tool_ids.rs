pub const READ_FILE: &str = "builtin.read_file";
pub const LIST_FILES: &str = "builtin.list_files";
pub const SEARCH_VAULT: &str = "builtin.search_vault";
pub const CREATE_FILE: &str = "builtin.create_file";
pub const EDIT_FILE: &str = "builtin.edit_file";
pub const DELETE_FILE: &str = "builtin.delete_file";
pub const MOVE_FILE: &str = "builtin.move_file";
pub const GET_OUTLINE: &str = "builtin.get_outline";
pub const GET_TAGS: &str = "builtin.get_tags";
pub const PROJECT_LIST: &str = "builtin.project_list";
pub const PROJECT_CONTEXT: &str = "builtin.project_context";
pub const PROJECT_NEXT_STEPS: &str = "builtin.project_next_steps";
pub const PROJECT_PROPOSE_AGENT_HANDOFF: &str = "builtin.project_propose_agent_handoff";
pub const PROJECT_PROPOSE_SCAFFOLD: &str = "builtin.project_propose_scaffold";
pub const PROJECT_PROPOSE_NEXT_STEPS: &str = "builtin.project_propose_next_steps";
pub const PROJECT_PROPOSE_DECISION: &str = "builtin.project_propose_decision";
pub const PROJECT_PROPOSE_MEETING_SUMMARY: &str = "builtin.project_propose_meeting_summary";

pub fn canonical_builtin_tool_id(name: &str) -> String {
    match name {
        "read_file" => READ_FILE,
        "list_files" => LIST_FILES,
        "search_vault" => SEARCH_VAULT,
        "create_file" => CREATE_FILE,
        "edit_file" => EDIT_FILE,
        "delete_file" => DELETE_FILE,
        "move_file" => MOVE_FILE,
        "get_outline" => GET_OUTLINE,
        "get_tags" => GET_TAGS,
        "project_list" => PROJECT_LIST,
        "project_context" => PROJECT_CONTEXT,
        "project_next_steps" => PROJECT_NEXT_STEPS,
        "project_propose_agent_handoff" => PROJECT_PROPOSE_AGENT_HANDOFF,
        "project_propose_scaffold" => PROJECT_PROPOSE_SCAFFOLD,
        "project_propose_next_steps" => PROJECT_PROPOSE_NEXT_STEPS,
        "project_propose_decision" => PROJECT_PROPOSE_DECISION,
        "project_propose_meeting_summary" => PROJECT_PROPOSE_MEETING_SUMMARY,
        _ => return format!("builtin.{name}"),
    }
    .to_string()
}
