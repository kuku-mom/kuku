use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::command;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{Duration, timeout};

use crate::plugin_installer::{package_root, plugin_root, read_manifest_at, resolve_package_path};

#[command]
pub async fn plugin_sidecar_call(
    plugin_id: String,
    sidecar: String,
    operation: String,
    params: Value,
) -> Result<String, String> {
    let package = package_root(&plugin_id)?;
    let manifest = read_manifest_at(&package.join(crate::plugin_installer::MANIFEST_FILE))?;
    if !manifest.permissions.sidecar {
        return Err(format!(
            "Plugin '{}' has not requested sidecar permission",
            manifest.id
        ));
    }

    let sidecar_manifest = manifest
        .sidecars
        .get(&sidecar)
        .ok_or_else(|| format!("Unknown sidecar '{sidecar}' for plugin '{plugin_id}'"))?;
    let sidecar_path = sidecar_manifest
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Sidecar '{sidecar}' is missing path"))?;
    let command_path = resolve_package_path(&plugin_id, sidecar_path)?;
    let data_root = plugin_root(&plugin_id)?.join("data");
    tokio::fs::create_dir_all(&data_root)
        .await
        .map_err(|error| format!("Failed to create plugin data dir: {error}"))?;

    let commands = sidecar_manifest
        .get("commands")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("Sidecar '{sidecar}' is missing commands"))?;
    let command_template = commands.get(&operation).ok_or_else(|| {
        format!("Operation '{operation}' is not declared for sidecar '{sidecar}'")
    })?;
    let (template, stdin_param) = command_parts(command_template)?;

    if plugin_id == "gbrain" && sidecar == "gbrain" {
        return run_builtin_gbrain(&data_root, &operation, &params);
    }
    if plugin_id == "llmwiki" && sidecar == "llmwiki" {
        return run_builtin_llmwiki(&data_root, &operation, &params);
    }

    let args = template
        .iter()
        .map(|value| render_arg(value, &params))
        .collect::<Result<Vec<_>, _>>()?;

    let mut child = Command::new(&command_path)
        .args(&args)
        .current_dir(&package)
        .env("GBRAIN_HOME", &data_root)
        .stdin(if stdin_param.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to run sidecar operation '{operation}': {error}"))?;

    if let Some(stdin_key) = stdin_param {
        let input = params
            .get(stdin_key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Missing string stdin parameter '{stdin_key}'"))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open sidecar stdin".to_string())?;
        stdin
            .write_all(input.as_bytes())
            .await
            .map_err(|error| format!("Failed to write sidecar stdin: {error}"))?;
    }

    let output = timeout(Duration::from_secs(60), child.wait_with_output())
        .await
        .map_err(|_| format!("Sidecar operation '{operation}' timed out"))?
        .map_err(|error| format!("Failed to collect sidecar output for '{operation}': {error}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if stderr.is_empty() { stdout } else { stderr };
        Err(format!(
            "Sidecar operation '{}' failed with status {}: {}",
            operation, output.status, message
        ))
    }
}

fn command_parts(value: &Value) -> Result<(&Vec<Value>, Option<&str>), String> {
    if let Some(args) = value.as_array() {
        return Ok((args, None));
    }
    let Some(object) = value.as_object() else {
        return Err("Sidecar command must be an args array or object".into());
    };
    let args = object
        .get("args")
        .and_then(Value::as_array)
        .ok_or_else(|| "Sidecar command object requires args array".to_string())?;
    let stdin = object.get("stdin").and_then(Value::as_str);
    Ok((args, stdin))
}

fn render_arg(value: &Value, params: &Value) -> Result<String, String> {
    let Some(raw) = value.as_str() else {
        return Err("Sidecar command templates must contain only string args".into());
    };

    if raw.starts_with("{{") && raw.ends_with("}}") {
        let key = raw.trim_start_matches("{{").trim_end_matches("}}").trim();
        let param = params
            .get(key)
            .ok_or_else(|| format!("Missing sidecar parameter '{key}'"))?;
        return match param {
            Value::String(value) => Ok(value.clone()),
            Value::Number(value) => Ok(value.to_string()),
            Value::Bool(value) => Ok(value.to_string()),
            _ => Err(format!("Sidecar parameter '{key}' must be scalar")),
        };
    }

    Ok(raw.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrainPage {
    slug: String,
    title: String,
    content: String,
    links: Vec<String>,
    updated_at: String,
    source_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineEntry {
    slug: String,
    date: String,
    summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrainSuggestion {
    id: String,
    kind: String,
    slug: String,
    title: String,
    preview: String,
    confidence: f32,
    payload: Value,
    created_at: String,
    #[serde(default, skip_serializing_if = "is_active_suggestion_status")]
    status: SuggestionStatus,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum SuggestionStatus {
    #[default]
    Active,
    Accepted,
    Dismissed,
}

fn is_active_suggestion_status(status: &SuggestionStatus) -> bool {
    *status == SuggestionStatus::Active
}

fn run_builtin_gbrain(data_root: &Path, operation: &str, params: &Value) -> Result<String, String> {
    ensure_brain_dirs(data_root)?;

    match operation {
        "version" => Ok("gbrain-kuku 0.1.0".into()),
        "init" => json_string(&serde_json::json!({
            "ok": true,
            "home": data_root.to_string_lossy(),
            "pages": pages_root(data_root).to_string_lossy(),
        })),
        "doctor" => {
            let pages = read_all_pages(data_root)?;
            json_string(&serde_json::json!({
                "ok": true,
                "engine": "kuku-builtin-gbrain",
                "pages": pages.len(),
                "timelineEntries": read_timeline(data_root)?.len(),
                "suggestions": read_suggestions(data_root)?.len(),
                "insights": read_jsonl_values(&insights_path(data_root))?.len(),
                "home": data_root.to_string_lossy(),
            }))
        }
        "sync" | "embedStale" => {
            let pages = read_all_pages(data_root)?;
            json_string(&serde_json::json!({
                "ok": true,
                "operation": operation,
                "pages": pages.len(),
                "message": "Local built-in GBrain index is file-backed and already current."
            }))
        }
        "importVault" => {
            let path = string_param(params, "path")?;
            let imported = import_vault(data_root, Path::new(&path))?;
            json_string(&serde_json::json!({ "ok": true, "imported": imported }))
        }
        "search" => {
            let query = string_param(params, "query")?;
            json_string(&search_pages(data_root, &query)?)
        }
        "query" => {
            let query = string_param(params, "query")?;
            let matches = search_pages(data_root, &query)?;
            json_string(&serde_json::json!({
                "query": query,
                "answer": summarize_matches(&matches),
                "matches": matches,
            }))
        }
        "getPage" => json_string(&read_page(data_root, &string_param(params, "slug")?)?),
        "listPages" => {
            let pages = read_all_pages(data_root)?;
            let list = pages
                .into_iter()
                .map(|page| {
                    serde_json::json!({
                        "slug": page.slug,
                        "title": page.title,
                        "links": page.links.len(),
                        "bytes": page.content.len(),
                        "updatedAt": page.updated_at,
                        "sourcePath": page.source_path,
                    })
                })
                .collect::<Vec<_>>();
            json_string(&list)
        }
        "putPage" => {
            let slug = normalize_slug(&string_param(params, "slug")?);
            let content = string_param(params, "content")?;
            let source_path = params
                .get("sourcePath")
                .and_then(Value::as_str)
                .map(str::to_string);
            write_page(data_root, &slug, &content)?;
            write_page_meta(data_root, &slug, source_path)?;
            json_string(&serde_json::json!({ "ok": true, "slug": slug }))
        }
        "addLink" => {
            let from = normalize_slug(&string_param(params, "from")?);
            let to = normalize_slug(&string_param(params, "to")?);
            let mut page = read_page(data_root, &from).unwrap_or_else(|_| BrainPage {
                slug: from.clone(),
                title: from.clone(),
                content: format!("# {from}\n"),
                links: Vec::new(),
                updated_at: now_string(),
                source_path: None,
            });
            let link = format!("[[{to}]]");
            if !page.content.contains(&link) {
                page.content.push_str(&format!("\n{link}\n"));
            }
            write_page(data_root, &from, &page.content)?;
            json_string(&serde_json::json!({ "ok": true, "from": from, "to": to }))
        }
        "addTimelineEntry" => {
            let entry = TimelineEntry {
                slug: normalize_slug(&string_param(params, "slug")?),
                date: string_param(params, "date")?,
                summary: string_param(params, "summary")?,
            };
            append_timeline(data_root, &entry)?;
            json_string(&serde_json::json!({ "ok": true, "entry": entry }))
        }
        "backlinks" => {
            let slug = normalize_slug(&string_param(params, "slug")?);
            let pages = read_all_pages(data_root)?;
            let backlinks = pages
                .into_iter()
                .filter(|page| page.links.iter().any(|link| normalize_slug(link) == slug))
                .map(|page| serde_json::json!({ "slug": page.slug, "title": page.title }))
                .collect::<Vec<_>>();
            json_string(&backlinks)
        }
        "graph" => {
            let focus = normalize_slug(&string_param(params, "slug")?);
            let pages = read_all_pages(data_root)?;
            let known = pages
                .iter()
                .map(|page| page.slug.clone())
                .collect::<BTreeSet<_>>();
            let mut nodes = BTreeSet::new();
            let mut edges = Vec::new();
            for page in pages {
                let connected = page.slug == focus
                    || page.links.iter().any(|link| normalize_slug(link) == focus);
                if !connected {
                    continue;
                }
                nodes.insert(page.slug.clone());
                for link in page.links {
                    let target = normalize_slug(&link);
                    if known.contains(&target) || target == focus {
                        nodes.insert(target.clone());
                        edges.push(serde_json::json!({ "from": page.slug, "to": target }));
                    }
                }
            }
            json_string(&serde_json::json!({ "focus": focus, "nodes": nodes, "edges": edges }))
        }
        "timeline" => {
            let slug = normalize_slug(&string_param(params, "slug")?);
            let entries = read_timeline(data_root)?
                .into_iter()
                .filter(|entry| normalize_slug(&entry.slug) == slug)
                .collect::<Vec<_>>();
            json_string(&entries)
        }
        "analyzeNote" => {
            let slug = normalize_slug(&string_param(params, "slug")?);
            let content = string_param(params, "content")?;
            let title = params
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| title_for(&slug, &content));
            let source_path = params
                .get("sourcePath")
                .and_then(Value::as_str)
                .map(str::to_string);
            let suggestions = analyze_note(data_root, &slug, &title, &content, source_path)?;
            json_string(&suggestions)
        }
        "listRelated" => {
            let slug = params
                .get("slug")
                .and_then(Value::as_str)
                .map(normalize_slug)
                .unwrap_or_default();
            let query = params.get("query").and_then(Value::as_str).unwrap_or("");
            json_string(&list_related(data_root, &slug, query)?)
        }
        "acceptSuggestion" => {
            let id = string_param(params, "id")?;
            let suggestion = accept_suggestion(data_root, &id)?;
            json_string(&serde_json::json!({ "ok": true, "suggestion": suggestion }))
        }
        "dismissSuggestion" => {
            let id = string_param(params, "id")?;
            let suggestion = update_suggestion_status(data_root, &id, SuggestionStatus::Dismissed)?;
            json_string(&serde_json::json!({ "ok": true, "suggestion": suggestion }))
        }
        _ => Err(format!(
            "Built-in GBrain operation '{operation}' is not implemented"
        )),
    }
}

fn ensure_brain_dirs(data_root: &Path) -> Result<(), String> {
    fs::create_dir_all(pages_root(data_root))
        .map_err(|error| format!("Failed to create GBrain pages dir: {error}"))?;
    fs::create_dir_all(meta_root(data_root))
        .map_err(|error| format!("Failed to create GBrain meta dir: {error}"))?;
    Ok(())
}

fn pages_root(data_root: &Path) -> PathBuf {
    data_root.join("pages")
}

fn timeline_path(data_root: &Path) -> PathBuf {
    data_root.join("timeline.jsonl")
}

fn suggestions_path(data_root: &Path) -> PathBuf {
    data_root.join("suggestions.jsonl")
}

fn insights_path(data_root: &Path) -> PathBuf {
    data_root.join("insights.jsonl")
}

fn events_path(data_root: &Path) -> PathBuf {
    data_root.join("events.jsonl")
}

fn meta_root(data_root: &Path) -> PathBuf {
    data_root.join("meta")
}

fn page_meta_path(data_root: &Path, slug: &str) -> PathBuf {
    meta_root(data_root).join(format!("{}.json", normalize_slug(slug)))
}

fn string_param(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("Missing string parameter '{key}'"))
}

fn json_string(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|error| format!("Failed to encode JSON: {error}"))
}

fn now_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

fn modified_string(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(now_string)
}

fn normalize_slug(value: &str) -> String {
    let mut out = String::new();
    let mut previous_dash = false;
    for ch in value.trim().chars() {
        if ch.is_alphanumeric() {
            previous_dash = false;
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
        } else if matches!(ch, '-' | '_' | '/' | ' ' | '.') {
            if previous_dash {
                continue;
            }
            previous_dash = true;
            out.push('-');
        }
    }
    let slug = out.trim_matches('-').to_string();
    if slug.is_empty() {
        "untitled".into()
    } else {
        slug
    }
}

fn page_path(data_root: &Path, slug: &str) -> PathBuf {
    pages_root(data_root).join(format!("{}.md", normalize_slug(slug)))
}

fn title_for(slug: &str, content: &str) -> String {
    content
        .lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
        .unwrap_or(slug)
        .to_string()
}

fn extract_links(content: &str) -> Vec<String> {
    let mut links = BTreeSet::new();
    let bytes = content.as_bytes();
    let mut index = 0;
    while index + 3 < bytes.len() {
        if &bytes[index..index + 2] == b"[["
            && let Some(end) = content[index + 2..].find("]]")
        {
            let raw = &content[index + 2..index + 2 + end];
            let target = raw.split('|').next().unwrap_or(raw).trim();
            if !target.is_empty() {
                links.insert(normalize_slug(target));
            }
            index += end + 4;
            continue;
        }
        index += 1;
    }
    links.into_iter().collect()
}

fn read_page(data_root: &Path, slug: &str) -> Result<BrainPage, String> {
    let slug = normalize_slug(slug);
    let path = page_path(data_root, &slug);
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read GBrain page '{slug}': {error}"))?;
    let source_path = read_page_meta(data_root, &slug)?;
    Ok(BrainPage {
        title: title_for(&slug, &content),
        links: extract_links(&content),
        updated_at: modified_string(&path),
        source_path,
        slug,
        content,
    })
}

fn write_page(data_root: &Path, slug: &str, content: &str) -> Result<(), String> {
    ensure_brain_dirs(data_root)?;
    fs::write(page_path(data_root, slug), content)
        .map_err(|error| format!("Failed to write GBrain page '{slug}': {error}"))
}

fn read_page_meta(data_root: &Path, slug: &str) -> Result<Option<String>, String> {
    let path = page_meta_path(data_root, slug);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read GBrain page metadata: {error}"))?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Failed to parse GBrain page metadata: {error}"))?;
    Ok(value
        .get("sourcePath")
        .and_then(Value::as_str)
        .map(str::to_string))
}

fn write_page_meta(
    data_root: &Path,
    slug: &str,
    source_path: Option<String>,
) -> Result<(), String> {
    ensure_brain_dirs(data_root)?;
    let Some(source_path) = source_path.filter(|path| !path.trim().is_empty()) else {
        return Ok(());
    };
    let value = serde_json::json!({
        "slug": normalize_slug(slug),
        "sourcePath": source_path,
        "updatedAt": now_string(),
    });
    fs::write(
        page_meta_path(data_root, slug),
        serde_json::to_string_pretty(&value)
            .map_err(|error| format!("Failed to encode GBrain page metadata: {error}"))?,
    )
    .map_err(|error| format!("Failed to write GBrain page metadata: {error}"))
}

fn read_all_pages(data_root: &Path) -> Result<Vec<BrainPage>, String> {
    ensure_brain_dirs(data_root)?;
    let mut pages = Vec::new();
    for entry in fs::read_dir(pages_root(data_root))
        .map_err(|error| format!("Failed to read GBrain pages: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Failed to read GBrain page entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        let Some(slug) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        pages.push(read_page(data_root, slug)?);
    }
    pages.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(pages)
}

fn import_vault(data_root: &Path, vault_path: &Path) -> Result<usize, String> {
    if !vault_path.is_dir() {
        return Err(format!(
            "Vault path is not a directory: {}",
            vault_path.display()
        ));
    }
    let mut imported = 0;
    import_vault_dir(data_root, vault_path, vault_path, &mut imported)?;
    Ok(imported)
}

fn import_vault_dir(
    data_root: &Path,
    root: &Path,
    dir: &Path,
    imported: &mut usize,
) -> Result<(), String> {
    for entry in fs::read_dir(dir)
        .map_err(|error| format!("Failed to read vault dir '{}': {error}", dir.display()))?
    {
        let entry = entry.map_err(|error| format!("Failed to read vault entry: {error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect '{}': {error}", path.display()))?;
        if file_type.is_dir() {
            import_vault_dir(data_root, root, &path, imported)?;
        } else if file_type.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("md")
        {
            let content = fs::read_to_string(&path).map_err(|error| {
                format!("Failed to read vault file '{}': {error}", path.display())
            })?;
            let relative = path.strip_prefix(root).unwrap_or(&path);
            let slug = normalize_slug(&relative.with_extension("").to_string_lossy());
            write_page(data_root, &slug, &content)?;
            write_page_meta(data_root, &slug, Some(path.to_string_lossy().to_string()))?;
            *imported += 1;
        }
    }
    Ok(())
}

fn search_pages(data_root: &Path, query: &str) -> Result<Vec<Value>, String> {
    let terms = query
        .split_whitespace()
        .map(|term| term.to_lowercase())
        .filter(|term| !term.is_empty())
        .collect::<Vec<_>>();
    let mut matches = Vec::new();
    for page in read_all_pages(data_root)? {
        let haystack = format!("{} {}", page.title, page.content).to_lowercase();
        let score = if terms.is_empty() {
            0
        } else {
            terms.iter().filter(|term| haystack.contains(*term)).count()
        };
        if score == 0 && !terms.is_empty() {
            continue;
        }
        matches.push((
            score,
            serde_json::json!({
                "slug": page.slug,
                "title": page.title,
                "score": score,
                "snippet": snippet(&page.content, &terms),
                "links": page.links,
            }),
        ));
    }
    matches.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(matches.into_iter().map(|(_, value)| value).collect())
}

fn snippet(content: &str, terms: &[String]) -> String {
    let lower = content.to_lowercase();
    let start = terms
        .iter()
        .find_map(|term| lower.find(term))
        .unwrap_or(0)
        .saturating_sub(80);
    let snippet = content.chars().skip(start).take(220).collect::<String>();
    snippet.replace('\n', " ").trim().to_string()
}

fn summarize_matches(matches: &[Value]) -> String {
    if matches.is_empty() {
        return "No matching GBrain pages found.".into();
    }
    let mut by_title = BTreeMap::new();
    for item in matches.iter().take(5) {
        if let (Some(title), Some(slug)) = (
            item.get("title").and_then(Value::as_str),
            item.get("slug").and_then(Value::as_str),
        ) {
            by_title.insert(title.to_string(), slug.to_string());
        }
    }
    format!(
        "Found {} matching page(s): {}",
        matches.len(),
        by_title
            .into_iter()
            .map(|(title, slug)| format!("{title} ({slug})"))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn read_jsonl_values(path: &Path) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read GBrain jsonl '{}': {error}", path.display()))?;
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line)
                .map_err(|error| format!("Failed to parse GBrain jsonl entry: {error}"))
        })
        .collect()
}

