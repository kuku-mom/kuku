use std::path::{Path, PathBuf};

use async_trait::async_trait;
use kuku_ai::{
    AiNativeTool, AiState, ChatMode, MutationOp, MutationPlan, NativeToolResult, ToolAccess,
    ToolCallContext, ToolDescriptor, ToolError, ToolKind, ToolRiskLevel, ToolSource,
};
use tauri::{AppHandle, Manager};

use crate::knowledge::protected_paths::guard_ai_raw_mutation_path;
use crate::vault::checksum::{compute_checksum, compute_directory_checksum};
use crate::vault::{
    DEFAULT_FILE_EXTENSIONS, VaultState, get_vault_root, read_directory_recursive,
    resolve_vault_path_strict,
};

use super::tool_ids;

pub struct ReadFileTool;
pub struct ListFilesTool;
pub struct CreateFileTool;
pub struct EditFileTool;
pub struct DeleteFileTool;
pub struct MoveFileTool;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PathKind {
    File,
    Directory,
}

#[async_trait]
impl AiNativeTool for ReadFileTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "read_file",
            tool_ids::READ_FILE,
            "Read the content of a file in the vault",
            "file",
            ToolAccess::ReadOnly,
            serde_json::json!({
                "title": "read_file",
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                }
            }),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCallContext<'_>,
        args: serde_json::Value,
    ) -> Result<NativeToolResult, ToolError> {
        let path = path_arg(&args)
            .or_else(|| normalize_non_empty_path(ctx.editor_context.active_file.as_deref()))
            .ok_or_else(|| ToolError::InvalidArguments("No path specified".into()))?;

        let root = vault_root(ctx.app)?;
        let resolved = resolve_vault_path_strict(&root, &path)
            .await
            .map_err(ToolError::InvalidArguments)?;
        let content = tokio::fs::read_to_string(&resolved)
            .await
            .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
        remember_file_snapshot(ctx, &path, compute_checksum(&content))?;

        Ok(NativeToolResult {
            text: content,
            mutation: None,
            preview_text: None,
        })
    }
}

#[async_trait]
impl AiNativeTool for ListFilesTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "list_files",
            tool_ids::LIST_FILES,
            "List files in a directory within the vault. Use an empty path for the vault root, not '/'.",
            "file",
            ToolAccess::ReadOnly,
            serde_json::json!({
                "title": "list_files",
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Vault-relative directory path. Use an empty string for the vault root."
                    }
                }
            }),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCallContext<'_>,
        args: serde_json::Value,
    ) -> Result<NativeToolResult, ToolError> {
        let path = directory_arg(&args, ctx.editor_context.active_file.as_deref());
        let root = vault_root(ctx.app)?;
        let resolved = resolve_vault_path_strict(&root, &path)
            .await
            .map_err(ToolError::InvalidArguments)?;
        let entries = read_directory_recursive(&resolved, &root, DEFAULT_FILE_EXTENSIONS)
            .await
            .map_err(ToolError::ExecutionFailed)?;
        let checksum = compute_directory_checksum(&resolved)
            .await
            .map_err(ToolError::ExecutionFailed)?;
        remember_directory_snapshot(ctx, &path, checksum)?;
        let text = serde_json::to_string_pretty(&entries)
            .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;

        Ok(NativeToolResult {
            text,
            mutation: None,
            preview_text: None,
        })
    }
}

