use std::path::PathBuf;

use kuku_ai::{NativeToolResult, ToolAccess, ToolDescriptor, ToolError, ToolSource};
use tauri::{AppHandle, Manager};

use crate::vault::{VaultState, get_vault_root};

use super::project_model::{DEFAULT_CONTEXT_MAX_CHARS, ProjectFolder};
use super::tool_ids;

const MAX_CONTEXT_CHARS: usize = 96_000;

pub fn descriptor(
    name: &str,
    tool_id: &str,
    description: &str,
    access: ToolAccess,
    parameters: serde_json::Value,
) -> ToolDescriptor {
    debug_assert_eq!(tool_ids::canonical_builtin_tool_id(name), tool_id);

    ToolDescriptor {
        tool_id: tool_id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        parameters,
        category: "project".to_string(),
        access,
        source: ToolSource::Native,
    }
}

pub fn folder_arg(
    args: &serde_json::Value,
    fallback: Option<&str>,
) -> Result<ProjectFolder, ToolError> {
    let raw = args
        .get("folder")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| fallback.map(str::trim).filter(|value| !value.is_empty()))
        .ok_or_else(|| {
            ToolError::InvalidArguments(
                "Missing folder. Select a folder scope or pass a folder argument.".to_string(),
            )
        })?;
    ProjectFolder::parse(raw).map_err(ToolError::InvalidArguments)
}

pub fn max_chars_arg(args: &serde_json::Value) -> Result<usize, ToolError> {
    let Some(value) = args.get("max_chars") else {
        return Ok(DEFAULT_CONTEXT_MAX_CHARS);
    };
    let raw = value
        .as_u64()
        .ok_or_else(|| ToolError::InvalidArguments("max_chars must be an integer".to_string()))?;
    let converted = usize::try_from(raw).map_err(|_| {
        ToolError::InvalidArguments(format!("max_chars must be <= {MAX_CONTEXT_CHARS}"))
    })?;
    Ok(converted.clamp(1, MAX_CONTEXT_CHARS))
}

pub fn optional_string_arg(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub fn required_string_arg(args: &serde_json::Value, key: &str) -> Result<String, ToolError> {
    optional_string_arg(args, key)
        .ok_or_else(|| ToolError::InvalidArguments(format!("Missing {key}")))
}

pub fn target_arg(args: &serde_json::Value) -> Result<String, ToolError> {
    let target = optional_string_arg(args, "target")
        .unwrap_or_else(|| "codex".to_string())
        .to_ascii_lowercase();
    if target
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Ok(target);
    }
    Err(ToolError::InvalidArguments(
        "target must contain only ASCII letters, numbers, '-' or '_'".to_string(),
    ))
}

pub fn serialize<T: serde::Serialize>(value: &T) -> Result<String, ToolError> {
    serde_json::to_string_pretty(value)
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))
}

pub fn read_only_result(text: String) -> NativeToolResult {
    NativeToolResult {
        text,
        mutation: None,
        preview_text: None,
    }
}

pub fn preview_excerpt(text: &str) -> String {
    text.chars().take(240).collect()
}

pub fn vault_root(app: &AppHandle) -> Result<PathBuf, ToolError> {
    let state = app.state::<VaultState>();
    get_vault_root(&state).map_err(ToolError::ExecutionFailed)
}