fn append_jsonl_value(path: &Path, value: &Value) -> Result<(), String> {
    let mut raw = String::new();
    if path.exists() {
        raw = fs::read_to_string(path).map_err(|error| {
            format!("Failed to read GBrain jsonl '{}': {error}", path.display())
        })?;
    }
    raw.push_str(
        &serde_json::to_string(value)
            .map_err(|error| format!("Failed to encode GBrain jsonl entry: {error}"))?,
    );
    raw.push('\n');
    fs::write(path, raw)
        .map_err(|error| format!("Failed to write GBrain jsonl '{}': {error}", path.display()))
}

fn suggestion_id(kind: &str, slug: &str, preview: &str) -> String {
    let hash = blake3::hash(format!("{kind}:{slug}:{preview}").as_bytes());
    format!("{kind}-{}-{}", normalize_slug(slug), &hash.to_hex()[..10])
}

fn make_suggestion(
    kind: &str,
    slug: &str,
    title: impl Into<String>,
    preview: impl Into<String>,
    confidence: f32,
    payload: Value,
) -> BrainSuggestion {
    let preview = preview.into();
    BrainSuggestion {
        id: suggestion_id(kind, slug, &preview),
        kind: kind.to_string(),
        slug: normalize_slug(slug),
        title: title.into(),
        preview,
        confidence,
        payload,
        created_at: now_string(),
        status: SuggestionStatus::Active,
    }
}