#[async_trait]
impl AiNativeTool for CreateFileTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "create_file",
            tool_ids::CREATE_FILE,
            "Create a new file or directory in the vault",
            "file",
            ToolAccess::ProposesMutation,
            serde_json::json!({
                "title": "create_file",
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": {
                        "type": "string",
                        "description": "Required when kind is 'file'. Omit for directories."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["file", "directory"],
                        "description": "Defaults to 'file'. Use 'directory' to create a folder."
                    }
                },
                "required": ["path"]
            }),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCallContext<'_>,
        args: serde_json::Value,
    ) -> Result<NativeToolResult, ToolError> {
        let path =
            path_arg(&args).ok_or_else(|| ToolError::InvalidArguments("Missing path".into()))?;
        let root = vault_root(ctx.app)?;
        let path = guard_raw_mutation_path(&root, &path).await?;
        let kind = kind_arg(&args)?;

        match kind {
            PathKind::File => {
                let content = content_arg(&args)
                    .ok_or_else(|| ToolError::InvalidArguments("Missing content".into()))?;

                let plan = MutationPlan {
                    summary: format!("Create {path}"),
                    operations: vec![MutationOp::CreateFile {
                        path: path.clone(),
                        content: content.clone(),
                    }],
                };

                Ok(NativeToolResult {
                    text: format!("Proposed creation of {path}"),
                    mutation: Some(plan),
                    preview_text: Some(preview_excerpt(&content)),
                })
            }
            PathKind::Directory => {
                let plan = MutationPlan {
                    summary: format!("Create directory {path}"),
                    operations: vec![MutationOp::CreateDirectory { path: path.clone() }],
                };

                Ok(NativeToolResult {
                    text: format!("Proposed creation of directory {path}"),
                    mutation: Some(plan),
                    preview_text: Some(format!("Create directory {path}")),
                })
            }
        }
    }
}

#[async_trait]
impl AiNativeTool for EditFileTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "edit_file",
            tool_ids::EDIT_FILE,
            "Edit an existing file in the vault",
            "file",
            ToolAccess::ProposesMutation,
            serde_json::json!({
                "title": "edit_file",
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["content"]
            }),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCallContext<'_>,
        args: serde_json::Value,
    ) -> Result<NativeToolResult, ToolError> {
        let path = resolve_edit_target_path(
            ctx.mode.clone(),
            path_arg(&args),
            ctx.editor_context.active_file.as_deref(),
        )?;
        let content = content_arg(&args)
            .ok_or_else(|| ToolError::InvalidArguments("Missing content".into()))?;

        let root = vault_root(ctx.app)?;
        let path = guard_raw_mutation_path(&root, &path).await?;
        let resolved = resolve_vault_path_strict(&root, &path)
            .await
            .map_err(ToolError::InvalidArguments)?;
        let expected_checksum =
            expected_file_checksum(ctx, &path, &resolved, "read_file", "edit_file").await?;

        let plan = MutationPlan {
            summary: format!("Edit {path}"),
            operations: vec![MutationOp::ReplaceFile {
                path: path.clone(),
                content: content.clone(),
                expected_checksum,
                before_excerpt: None,
            }],
        };

        Ok(NativeToolResult {
            text: format!("Proposed edit to {path}"),
            mutation: Some(plan),
            preview_text: Some(preview_excerpt(&content)),
        })
    }
}

#[async_trait]
impl AiNativeTool for DeleteFileTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "delete_file",
            tool_ids::DELETE_FILE,
            "Delete a file or directory from the vault. Directory deletions are recursive.",
            "file",
            ToolAccess::ProposesMutation,
            serde_json::json!({
                "title": "delete_file",
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "kind": {
                        "type": "string",
                        "enum": ["file", "directory"],
                        "description": "Optional hint. Omit to auto-detect from the current vault path."
                    }
                }
            }),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCallContext<'_>,
        args: serde_json::Value,
    ) -> Result<NativeToolResult, ToolError> {
        let path = path_arg(&args)
            .or_else(|| normalize_non_empty_path(ctx.editor_context.active_file.as_deref()))
            .ok_or_else(|| ToolError::InvalidArguments("No path specified".into()))?;

        let root = vault_root(ctx.app)?;
        let path = guard_raw_mutation_path(&root, &path).await?;
        let resolved = resolve_vault_path_strict(&root, &path)
            .await
            .map_err(ToolError::InvalidArguments)?;
        let (detected_kind, expected_checksum) =
            delete_target_snapshot(ctx, &path, &resolved).await?;

        if let Some(requested_kind) = optional_kind_arg(&args)?
            && requested_kind != detected_kind
        {
            return Err(ToolError::InvalidArguments(format!(
                "Path kind mismatch for {path}: requested {requested_kind}, detected {detected_kind}"
            )));
        }

        match detected_kind {
            PathKind::File => {
                let plan = MutationPlan {
                    summary: format!("Delete {path}"),
                    operations: vec![MutationOp::DeleteFile {
                        path: path.clone(),
                        expected_checksum,
                    }],
                };

                Ok(NativeToolResult {
                    text: format!("Proposed deletion of {path}"),
                    mutation: Some(plan),
                    preview_text: Some(format!("Delete file {path}")),
                })
            }
            PathKind::Directory => {
                let plan = MutationPlan {
                    summary: format!("Delete directory {path}"),
                    operations: vec![MutationOp::DeleteDirectory {
                        path: path.clone(),
                        expected_checksum,
                    }],
                };

                Ok(NativeToolResult {
                    text: format!("Proposed recursive deletion of directory {path}"),
                    mutation: Some(plan),
                    preview_text: Some(format!("Delete directory {path} recursively")),
                })
            }
        }
    }
}

