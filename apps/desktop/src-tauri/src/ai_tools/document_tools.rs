use std::path::PathBuf;

use async_trait::async_trait;
use kuku_ai::ChatMode;
use kuku_ai::{
    AiNativeTool, NativeToolResult, ToolAccess, ToolCallContext, ToolDescriptor, ToolError,
    ToolKind, ToolRiskLevel, ToolSource,
};
use kuku_indexer::extract_document;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::vault::{VaultState, get_vault_root, resolve_vault_path};

use super::tool_ids;

pub struct GetOutlineTool;
pub struct GetTagsTool;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutlineItem {
    level: u8,
    text: String,
    breadcrumb: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutlinePayload {
    path: String,
    outline: Vec<OutlineItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct TagsPayload {
    path: String,
    frontmatter_tags: Vec<String>,
    inline_tags: Vec<String>,
}

#[async_trait]
impl AiNativeTool for GetOutlineTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "get_outline",
            tool_ids::GET_OUTLINE,
            "Extract the heading structure of a markdown document. Returns a hierarchical outline.",
            serde_json::json!({
                "title": "get_outline",
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Vault-relative file path. Falls back to the active editor file if omitted."
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
        let path = resolve_document_path(ctx, &args)?;
        let root = vault_root(ctx.app)?;
        let resolved = resolve_vault_path(&root, &path).map_err(ToolError::InvalidArguments)?;
        let markdown = tokio::fs::read_to_string(&resolved)
            .await
            .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
        let payload = build_outline_payload(path, &markdown);

        Ok(NativeToolResult {
            text: serde_json::to_string_pretty(&payload)
                .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?,
            mutation: None,
            preview_text: None,
        })
    }
}

#[async_trait]
impl AiNativeTool for GetTagsTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "get_tags",
            tool_ids::GET_TAGS,
            "Extract tags from a markdown document. Currently reads YAML frontmatter tags.",
            serde_json::json!({
                "title": "get_tags",
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Vault-relative file path. Falls back to the active editor file if omitted."
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
        let path = resolve_document_path(ctx, &args)?;
        let root = vault_root(ctx.app)?;
        let resolved = resolve_vault_path(&root, &path).map_err(ToolError::InvalidArguments)?;
        let markdown = tokio::fs::read_to_string(&resolved)
            .await
            .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
        let payload = build_tags_payload(path, &markdown);

        Ok(NativeToolResult {
            text: serde_json::to_string_pretty(&payload)
                .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?,
            mutation: None,
            preview_text: None,
        })
    }
}

fn descriptor(
    name: &str,
    tool_id: &str,
    description: &str,
    parameters: serde_json::Value,
) -> ToolDescriptor {
    debug_assert_eq!(tool_ids::canonical_builtin_tool_id(name), tool_id);

    ToolDescriptor {
        tool_id: tool_id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        parameters,
        category: "document".to_string(),
        kind: ToolKind::Read,
        requires_approval: false,
        risk_level: ToolRiskLevel::Low,
        mode_availability: vec![ChatMode::Ask, ChatMode::Inline, ChatMode::Agent],
        permission_rule_key: tool_id.to_string(),
        access: ToolAccess::ReadOnly,
        source: ToolSource::Native,
    }
}

fn resolve_document_path(
    ctx: &ToolCallContext<'_>,
    args: &serde_json::Value,
) -> Result<String, ToolError> {
    path_arg(args)
        .or_else(|| normalize_non_empty_path(ctx.editor_context.active_file.as_deref()))
        .ok_or_else(|| ToolError::InvalidArguments("No path specified".into()))
}

fn build_outline_payload(path: String, markdown: &str) -> OutlinePayload {
    let doc = extract_document(markdown);
    let outline = doc
        .sections
        .into_iter()
        .filter(|section| section.level > 0 && !section.path.is_empty())
        .map(|section| OutlineItem {
            level: section.level,
            text: section.path.last().cloned().unwrap_or_default(),
            breadcrumb: section.path.join(" > "),
        })
        .collect();

    OutlinePayload { path, outline }
}

fn build_tags_payload(path: String, markdown: &str) -> TagsPayload {
    let doc = extract_document(markdown);
    let mut frontmatter_tags = doc
        .frontmatter
        .iter()
        .filter(|entry| is_top_level_tag_key(&entry.key))
        .map(|entry| entry.value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    frontmatter_tags.sort();
    frontmatter_tags.dedup();

    TagsPayload {
        path,
        frontmatter_tags,
        inline_tags: Vec::new(),
    }
}

fn is_top_level_tag_key(key: &str) -> bool {
    matches!(key, "tag" | "tags")
        || is_indexed_tag_key(key, "tag")
        || is_indexed_tag_key(key, "tags")
}

fn is_indexed_tag_key(key: &str, prefix: &str) -> bool {
    let Some(rest) = key.strip_prefix(prefix) else {
        return false;
    };
    let Some(index) = rest
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
    else {
        return false;
    };
    !index.is_empty() && index.chars().all(|ch| ch.is_ascii_digit())
}

fn path_arg(args: &serde_json::Value) -> Option<String> {
    args.get("path")
        .and_then(|value| value.as_str())
        .map(normalize_vault_path)
        .filter(|value| !value.is_empty())
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

fn vault_root(app: &AppHandle) -> Result<PathBuf, ToolError> {
    let state = app.state::<VaultState>();
    get_vault_root(&state).map_err(ToolError::ExecutionFailed)
}

#[cfg(test)]
mod tests {
    use super::{build_outline_payload, build_tags_payload};

    #[test]
    fn build_outline_payload_keeps_heading_hierarchy() {
        let payload = build_outline_payload(
            "notes/sample.md".to_string(),
            "# Alpha\n\n## Beta\n\n### Gamma\n",
        );

        assert_eq!(
            payload
                .outline
                .iter()
                .map(|item| (item.level, item.text.as_str(), item.breadcrumb.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (1, "Alpha", "Alpha"),
                (2, "Beta", "Alpha > Beta"),
                (3, "Gamma", "Alpha > Beta > Gamma"),
            ]
        );
    }

    #[test]
    fn build_tags_payload_reads_top_level_scalar_and_sequence_tags_only() {
        let payload = build_tags_payload(
            "notes/tags.md".to_string(),
            r#"---
tag: design
tags:
  - rust
  - ai
metadata:
  tags:
    - hidden
---

# Title
"#,
        );

        assert_eq!(payload.frontmatter_tags, vec!["ai", "design", "rust"]);
        assert!(payload.inline_tags.is_empty());
    }
}