fn first_substantial_line(content: &str) -> String {
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .find(|line| !line.starts_with('#'))
        .unwrap_or_else(|| {
            content
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or("Untitled memory")
        })
        .chars()
        .take(180)
        .collect::<String>()
}

fn date_hint(content: &str) -> Option<String> {
    for token in content.split_whitespace() {
        let token = token.trim_matches(|ch: char| !ch.is_ascii_digit() && ch != '-');
        let parts = token.split('-').collect::<Vec<_>>();
        if parts.len() == 3
            && parts[0].len() == 4
            && parts[1].len() == 2
            && parts[2].len() == 2
            && parts
                .iter()
                .all(|part| part.chars().all(|ch| ch.is_ascii_digit()))
        {
            return Some(token.to_string());
        }
    }
    None
}

fn read_suggestions(data_root: &Path) -> Result<Vec<BrainSuggestion>, String> {
    read_jsonl_values(&suggestions_path(data_root))?
        .into_iter()
        .map(|value| {
            serde_json::from_value(value)
                .map_err(|error| format!("Failed to parse GBrain suggestion: {error}"))
        })
        .collect()
}

fn write_suggestions(data_root: &Path, suggestions: &[BrainSuggestion]) -> Result<(), String> {
    let raw = suggestions
        .iter()
        .map(|suggestion| {
            serde_json::to_string(suggestion)
                .map_err(|error| format!("Failed to encode GBrain suggestion: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("\n");
    let raw = if raw.is_empty() {
        raw
    } else {
        format!("{raw}\n")
    };
    fs::write(suggestions_path(data_root), raw)
        .map_err(|error| format!("Failed to write GBrain suggestions: {error}"))
}

fn merge_suggestions(
    data_root: &Path,
    slug: &str,
    next: Vec<BrainSuggestion>,
) -> Result<Vec<BrainSuggestion>, String> {
    let mut all = read_suggestions(data_root)?;
    let mut known = all
        .iter()
        .map(|suggestion| suggestion.id.clone())
        .collect::<BTreeSet<_>>();
    for suggestion in next {
        if known.insert(suggestion.id.clone()) {
            all.push(suggestion);
        }
    }
    write_suggestions(data_root, &all)?;
    Ok(all
        .into_iter()
        .filter(|suggestion| suggestion.slug == normalize_slug(slug))
        .filter(|suggestion| suggestion.status == SuggestionStatus::Active)
        .collect())
}

fn analyze_note(
    data_root: &Path,
    slug: &str,
    title: &str,
    content: &str,
    source_path: Option<String>,
) -> Result<Vec<BrainSuggestion>, String> {
    let slug = normalize_slug(slug);
    let mut suggestions = Vec::new();
    if read_page(data_root, &slug).is_err() {
        suggestions.push(make_suggestion(
            "rememberNote",
            &slug,
            "Remember note",
            title,
            0.96,
            serde_json::json!({
                "slug": slug,
                "content": content,
                "sourcePath": source_path,
            }),
        ));
    }

    let insight = first_substantial_line(content);
    if !insight.is_empty() {
        suggestions.push(make_suggestion(
            "extractInsight",
            &slug,
            "Extract insight",
            &insight,
            0.72,
            serde_json::json!({
                "slug": slug,
                "title": title,
                "insight": insight,
            }),
        ));
    }

    let existing = read_all_pages(data_root)?;
    let this_terms = significant_terms(&format!("{title} {content}"));
    let explicit_links = extract_links(content);
    let mut link_targets = explicit_links;
    for page in existing {
        if page.slug == slug {
            continue;
        }
        let overlap = significant_terms(&format!("{} {}", page.title, page.content))
            .intersection(&this_terms)
            .count();
        if overlap >= 2 {
            link_targets.push(page.slug);
        }
    }
    link_targets.sort();
    link_targets.dedup();
    for target in link_targets.into_iter().take(3) {
        suggestions.push(make_suggestion(
            "suggestLink",
            &slug,
            "Link memory",
            format!("{title} -> {target}"),
            0.66,
            serde_json::json!({ "from": slug, "to": target }),
        ));
    }

    if let Some(date) = date_hint(content) {
        suggestions.push(make_suggestion(
            "timelineEntry",
            &slug,
            "Add timeline",
            format!("{date} · {title}"),
            0.7,
            serde_json::json!({
                "slug": slug,
                "date": date,
                "summary": title,
            }),
        ));
    }

    merge_suggestions(data_root, &slug, suggestions)
}

fn significant_terms(value: &str) -> BTreeSet<String> {
    value
        .split(|ch: char| !ch.is_alphanumeric())
        .map(|term| term.to_lowercase())
        .filter(|term| term.chars().count() >= 2)
        .filter(|term| {
            !matches!(
                term.as_str(),
                "the" | "and" | "for" | "with" | "this" | "that" | "you" | "are"
            )
        })
        .collect()
}

fn list_related(data_root: &Path, slug: &str, query: &str) -> Result<Vec<Value>, String> {
    let focus = if slug.is_empty() {
        None
    } else {
        read_page(data_root, slug).ok()
    };
    let focus_terms = significant_terms(
        &focus
            .as_ref()
            .map(|page| format!("{} {} {}", page.title, page.content, query))
            .unwrap_or_else(|| query.to_string()),
    );
    let focus_slug = slug.to_string();
    let mut related = Vec::new();
    for page in read_all_pages(data_root)? {
        if !focus_slug.is_empty() && page.slug == focus_slug {
            continue;
        }
        let mut score = 0usize;
        if page
            .links
            .iter()
            .any(|link| normalize_slug(link) == focus_slug)
        {
            score += 4;
        }
        if focus
            .as_ref()
            .map(|focus| {
                focus
                    .links
                    .iter()
                    .any(|link| normalize_slug(link) == page.slug)
            })
            .unwrap_or(false)
        {
            score += 4;
        }
        let terms = significant_terms(&format!("{} {}", page.title, page.content));
        score += terms.intersection(&focus_terms).count();
        if score == 0 {
            continue;
        }
        let reason = if page
            .links
            .iter()
            .any(|link| normalize_slug(link) == focus_slug)
        {
            "backlink"
        } else if focus
            .as_ref()
            .map(|focus| {
                focus
                    .links
                    .iter()
                    .any(|link| normalize_slug(link) == page.slug)
            })
            .unwrap_or(false)
        {
            "linked"
        } else {
            "shared context"
        };
        related.push((
            score,
            serde_json::json!({
                "slug": page.slug,
                "title": page.title,
                "reason": reason,
                "score": score,
            }),
        ));
    }
    related.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(related
        .into_iter()
        .take(5)
        .map(|(_, value)| value)
        .collect())
}

fn update_suggestion_status(
    data_root: &Path,
    id: &str,
    status: SuggestionStatus,
) -> Result<BrainSuggestion, String> {
    let mut suggestions = read_suggestions(data_root)?;
    let Some(index) = suggestions
        .iter()
        .position(|suggestion| suggestion.id == id)
    else {
        return Err(format!("Unknown GBrain suggestion '{id}'"));
    };
    suggestions[index].status = status;
    let suggestion = suggestions[index].clone();
    write_suggestions(data_root, &suggestions)?;
    Ok(suggestion)
}

fn accept_suggestion(data_root: &Path, id: &str) -> Result<BrainSuggestion, String> {
    let suggestions = read_suggestions(data_root)?;
    let Some(suggestion) = suggestions
        .iter()
        .find(|suggestion| suggestion.id == id)
        .cloned()
    else {
        return Err(format!("Unknown GBrain suggestion '{id}'"));
    };
    match suggestion.kind.as_str() {
        "rememberNote" => {
            let slug = suggestion
                .payload
                .get("slug")
                .and_then(Value::as_str)
                .ok_or_else(|| "rememberNote suggestion missing slug".to_string())?;
            let content = suggestion
                .payload
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| "rememberNote suggestion missing content".to_string())?;
            let source_path = suggestion
                .payload
                .get("sourcePath")
                .and_then(Value::as_str)
                .map(str::to_string);
            write_page(data_root, slug, content)?;
            write_page_meta(data_root, slug, source_path)?;
        }
        "extractInsight" => {
            append_jsonl_value(&insights_path(data_root), &suggestion.payload)?;
        }
        "suggestLink" => {
            let from = suggestion
                .payload
                .get("from")
                .and_then(Value::as_str)
                .ok_or_else(|| "suggestLink suggestion missing from".to_string())?;
            let to = suggestion
                .payload
                .get("to")
                .and_then(Value::as_str)
                .ok_or_else(|| "suggestLink suggestion missing to".to_string())?;
            let mut page = read_page(data_root, from).unwrap_or_else(|_| BrainPage {
                slug: normalize_slug(from),
                title: normalize_slug(from),
                content: format!("# {}\n", normalize_slug(from)),
                links: Vec::new(),
                updated_at: now_string(),
                source_path: None,
            });
            let link = format!("[[{}]]", normalize_slug(to));
            if !page.content.contains(&link) {
                page.content.push_str(&format!("\n{link}\n"));
            }
            write_page(data_root, from, &page.content)?;
        }
        "timelineEntry" => {
            let entry = TimelineEntry {
                slug: normalize_slug(
                    suggestion
                        .payload
                        .get("slug")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "timelineEntry suggestion missing slug".to_string())?,
                ),
                date: suggestion
                    .payload
                    .get("date")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "timelineEntry suggestion missing date".to_string())?
                    .to_string(),
                summary: suggestion
                    .payload
                    .get("summary")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "timelineEntry suggestion missing summary".to_string())?
                    .to_string(),
            };
            append_timeline(data_root, &entry)?;
            append_jsonl_value(&events_path(data_root), &suggestion.payload)?;
        }
        _ => {}
    }
    update_suggestion_status(data_root, id, SuggestionStatus::Accepted)
}