#[async_trait]
impl AiNativeTool for MoveFileTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "move_file",
            tool_ids::MOVE_FILE,
            "Move or rename a file or directory within the vault. Requires approval.",
            "file",
            ToolAccess::ProposesMutation,
            serde_json::json!({
                "title": "move_file",
                "type": "object",
                "properties": {
                    "from": {
                        "type": "string",
                        "description": "Current vault-relative path."
                    },
                    "to": {
                        "type": "string",
                        "description": "New vault-relative path."
                    }
                },
                "required": ["from", "to"]
            }),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCallContext<'_>,
        args: serde_json::Value,
    ) -> Result<NativeToolResult, ToolError> {
        let root = vault_root(ctx.app)?;
        build_move_plan(&root, &args).await
    }
}

fn descriptor(
    name: &str,
    tool_id: &str,
    description: &str,
    category: &str,
    access: ToolAccess,
    parameters: serde_json::Value,
) -> ToolDescriptor {
    debug_assert_eq!(tool_ids::canonical_builtin_tool_id(name), tool_id);

        ToolDescriptor {
            tool_id: tool_id.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            parameters,
            category: category.to_string(),
            kind: if access == ToolAccess::ReadOnly {
                ToolKind::Read
            } else {
                ToolKind::Edit
            },
            requires_approval: access == ToolAccess::ProposesMutation,
            risk_level: match name {
                "delete_file" => ToolRiskLevel::High,
                "create_file" | "edit_file" | "move_file" => ToolRiskLevel::Medium,
                _ => ToolRiskLevel::Low,
            },
            mode_availability: match name {
                "edit_file" => vec![ChatMode::Inline, ChatMode::Agent],
                _ if access == ToolAccess::ReadOnly => {
                    vec![ChatMode::Ask, ChatMode::Inline, ChatMode::Agent]
                }
                _ => vec![ChatMode::Agent],
            },
            permission_rule_key: tool_id.to_string(),
            access,
            source: ToolSource::Native,
        }
    }

fn path_arg(args: &serde_json::Value) -> Option<String> {
    optional_path_arg(args).filter(|value| !value.is_empty())
}

fn optional_path_arg(args: &serde_json::Value) -> Option<String> {
    named_path_arg(args, "path")
}

fn named_path_arg(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|value| value.as_str())
        .map(normalize_vault_path)
}

fn move_paths_arg(args: &serde_json::Value) -> Result<(String, String), ToolError> {
    let from = named_path_arg(args, "from")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolError::InvalidArguments("Missing from".into()))?;
    let to = named_path_arg(args, "to")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolError::InvalidArguments("Missing to".into()))?;

    if from == to {
        return Err(ToolError::InvalidArguments(
            "Source and destination must be different".into(),
        ));
    }

    Ok((from, to))
}

fn content_arg(args: &serde_json::Value) -> Option<String> {
    args.get("content")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
}

fn directory_arg(args: &serde_json::Value, fallback: Option<&str>) -> String {
    optional_path_arg(args)
        .or_else(|| {
            fallback.map(|value| {
                normalize_vault_path(
                    Path::new(value)
                        .parent()
                        .unwrap_or(Path::new(""))
                        .to_string_lossy()
                        .as_ref(),
                )
            })
        })
        .unwrap_or_default()
}

fn normalize_vault_path(value: &str) -> String {
    let trimmed = value.trim();
    if matches!(trimmed, "" | "." | "./") {
        return String::new();
    }

    let without_current = trimmed.strip_prefix("./").unwrap_or(trimmed);
    let without_root = without_current.trim_start_matches('/');
    without_root.trim_end_matches('/').to_string()
}

fn normalize_non_empty_path(value: Option<&str>) -> Option<String> {
    value
        .map(normalize_vault_path)
        .filter(|path| !path.is_empty())
}

fn resolve_edit_target_path(
    mode: ChatMode,
    requested_path: Option<String>,
    active_file: Option<&str>,
) -> Result<String, ToolError> {
    let active_path = normalize_non_empty_path(active_file);

    match mode {
        ChatMode::Inline => {
            let active_path = active_path.ok_or_else(|| {
                ToolError::InvalidArguments(
                    "Inline mode can only edit the active file, but no active file is available."
                        .into(),
                )
            })?;

            if let Some(requested_path) = requested_path
                && requested_path != active_path
            {
                return Err(ToolError::InvalidArguments(format!(
                    "Inline mode can only edit the active file: {active_path}"
                )));
            }

            Ok(active_path)
        }
        _ => requested_path
            .or(active_path)
            .ok_or_else(|| ToolError::InvalidArguments("No path specified".into())),
    }
}

fn kind_arg(args: &serde_json::Value) -> Result<PathKind, ToolError> {
    Ok(optional_kind_arg(args)?.unwrap_or(PathKind::File))
}

fn optional_kind_arg(args: &serde_json::Value) -> Result<Option<PathKind>, ToolError> {
    let Some(raw) = args.get("kind").and_then(|value| value.as_str()) else {
        return Ok(None);
    };

    match raw.trim().to_ascii_lowercase().as_str() {
        "" => Ok(None),
        "file" => Ok(Some(PathKind::File)),
        "directory" | "dir" | "folder" => Ok(Some(PathKind::Directory)),
        other => Err(ToolError::InvalidArguments(format!(
            "Unsupported kind '{other}'. Use 'file' or 'directory'."
        ))),
    }
}

impl std::fmt::Display for PathKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::File => f.write_str("file"),
            Self::Directory => f.write_str("directory"),
        }
    }
}

fn preview_excerpt(text: &str) -> String {
    text.chars().take(240).collect()
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, ToolError> {
    let state = app.state::<VaultState>();
    get_vault_root(&state).map_err(ToolError::ExecutionFailed)
}

fn ai_state(app: &AppHandle) -> tauri::State<'_, AiState> {
    app.state::<AiState>()
}

fn remember_file_snapshot(
    ctx: &ToolCallContext<'_>,
    path: &str,
    checksum: String,
) -> Result<(), ToolError> {
    ai_state(ctx.app)
        .remember_path_snapshot(ctx.session_id, path.to_string(), checksum, false)
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))
}

fn remember_directory_snapshot(
    ctx: &ToolCallContext<'_>,
    path: &str,
    checksum: String,
) -> Result<(), ToolError> {
    ai_state(ctx.app)
        .remember_path_snapshot(ctx.session_id, path.to_string(), checksum, true)
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))
}

fn session_path_snapshot(
    ctx: &ToolCallContext<'_>,
    path: &str,
) -> Result<Option<(String, bool)>, ToolError> {
    ai_state(ctx.app)
        .path_snapshot(ctx.session_id, path)
        .map_err(|error| ToolError::ExecutionFailed(error.to_string()))
}

async fn expected_file_checksum(
    ctx: &ToolCallContext<'_>,
    path: &str,
    resolved: &Path,
    prerequisite_tool: &str,
    action_tool: &str,
) -> Result<String, ToolError> {
    let Some((checksum, is_dir)) = session_path_snapshot(ctx, path)? else {
        return Err(missing_snapshot_error(resolved, path, prerequisite_tool, action_tool).await);
    };

    if is_dir {
        return Err(ToolError::InvalidArguments(format!(
            "Path is a directory: {path}. Use list_files before directory operations."
        )));
    }

    Ok(checksum)
}