fn read_timeline(data_root: &Path) -> Result<Vec<TimelineEntry>, String> {
    let path = timeline_path(data_root);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read GBrain timeline: {error}"))?;
    let mut entries: Vec<TimelineEntry> = Vec::new();
    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        entries.push(
            serde_json::from_str(line)
                .map_err(|error| format!("Failed to parse GBrain timeline entry: {error}"))?,
        );
    }
    entries.sort_by(|a, b| a.date.cmp(&b.date));
    Ok(entries)
}

fn append_timeline(data_root: &Path, entry: &TimelineEntry) -> Result<(), String> {
    ensure_brain_dirs(data_root)?;
    let mut raw = String::new();
    if timeline_path(data_root).exists() {
        raw = fs::read_to_string(timeline_path(data_root))
            .map_err(|error| format!("Failed to read GBrain timeline: {error}"))?;
    }
    raw.push_str(
        &serde_json::to_string(entry)
            .map_err(|error| format!("Failed to encode timeline entry: {error}"))?,
    );
    raw.push('\n');
    fs::write(timeline_path(data_root), raw)
        .map_err(|error| format!("Failed to write GBrain timeline: {error}"))
}

fn run_builtin_llmwiki(
    data_root: &Path,
    operation: &str,
    params: &Value,
) -> Result<String, String> {
    let wiki_home = llmwiki_home_root(data_root, params)?;
    let data_root = wiki_home.as_path();

    match operation {
        "version" => Ok("llmwiki-kuku 0.1.0".into()),
        "init" => {
            ensure_llmwiki_seed_files(data_root)?;
            append_wiki_log(data_root, "init", "Initialized LLM Wiki")?;
            json_string(&serde_json::json!({
                "ok": true,
                "home": data_root.to_string_lossy(),
                "raw": llmwiki_raw_root(data_root).to_string_lossy(),
                "wiki": llmwiki_wiki_root(data_root).to_string_lossy(),
            }))
        }
        "status" => {
            if !data_root.exists() {
                return json_string(&serde_json::json!({
                    "ok": false,
                    "engine": "kuku-builtin-llmwiki",
                    "pages": 0,
                    "sources": 0,
                    "links": 0,
                    "orphans": 0,
                    "concepts": 0,
                    "entities": 0,
                    "synthesis": 0,
                }));
            }
            let pages = read_llmwiki_pages(data_root)?;
            let categories = llmwiki_category_counts(&pages);
            json_string(&serde_json::json!({
                "ok": true,
                "engine": "kuku-builtin-llmwiki",
                "pages": pages.len(),
                "sources": llmwiki_source_count(data_root)?,
                "links": llmwiki_edge_count(&pages),
                "orphans": llmwiki_orphans(&pages).len(),
                "concepts": categories.get("concepts").copied().unwrap_or_default(),
                "entities": categories.get("entities").copied().unwrap_or_default(),
                "synthesis": categories.get("synthesis").copied().unwrap_or_default(),
                "home": data_root.to_string_lossy(),
                "rawPath": llmwiki_raw_root(data_root).to_string_lossy(),
                "wikiPath": llmwiki_wiki_root(data_root).to_string_lossy(),
                "schemaPath": data_root.join("SCHEMA.md").to_string_lossy(),
            }))
        }
        "ingestSource" => {
            ensure_llmwiki_seed_files(data_root)?;
            let title = string_param(params, "title")?;
            let content = string_param(params, "content")?;
            let source_path = params
                .get("sourcePath")
                .and_then(Value::as_str)
                .map(str::to_string);
            let result = ingest_llmwiki_source(data_root, &title, &content, source_path)?;
            json_string(&result)
        }
        "search" => {
            let query = string_param(params, "query")?;
            json_string(&search_llmwiki_pages(data_root, &query)?)
        }
        "queryContext" => {
            let query = string_param(params, "query")?;
            let matches = search_llmwiki_pages(data_root, &query)?;
            json_string(&serde_json::json!({
                "query": query,
                "matches": matches,
                "instruction": "Answer from the persistent LLM Wiki first. Cite page paths when useful. Suggest wiki updates if the answer should be filed back."
            }))
        }
        "listPages" => json_string(&read_llmwiki_pages(data_root)?),
        "analyzeCorpus" => json_string(&analyze_llmwiki_corpus(data_root)?),
        "readPage" => {
            let path = safe_llmwiki_relative_path(&string_param(params, "path")?)?;
            let full = llmwiki_wiki_root(data_root).join(&path);
            let content = fs::read_to_string(&full).map_err(|error| {
                format!("Failed to read LLM Wiki page '{}': {error}", path.display())
            })?;
            json_string(&serde_json::json!({
                "path": path.to_string_lossy(),
                "title": title_for(&normalize_slug(&path.to_string_lossy()), &content),
                "content": content,
                "links": extract_links(&content),
                "updatedAt": modified_string(&full),
            }))
        }
        "writePage" => {
            ensure_llmwiki_seed_files(data_root)?;
            let path = safe_llmwiki_relative_path(&string_param(params, "path")?)?;
            let content = string_param(params, "content")?;
            let full = llmwiki_wiki_root(data_root).join(&path);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Failed to create wiki page dir: {error}"))?;
            }
            fs::write(&full, content).map_err(|error| {
                format!(
                    "Failed to write LLM Wiki page '{}': {error}",
                    path.display()
                )
            })?;
            update_llmwiki_index(data_root)?;
            append_wiki_log(data_root, "write", &path.to_string_lossy())?;
            json_string(&serde_json::json!({ "ok": true, "path": path.to_string_lossy() }))
        }
        "lint" => json_string(&lint_llmwiki(data_root)?),
        "graph" => {
            let pages = read_llmwiki_pages(data_root)?;
            let nodes = pages
                .iter()
                .map(|page| {
                    serde_json::json!({
                        "id": page.get("slug").and_then(Value::as_str).unwrap_or_default(),
                        "title": page.get("title").and_then(Value::as_str).unwrap_or_default(),
                        "path": page.get("path").and_then(Value::as_str).unwrap_or_default(),
                    })
                })
                .collect::<Vec<_>>();
            let edges = llmwiki_edges(&pages);
            json_string(&serde_json::json!({ "nodes": nodes, "edges": edges }))
        }
        _ => Err(format!(
            "Built-in LLM Wiki operation '{operation}' is not implemented"
        )),
    }
}