async fn delete_target_snapshot(
    ctx: &ToolCallContext<'_>,
    path: &str,
    resolved: &Path,
) -> Result<(PathKind, String), ToolError> {
    if let Some((checksum, is_dir)) = session_path_snapshot(ctx, path)? {
        let kind = if is_dir {
            PathKind::Directory
        } else {
            PathKind::File
        };
        return Ok((kind, checksum));
    }

    Err(match tokio::fs::metadata(resolved).await {
        Ok(metadata) if metadata.is_dir() => ToolError::InvalidArguments(format!(
            "Missing read-time checksum for {path}. Call list_files on this directory before delete_file."
        )),
        Ok(_) => ToolError::InvalidArguments(format!(
            "Missing read-time checksum for {path}. Call read_file on this path before delete_file."
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            ToolError::InvalidArguments(format!("Path does not exist: {path}"))
        }
        Err(error) => ToolError::ExecutionFailed(error.to_string()),
    })
}

async fn missing_snapshot_error(
    resolved: &Path,
    path: &str,
    prerequisite_tool: &str,
    action_tool: &str,
) -> ToolError {
    match tokio::fs::metadata(resolved).await {
        Ok(metadata) if metadata.is_dir() => ToolError::InvalidArguments(format!(
            "Path is a directory: {path}. Call list_files on that directory before {action_tool}."
        )),
        Ok(_) => ToolError::InvalidArguments(format!(
            "Missing read-time checksum for {path}. Call {prerequisite_tool} on this path before {action_tool}."
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            ToolError::InvalidArguments(format!("Path does not exist: {path}"))
        }
        Err(error) => ToolError::ExecutionFailed(error.to_string()),
    }
}

async fn build_move_plan(
    root: &Path,
    args: &serde_json::Value,
) -> Result<NativeToolResult, ToolError> {
    let (from, to) = move_paths_arg(args)?;
    let from = guard_raw_mutation_path(root, &from).await?;
    let to = guard_raw_mutation_path(root, &to).await?;
    let from_resolved = resolve_vault_path_strict(root, &from)
        .await
        .map_err(ToolError::InvalidArguments)?;
    let to_resolved = resolve_vault_path_strict(root, &to)
        .await
        .map_err(ToolError::InvalidArguments)?;

    if from_resolved == root || to_resolved == root {
        return Err(ToolError::InvalidArguments(
            "Cannot move or rename the vault root".into(),
        ));
    }

    match tokio::fs::metadata(&from_resolved).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ToolError::InvalidArguments(format!(
                "Source path does not exist: {from}"
            )));
        }
        Err(error) => return Err(ToolError::ExecutionFailed(error.to_string())),
    }

    let plan = MutationPlan {
        summary: format!("Move {from} to {to}"),
        operations: vec![MutationOp::RenameFile {
            from: from.clone(),
            to: to.clone(),
        }],
    };

    Ok(NativeToolResult {
        text: format!("Proposing to move {from} -> {to}"),
        mutation: Some(plan),
        preview_text: Some(format!("Move: {from} -> {to}")),
    })
}