fn ensure_llmwiki_dirs(data_root: &Path) -> Result<(), String> {
    fs::create_dir_all(llmwiki_raw_root(data_root))
        .map_err(|error| format!("Failed to create LLM Wiki raw dir: {error}"))?;
    for dir in ["entities", "concepts", "sources", "synthesis"] {
        fs::create_dir_all(llmwiki_wiki_root(data_root).join(dir))
            .map_err(|error| format!("Failed to create LLM Wiki dir '{dir}': {error}"))?;
    }
    Ok(())
}

fn llmwiki_home_root(fallback_data_root: &Path, params: &Value) -> Result<PathBuf, String> {
    let Some(vault_path) = params.get("vaultPath").and_then(Value::as_str) else {
        return Ok(fallback_data_root.to_path_buf());
    };
    if vault_path.trim().is_empty() {
        return Ok(fallback_data_root.to_path_buf());
    }
    let vault_root = Path::new(vault_path);
    if !vault_root.is_dir() {
        return Err(format!(
            "Vault path is not a directory: {}",
            vault_root.display()
        ));
    }
    Ok(vault_root.join("LLM Wiki"))
}

fn ensure_llmwiki_seed_files(data_root: &Path) -> Result<(), String> {
    ensure_llmwiki_dirs(data_root)?;
    write_if_missing(
        &llmwiki_wiki_root(data_root).join("index.md"),
        "# LLM Wiki Index\n\nThis index is maintained as sources are ingested.\n",
    )?;
    write_if_missing(
        &llmwiki_wiki_root(data_root).join("log.md"),
        "# LLM Wiki Log\n",
    )?;
    write_if_missing(
        &data_root.join("SCHEMA.md"),
        "# LLM Wiki Schema\n\n- `_raw/` is immutable source material.\n- `sources/` contains source summaries.\n- `entities/`, `concepts/`, and `synthesis/` are maintained by the LLM.\n- Update `index.md` and append `log.md` after every ingest or meaningful query.\n- Prefer wikilinks like `[[concept]]` for cross-references.\n",
    )?;
    Ok(())
}