async fn guard_raw_mutation_path(root: &Path, path: &str) -> Result<String, ToolError> {
    guard_ai_raw_mutation_path(root, path)
        .await
        .map_err(|error| ToolError::InvalidArguments(error.message))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use kuku_ai::ChatMode;
    use serde_json::json;
    use tauri::async_runtime;

    use super::{
        PathKind, build_move_plan, kind_arg, move_paths_arg, normalize_vault_path,
        resolve_edit_target_path,
    };

    #[test]
    fn normalize_vault_path_maps_root_aliases_to_empty() {
        assert_eq!(normalize_vault_path(""), "");
        assert_eq!(normalize_vault_path("."), "");
        assert_eq!(normalize_vault_path("./"), "");
        assert_eq!(normalize_vault_path("/"), "");
        assert_eq!(normalize_vault_path("///"), "");
    }

    #[test]
    fn normalize_vault_path_strips_vault_root_prefixes() {
        assert_eq!(normalize_vault_path("/notes"), "notes");
        assert_eq!(normalize_vault_path("./notes/sub"), "notes/sub");
        assert_eq!(normalize_vault_path(" notes/sub "), "notes/sub");
        assert_eq!(normalize_vault_path("notes/sub/"), "notes/sub");
    }

    #[test]
    fn kind_arg_accepts_directory_aliases() {
        assert_eq!(
            kind_arg(&json!({ "kind": "directory" })).unwrap(),
            PathKind::Directory
        );
        assert_eq!(
            kind_arg(&json!({ "kind": "folder" })).unwrap(),
            PathKind::Directory
        );
        assert_eq!(
            kind_arg(&json!({ "kind": "file" })).unwrap(),
            PathKind::File
        );
    }

    #[test]
    fn move_paths_arg_rejects_root_aliases_and_same_path() {
        let missing_from =
            move_paths_arg(&json!({ "from": "/", "to": "notes/renamed.md" })).unwrap_err();
        assert!(
            matches!(missing_from, super::ToolError::InvalidArguments(message) if message == "Missing from")
        );

        let same_path =
            move_paths_arg(&json!({ "from": "notes/a.md", "to": "./notes/a.md" })).unwrap_err();
        assert!(
            matches!(same_path, super::ToolError::InvalidArguments(message) if message.contains("different"))
        );
    }

    #[test]
    fn build_move_plan_rejects_missing_source() {
        let root = temp_dir();
        let error = async_runtime::block_on(build_move_plan(
            &root,
            &json!({ "from": "missing.md", "to": "renamed.md" }),
        ))
        .unwrap_err();

        assert!(
            matches!(error, super::ToolError::InvalidArguments(message) if message.contains("Source path does not exist"))
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn build_move_plan_rejects_protected_knowledge_paths_before_vault_io() {
        let root = temp_dir();
        for args in [
            json!({ "from": "Knowledge/%6demory/mem_auth.md", "to": "archive/mem_auth.md" }),
            json!({ "from": "notes/auth.md", "to": "Knowledge/%77iki/concepts/auth.md" }),
        ] {
            let error = async_runtime::block_on(build_move_plan(&root, &args)).unwrap_err();

            assert!(
                matches!(error, super::ToolError::InvalidArguments(message) if message.contains("protected Knowledge path"))
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn build_move_plan_creates_rename_mutation() {
        let root = temp_dir();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/original.md"), "hello").unwrap();

        let result = async_runtime::block_on(build_move_plan(
            &root,
            &json!({ "from": "notes/original.md", "to": "archive/renamed.md" }),
        ))
        .unwrap();

        let mutation = result.mutation.expect("rename plan");
        assert_eq!(
            mutation.summary,
            "Move notes/original.md to archive/renamed.md"
        );
        assert!(matches!(
            mutation.operations.as_slice(),
            [super::MutationOp::RenameFile { from, to }]
            if from == "notes/original.md" && to == "archive/renamed.md"
        ));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_edit_target_path_uses_active_file_in_inline_mode() {
        let path =
            resolve_edit_target_path(ChatMode::Inline, None, Some("notes/today.md")).unwrap();

        assert_eq!(path, "notes/today.md");
    }

    #[test]
    fn resolve_edit_target_path_rejects_non_active_file_in_inline_mode() {
        let error = resolve_edit_target_path(
            ChatMode::Inline,
            Some("notes/other.md".to_string()),
            Some("notes/today.md"),
        )
        .unwrap_err();

        assert!(
            matches!(error, super::ToolError::InvalidArguments(message) if message.contains("notes/today.md"))
        );
    }

    #[test]
    fn resolve_edit_target_path_requires_active_file_in_inline_mode() {
        let error = resolve_edit_target_path(ChatMode::Inline, None, None).unwrap_err();

        assert!(
            matches!(error, super::ToolError::InvalidArguments(message) if message.contains("no active file"))
        );
    }

    // Monotonic counter guarantees uniqueness even when two tests resolve
    // SystemTime in the same millisecond (which happened intermittently on
    // fast machines — see the `build_move_plan_creates_rename_mutation`
    // flake across earlier runs).
    static TEMP_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> std::path::PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let seq = TEMP_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("kuku-move-tool-test-{now}-{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