fn write_if_missing(path: &Path, content: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create '{}': {error}", parent.display()))?;
    }
    fs::write(path, content)
        .map_err(|error| format!("Failed to write '{}': {error}", path.display()))
}

fn llmwiki_raw_root(data_root: &Path) -> PathBuf {
    data_root.join("_raw")
}

fn llmwiki_wiki_root(data_root: &Path) -> PathBuf {
    data_root.to_path_buf()
}

fn ingest_llmwiki_source(
    data_root: &Path,
    title: &str,
    content: &str,
    source_path: Option<String>,
) -> Result<Value, String> {
    let slug = normalize_slug(title);
    let raw_path = llmwiki_raw_root(data_root).join(format!("{slug}.md"));
    fs::write(&raw_path, content)
        .map_err(|error| format!("Failed to write LLM Wiki raw source: {error}"))?;

    let summary = llmwiki_summary(content);
    let links = llmwiki_candidate_links(title, content);
    let facts = llmwiki_key_points(content);
    let questions = llmwiki_open_questions(content);
    let wikilinks = links
        .iter()
        .map(|link| format!("[[{link}]]"))
        .collect::<Vec<_>>()
        .join(" ");
    let source_line = source_path
        .as_ref()
        .map(|path| format!("- Source path: `{path}`\n"))
        .unwrap_or_default();
    let page = format!(
        "---\ntitle: \"{}\"\ntype: source\nsource_count: 1\nupdated: {}\n---\n\n# {}\n\n## Summary\n{}\n\n## Extracted Points\n{}\n\n## Open Questions\n{}\n\n## Key Links\n{}\n\n## Raw Source\n- Raw file: `_raw/{}.md`\n{}",
        title.replace('"', "\\\""),
        now_string(),
        title,
        summary,
        markdown_list(&facts, "_No durable points extracted yet._"),
        markdown_list(&questions, "_No explicit questions found._"),
        if wikilinks.is_empty() {
            "_No candidate links yet._".to_string()
        } else {
            wikilinks
        },
        slug,
        source_line,
    );
    let wiki_path = llmwiki_wiki_root(data_root)
        .join("sources")
        .join(format!("{slug}.md"));
    fs::write(&wiki_path, page)
        .map_err(|error| format!("Failed to write LLM Wiki source page: {error}"))?;
    ensure_concept_pages(data_root, &slug, &links)?;
    update_llmwiki_index(data_root)?;
    append_wiki_log(data_root, "ingest", title)?;

    Ok(serde_json::json!({
        "ok": true,
        "slug": slug,
        "title": title,
        "path": format!("sources/{slug}.md"),
        "summary": summary,
        "candidateLinks": links,
        "facts": facts,
        "questions": questions,
    }))
}

fn llmwiki_summary(content: &str) -> String {
    let mut sentences = content
        .split(['.', '\n'])
        .map(str::trim)
        .filter(|line| line.chars().count() > 20)
        .take(3)
        .map(|line| {
            if line.ends_with('.') {
                line.to_string()
            } else {
                format!("{line}.")
            }
        })
        .collect::<Vec<_>>();
    if sentences.is_empty() {
        sentences.push(content.chars().take(220).collect::<String>());
    }
    sentences.join(" ")
}

fn llmwiki_candidate_links(title: &str, content: &str) -> Vec<String> {
    let mut links = BTreeSet::new();
    for link in extract_links(content) {
        links.insert(link);
    }
    for word in title
        .split(|ch: char| !ch.is_alphanumeric())
        .chain(content.split_whitespace().take(80))
    {
        let clean = word.trim_matches(|ch: char| !ch.is_alphanumeric()).trim();
        if clean.chars().count() >= 4 {
            links.insert(normalize_slug(clean));
        }
        if links.len() >= 5 {
            break;
        }
    }
    links.into_iter().collect()
}

fn llmwiki_key_points(content: &str) -> Vec<String> {
    let mut points = BTreeSet::new();
    for line in content.lines().map(str::trim) {
        let cleaned = line
            .trim_start_matches(['-', '*', '#', '>'])
            .trim()
            .to_string();
        let lower = cleaned.to_lowercase();
        let looks_durable = cleaned.chars().count() >= 28
            && (line.starts_with("- ")
                || line.starts_with("* ")
                || lower.contains(" is ")
                || lower.contains(" are ")
                || lower.contains(" means ")
                || lower.contains(" because ")
                || lower.contains("therefore")
                || cleaned.contains("은 ")
                || cleaned.contains("는 ")
                || cleaned.contains("이다")
                || cleaned.contains("때문"));
        if looks_durable {
            points.insert(cleaned.chars().take(220).collect::<String>());
        }
        if points.len() >= 7 {
            break;
        }
    }
    points.into_iter().collect()
}

fn llmwiki_open_questions(content: &str) -> Vec<String> {
    let mut questions = BTreeSet::new();
    for line in content.lines().map(str::trim) {
        let lower = line.to_lowercase();
        if line.contains('?')
            || lower.contains("todo")
            || lower.contains("unknown")
            || lower.contains("unclear")
            || lower.contains("gap")
            || line.contains("궁금")
            || line.contains("모름")
            || line.contains("해야")
        {
            let cleaned = line.trim_start_matches(['-', '*', '#', '>']).trim();
            if cleaned.chars().count() >= 8 {
                questions.insert(cleaned.chars().take(220).collect::<String>());
            }
        }
        if questions.len() >= 5 {
            break;
        }
    }
    questions.into_iter().collect()
}

fn markdown_list(items: &[String], empty: &str) -> String {
    if items.is_empty() {
        return empty.to_string();
    }
    items
        .iter()
        .map(|item| format!("- {item}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn ensure_concept_pages(
    data_root: &Path,
    source_slug: &str,
    links: &[String],
) -> Result<(), String> {
    for concept in links.iter().take(5) {
        let path = llmwiki_wiki_root(data_root)
            .join("concepts")
            .join(format!("{}.md", normalize_slug(concept)));
        if path.exists() {
            let mut raw = fs::read_to_string(&path).map_err(|error| {
                format!("Failed to read concept page '{}': {error}", path.display())
            })?;
            let reference = format!("[[{source_slug}]]");
            if !raw.contains(&reference) {
                raw.push_str(&format!("\n- Seen in {reference}\n"));
                fs::write(&path, raw).map_err(|error| {
                    format!(
                        "Failed to update concept page '{}': {error}",
                        path.display()
                    )
                })?;
            }
            continue;
        }
        let title = concept.replace('-', " ");
        let raw = format!(
            "---\ntitle: \"{}\"\ntype: concept\nupdated: {}\n---\n\n# {}\n\n## Working Definition\n_To be refined by AI Chat after more sources arrive._\n\n## Evidence\n- Seen in [[{}]]\n\n## Related\n[[{}]]\n",
            title.replace('"', "\\\""),
            now_string(),
            title,
            source_slug,
            source_slug,
        );
        fs::write(&path, raw).map_err(|error| {
            format!("Failed to write concept page '{}': {error}", path.display())
        })?;
    }
    Ok(())
}

fn read_llmwiki_pages(data_root: &Path) -> Result<Vec<Value>, String> {
    if !data_root.exists() {
        return Ok(Vec::new());
    }
    let mut pages = Vec::new();
    read_llmwiki_pages_dir(
        &llmwiki_wiki_root(data_root),
        &llmwiki_wiki_root(data_root),
        &mut pages,
    )?;
    pages.sort_by(|a, b| {
        a.get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(b.get("path").and_then(Value::as_str).unwrap_or_default())
    });
    Ok(pages)
}

fn read_llmwiki_pages_dir(root: &Path, dir: &Path, pages: &mut Vec<Value>) -> Result<(), String> {
    for entry in fs::read_dir(dir)
        .map_err(|error| format!("Failed to read LLM Wiki dir '{}': {error}", dir.display()))?
    {
        let entry = entry.map_err(|error| format!("Failed to read LLM Wiki entry: {error}"))?;
        let path = entry.path();
        if path.file_name().and_then(|name| name.to_str()) == Some("_raw") {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect '{}': {error}", path.display()))?;
        if file_type.is_dir() {
            read_llmwiki_pages_dir(root, &path, pages)?;
        } else if file_type.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("md")
        {
            let content = fs::read_to_string(&path).map_err(|error| {
                format!("Failed to read LLM Wiki page '{}': {error}", path.display())
            })?;
            let relative = path.strip_prefix(root).unwrap_or(&path);
            let stem = relative.with_extension("").to_string_lossy().to_string();
            let slug = normalize_slug(&stem);
            pages.push(serde_json::json!({
                "path": relative.to_string_lossy(),
                "slug": slug,
                "title": title_for(&stem, &content),
                "links": extract_links(&content),
                "bytes": content.len(),
                "updatedAt": modified_string(&path),
            }));
        }
    }
    Ok(())
}

fn search_llmwiki_pages(data_root: &Path, query: &str) -> Result<Vec<Value>, String> {
    let query_lc = query.to_lowercase();
    let mut matches = Vec::new();
    for page in read_llmwiki_pages(data_root)? {
        let Some(path) = page.get("path").and_then(Value::as_str) else {
            continue;
        };
        let full = llmwiki_wiki_root(data_root).join(path);
        let content = fs::read_to_string(&full).unwrap_or_default();
        let haystack = format!(
            "{}\n{}",
            page.get("title")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            content
        )
        .to_lowercase();
        let score = query_lc
            .split_whitespace()
            .filter(|term| !term.is_empty() && haystack.contains(term))
            .count();
        if score == 0 && !query_lc.is_empty() {
            continue;
        }
        let excerpt = content
            .lines()
            .find(|line| line.to_lowercase().contains(&query_lc))
            .unwrap_or_else(|| {
                content
                    .lines()
                    .find(|line| !line.trim().is_empty())
                    .unwrap_or("")
            })
            .chars()
            .take(260)
            .collect::<String>();
        matches.push(serde_json::json!({
            "path": path,
            "slug": page.get("slug").and_then(Value::as_str).unwrap_or_default(),
            "title": page.get("title").and_then(Value::as_str).unwrap_or_default(),
            "score": score,
            "excerpt": excerpt,
        }));
    }
    matches.sort_by(|a, b| {
        b.get("score")
            .and_then(Value::as_u64)
            .unwrap_or_default()
            .cmp(&a.get("score").and_then(Value::as_u64).unwrap_or_default())
    });
    matches.truncate(8);
    Ok(matches)
}

fn update_llmwiki_index(data_root: &Path) -> Result<(), String> {
    let pages = read_llmwiki_pages(data_root)?;
    let mut raw = "# LLM Wiki Index\n\n".to_string();
    for category in ["sources", "entities", "concepts", "synthesis"] {
        raw.push_str(&format!("## {}\n", category));
        let mut any = false;
        for page in &pages {
            let path = page.get("path").and_then(Value::as_str).unwrap_or_default();
            if !path.starts_with(category) {
                continue;
            }
            any = true;
            raw.push_str(&format!(
                "- [[{}|{}]] - {} bytes\n",
                page.get("slug").and_then(Value::as_str).unwrap_or_default(),
                page.get("title").and_then(Value::as_str).unwrap_or(path),
                page.get("bytes")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
            ));
        }
        if !any {
            raw.push_str("- _empty_\n");
        }
        raw.push('\n');
    }
    fs::write(llmwiki_wiki_root(data_root).join("index.md"), raw)
        .map_err(|error| format!("Failed to update LLM Wiki index: {error}"))
}

fn append_wiki_log(data_root: &Path, kind: &str, title: &str) -> Result<(), String> {
    ensure_llmwiki_dirs(data_root)?;
    let path = llmwiki_wiki_root(data_root).join("log.md");
    let mut raw = fs::read_to_string(&path).unwrap_or_else(|_| "# LLM Wiki Log\n".into());
    raw.push_str(&format!("\n## [{}] {} | {}\n", now_string(), kind, title));
    fs::write(path, raw).map_err(|error| format!("Failed to append LLM Wiki log: {error}"))
}

fn safe_llmwiki_relative_path(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if path.is_absolute() {
        return Err("LLM Wiki path must be relative".into());
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(part) => out.push(part),
            std::path::Component::CurDir => {}
            _ => return Err(format!("Invalid LLM Wiki path: {raw}")),
        }
    }
    if out.extension().and_then(|ext| ext.to_str()) != Some("md") {
        out.set_extension("md");
    }
    Ok(out)
}

fn llmwiki_source_count(data_root: &Path) -> Result<usize, String> {
    if !llmwiki_raw_root(data_root).exists() {
        return Ok(0);
    }
    let mut count = 0;
    for entry in fs::read_dir(llmwiki_raw_root(data_root))
        .map_err(|error| format!("Failed to read LLM Wiki raw dir: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Failed to read raw source entry: {error}"))?;
        if entry.path().extension().and_then(|ext| ext.to_str()) == Some("md") {
            count += 1;
        }
    }
    Ok(count)
}

fn llmwiki_edge_count(pages: &[Value]) -> usize {
    pages
        .iter()
        .map(|page| {
            page.get("links")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or_default()
        })
        .sum()
}

fn llmwiki_category_counts(pages: &[Value]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for page in pages {
        let path = page.get("path").and_then(Value::as_str).unwrap_or_default();
        let category = path
            .split('/')
            .next()
            .unwrap_or("root")
            .trim_end_matches(".md");
        *counts.entry(category.to_string()).or_insert(0) += 1;
    }
    counts
}

fn llmwiki_edges(pages: &[Value]) -> Vec<Value> {
    let known = pages
        .iter()
        .filter_map(|page| page.get("slug").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    let mut edges = Vec::new();
    for page in pages {
        let from = page.get("slug").and_then(Value::as_str).unwrap_or_default();
        for link in page
            .get("links")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if known.contains(link) {
                edges.push(serde_json::json!({ "from": from, "to": link }));
            }
        }
    }
    edges
}

fn llmwiki_orphans(pages: &[Value]) -> Vec<String> {
    let linked = pages
        .iter()
        .flat_map(|page| {
            page.get("links")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
        })
        .collect::<BTreeSet<_>>();
    pages
        .iter()
        .filter_map(|page| page.get("slug").and_then(Value::as_str))
        .filter(|slug| *slug != "index" && *slug != "log" && !linked.contains(slug))
        .map(str::to_string)
        .collect()
}

fn lint_llmwiki(data_root: &Path) -> Result<Value, String> {
    let pages = read_llmwiki_pages(data_root)?;
    let known = pages
        .iter()
        .filter_map(|page| page.get("slug").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    let mut broken_links = Vec::new();
    for page in &pages {
        let from = page.get("slug").and_then(Value::as_str).unwrap_or_default();
        for link in page
            .get("links")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !known.contains(link) {
                broken_links.push(serde_json::json!({ "from": from, "to": link }));
            }
        }
    }
    let orphans = llmwiki_orphans(&pages);
    json_string(&serde_json::json!({
        "ok": broken_links.is_empty(),
        "pages": pages.len(),
        "brokenLinks": broken_links,
        "orphans": orphans,
        "recommendations": [
            "Ask AI Chat to turn recurring orphan concepts into concept pages.",
            "Ingest one source at a time when accuracy matters.",
            "File useful query answers back into wiki/synthesis/."
        ],
    }))
    .and_then(|raw| {
        serde_json::from_str(&raw).map_err(|error| format!("Failed to lint wiki: {error}"))
    })
}

fn analyze_llmwiki_corpus(data_root: &Path) -> Result<Value, String> {
    let pages = read_llmwiki_pages(data_root)?;
    let lint = lint_llmwiki(data_root)?;
    let categories = llmwiki_category_counts(&pages);
    let top_concepts = llmwiki_top_concepts(data_root)?;
    let sparse_pages = pages
        .iter()
        .filter(|page| {
            page.get("bytes")
                .and_then(Value::as_u64)
                .unwrap_or_default()
                < 420
        })
        .take(8)
        .map(|page| {
            serde_json::json!({
                "path": page.get("path").and_then(Value::as_str).unwrap_or_default(),
                "title": page.get("title").and_then(Value::as_str).unwrap_or_default(),
                "bytes": page.get("bytes").and_then(Value::as_u64).unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    let synthesis_candidates = top_concepts
        .iter()
        .take(5)
        .map(|concept| {
            let name = concept
                .get("concept")
                .and_then(Value::as_str)
                .unwrap_or_default();
            serde_json::json!({
                "title": format!("Synthesize {name}"),
                "targetPath": format!("synthesis/{}.md", normalize_slug(name)),
                "reason": "Recurring concept appears across the wiki and deserves a compiled page."
            })
        })
        .collect::<Vec<_>>();
    let questions = llmwiki_corpus_questions(data_root)?;

    json_string(&serde_json::json!({
        "ok": true,
        "pages": pages.len(),
        "categories": categories,
        "topConcepts": top_concepts,
        "sparsePages": sparse_pages,
        "synthesisCandidates": synthesis_candidates,
        "questions": questions,
        "lint": lint,
        "policy": [
            "Prefer source pages for provenance.",
            "Promote recurring terms into concept/entity pages.",
            "Promote repeated cross-source answers into synthesis pages.",
            "Keep log/index updated after every meaningful wiki mutation."
        ]
    }))
    .and_then(|raw| {
        serde_json::from_str(&raw).map_err(|error| format!("Failed to analyze wiki: {error}"))
    })
}

fn llmwiki_top_concepts(data_root: &Path) -> Result<Vec<Value>, String> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for page in read_llmwiki_pages(data_root)? {
        for link in page
            .get("links")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            *counts.entry(link.to_string()).or_insert(0) += 1;
        }
    }
    let mut ranked = counts
        .into_iter()
        .map(|(concept, count)| serde_json::json!({ "concept": concept, "count": count }))
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| {
        b.get("count")
            .and_then(Value::as_u64)
            .unwrap_or_default()
            .cmp(&a.get("count").and_then(Value::as_u64).unwrap_or_default())
    });
    ranked.truncate(8);
    Ok(ranked)
}

fn llmwiki_corpus_questions(data_root: &Path) -> Result<Vec<String>, String> {
    let mut questions = BTreeSet::new();
    for page in read_llmwiki_pages(data_root)? {
        let Some(path) = page.get("path").and_then(Value::as_str) else {
            continue;
        };
        let content =
            fs::read_to_string(llmwiki_wiki_root(data_root).join(path)).unwrap_or_default();
        for question in llmwiki_open_questions(&content) {
            questions.insert(question);
        }
        if questions.len() >= 8 {
            break;
        }
    }
    Ok(questions.into_iter().collect())
}
