mod cloud;
mod connections;
use kuku_memory::{Actor, Remember, Store, brief};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Manager};
static EXTRACTION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static REMEMBER_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct ScopePolicy {
    pub auto_save: bool,
    pub shared: bool,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Policy {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub writes_enabled: bool,
    #[serde(default)]
    pub cloud_enabled: bool,
    #[serde(default)]
    pub scopes: BTreeMap<String, ScopePolicy>,
}
pub fn policy(root: &Path) -> Result<Policy, String> {
    let path = root.join(".kuku/knowledge/access.json");
    kuku_memory::ensure_safe(root, &path)?;
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Policy::default()),
        Err(e) => Err(e.to_string()),
    }
}
pub fn ui_actor(root: &Path) -> Result<Actor, String> {
    let p = policy(root)?;
    Ok(Actor {
        client: "kuku".into(),
        scopes: p
            .scopes
            .keys()
            .cloned()
            .chain(std::iter::once("personal".into()))
            .collect(),
        auto_scopes: p
            .scopes
            .keys()
            .cloned()
            .chain(std::iter::once("personal".into()))
            .collect(),
    })
}

pub async fn dispatch(
    root: PathBuf,
    actor: Actor,
    method: String,
    params: Value,
    external: bool,
) -> Result<Value, String> {
    let started = std::time::Instant::now();
    // Never log model input, memory text, scopes, source paths or credentials.
    let tool = match method.as_str() {
        "memory_context" => "memory_context",
        "memory_checkpoint" => "memory_checkpoint",
        "memory_search" => "memory_search",
        "memory_read" => "memory_read",
        "memory_remember" => "memory_remember",
        _ => "unknown",
    };
    let result = dispatch_inner(root, actor, method, params, external).await;
    eprintln!(
        "memory_tool name={tool} duration_ms={} success={}",
        started.elapsed().as_millis(),
        result.is_ok()
    );
    result
}

async fn dispatch_inner(
    root: PathBuf,
    actor: Actor,
    method: String,
    params: Value,
    external: bool,
) -> Result<Value, String> {
    let p = policy(&root)?;
    if external && !p.enabled {
        return Err("Memory connections are disabled in Kuku settings".into());
    }
    if method == "memory_remember" || method == "memory_checkpoint" {
        let _remember_guard = REMEMBER_LOCK.lock().await;
        if !p.writes_enabled {
            return Err("Memory writes are paused in Kuku settings".into());
        }
        let input: Remember = if method == "memory_checkpoint" {
            serde_json::from_value::<kuku_memory::checkpoint::Checkpoint>(params)
                .map_err(|e| e.to_string())?
                .into_remember()?
        } else {
            serde_json::from_value(params).map_err(|e| e.to_string())?
        };
        let share = p.scopes.get(&input.scope).is_some_and(|s| s.shared);
        let outcome = {
            let root = root.clone();
            let actor = actor.clone();
            let input = input.clone();
            tauri::async_runtime::spawn_blocking(move || {
                Store::open(&root)?.remember_in_scope(&actor, input, share)
            })
            .await
            .map_err(|e| e.to_string())??
        };
        if outcome.status == "proposed" {
            if outcome.decision_path.is_some() {
                return serde_json::to_value(outcome).map_err(|e| e.to_string());
            }
            // Reuse the existing review/apply path; a pending correction is
            // represented as a new superseding proposal, never a raw write.
            use crate::knowledge::models::*;
            let proposed = Store::open(&root)?.pending_memory(&actor, &outcome.id)?;
            let refs: Vec<SourceRefInput> = proposed
                .source_refs
                .iter()
                .filter(|s| !s.path.contains("://"))
                .map(|s| SourceRefInput {
                    path: s.path.clone(),
                    title: s.title.clone(),
                    section_path: None,
                    range: None,
                    checksum: None,
                    captured_at: Some(s.captured_at.clone()),
                })
                .collect();
            let request = CreateDecisionDocumentRequest {
                title: Some(input.title.clone()),
                context: Some(format!(
                    "Memory from {} in scope {}. {}",
                    actor.client,
                    input.scope,
                    input
                        .id
                        .as_deref()
                        .map(|id| format!(
                            "Correction of {id}; verify the previous memory before applying."
                        ))
                        .unwrap_or_default()
                )),
                source_refs: vec![],
                proposed_memories: vec![ProposedMemoryInput {
                    suggested_id: Some(outcome.id.clone()),
                    kind: proposed.kind,
                    title: input.title,
                    body: input.body,
                    tags: proposed.tags,
                    source_refs: refs,
                    decision: None,
                }],
                request_source: Some(ProposalRequestSource::AiTool),
                default_selection: ProposalDefaultSelection::None,
            };
            let created = crate::knowledge::proposal::create_decision_document_for_root(
                &root,
                request,
                ProposalRequestSource::AiTool,
            )
            .await
            .map_err(|e| e.message)?;
            {
                let root = root.clone();
                let client = actor.client.clone();
                let request = input.request_id.clone();
                let path = created.path.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    Store::open(&root)?.attach_decision(&client, &request, &path)
                })
                .await
                .map_err(|e| e.to_string())??;
            }
            let mut value = serde_json::to_value(outcome).map_err(|e| e.to_string())?;
            value["decision_path"] = json!(created.path.clone());
            value["review"] = serde_json::to_value(created).map_err(|e| e.to_string())?;
            return Ok(value);
        }
        let id = outcome.id.clone();
        let mut result = serde_json::to_value(outcome).map_err(|e| e.to_string())?;
        let queued = {
            let root = root.clone();
            let id = id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                Ok::<_, String>(
                    Store::open(&root)?
                        .pending_cloud()?
                        .iter()
                        .any(|m| m["id"] == id),
                )
            })
            .await
            .map_err(|e| e.to_string())??
        };
        if queued && p.cloud_enabled {
            result["cloud_sync"] = match tokio::time::timeout(
                std::time::Duration::from_secs(8),
                cloud::sync(&root),
            )
            .await
            {
                Ok(Ok(sync)) => {
                    let root = root.clone();
                    let pending = tauri::async_runtime::spawn_blocking(move || {
                        Store::open(&root)?.pending_cloud()
                    })
                    .await;
                    let state = match pending {
                        Ok(Ok(entries)) => entries
                            .iter()
                            .find(|entry| entry["id"] == id)
                            .map(|entry| {
                                if entry["state"] == "conflict" {
                                    "conflict"
                                } else {
                                    "queued"
                                }
                            })
                            .unwrap_or("synced"),
                        _ => "queued",
                    };
                    json!({"status":state,"details":sync})
                }
                _ => {
                    json!({"status":"queued","message":"Saved locally; web AI sees the previous version until synchronization completes."})
                }
            };
        }
        return Ok(result);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let store = Store::open(&root)?;
        match method.as_str() {
            "memory_context" | "memory_search" => {
                let query = params["query"].as_str().unwrap_or("");
                let limit = params["limit"]
                    .as_u64()
                    .unwrap_or(if method == "memory_context" { 5 } else { 10 })
                    as usize;
                let limit = if method == "memory_context" {
                    limit.min(5)
                } else {
                    limit
                };
                let records = store.search_filtered(
                    &actor,
                    query,
                    params["scope"].as_str(),
                    limit,
                    params["task_id"].as_str(),
                    params["kind"].as_str(),
                )?;
                let context = kuku_memory::checkpoint::context(
                    &records,
                    params["max_chars"].as_u64().unwrap_or(6000) as usize,
                );
                if method == "memory_context" {
                    Ok(json!({"memories":brief(records),"context":context}))
                } else {
                    Ok(json!({"memories":brief(records)}))
                }
            }
            "memory_read" => {
                let id = params["id"].as_str().ok_or("ID is required")?;
                serde_json::to_value(store.read_active(&actor, id)?).map_err(|e| e.to_string())
            }
            _ => Err("Unknown memory tool".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn memory_tool(app: AppHandle, method: String, params: Value) -> Result<Value, String> {
    let root = crate::vault::get_vault_root(&app.state::<crate::vault::VaultState>())?;
    let p = policy(&root)?;
    let actor = Actor {
        client: "kuku-ai".into(),
        scopes: p
            .scopes
            .keys()
            .cloned()
            .chain(std::iter::once("personal".into()))
            .collect(),
        auto_scopes: p
            .scopes
            .iter()
            .filter(|(_, s)| s.auto_save)
            .map(|(k, _)| k.clone())
            .collect(),
    };
    dispatch(root, actor, method, params, false).await
}

#[tauri::command]
pub async fn memory_admin(app: AppHandle, method: String, params: Value) -> Result<Value, String> {
    let root = crate::vault::get_vault_root(&app.state::<crate::vault::VaultState>())?;
    if method == "remember" {
        let actor = ui_actor(&root)?;
        return dispatch(root, actor, "memory_remember".into(), params, false).await;
    }
    if method == "sync" {
        let mut p = policy(&root)?;
        p.cloud_enabled = true;
        {
            let root = root.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let _store = Store::open(&root)?;
                kuku_memory::atomic_write(
                    &root.join(".kuku/knowledge/access.json"),
                    &serde_json::to_vec_pretty(&p).map_err(|e| e.to_string())?,
                )
            })
            .await
            .map_err(|e| e.to_string())??;
        }
        return cloud::sync(&root).await;
    }
    if method == "resolve_conflict" {
        return cloud::resolve(&root, params).await;
    }
    if method == "cloud_grants" {
        return cloud::request("grants", json!({})).await;
    }
    if method == "revoke_cloud" {
        return cloud::request("revoke", params).await;
    }
    if method == "connect" {
        return connections::connect(&app, &root, params).await;
    }
    if method == "disconnect" {
        return connections::disconnect(&root, params).await;
    }
    if method == "extract" {
        let _extraction_guard = EXTRACTION_LOCK.lock().await;
        let paths = params["paths"].as_array().ok_or("Select notes first")?;
        if paths.is_empty() || paths.len() > 10 {
            return Err("Select between 1 and 10 notes".into());
        }
        let mut content = String::new();
        let mut notes = BTreeMap::new();
        for path in paths {
            let path = path.as_str().ok_or("Invalid note path")?;
            let resolved = crate::vault::resolve_vault_path_strict(&root, path).await?;
            let text = tokio::fs::read_to_string(resolved)
                .await
                .map_err(|e| e.to_string())?;
            if content.len() + text.len() > 100_000 {
                return Err("Selected notes are too large; select fewer notes".into());
            }
            notes.insert(path.to_string(), text.clone());
            content.push_str(&format!(
                "\n<note path={}>\n{}\n</note>\n",
                serde_json::to_string(path).map_err(|e| e.to_string())?,
                text
            ));
        }
        let (job_id, cached) = Store::open(&root)?.begin_extraction(&json!({"notes":notes}))?;
        if let Some(cached) = cached {
            return Ok(cached);
        }
        let outcome: Result<Value,String> = async {
        let authorization =
            crate::auth_commands::authorization_header_for_plugin("ai-chat").await?;
        let state = app.state::<kuku_ai::AiState>();
        let text =
            kuku_ai::extract_memory_candidates(state.inner(), content, authorization).await?;
        use kuku_memory::engine::MemoryEngine;
        let mut candidates = json!(kuku_memory::engine::NativeMemoryEngine.extract(&text)?);
        for candidate in candidates
            .as_array_mut()
            .ok_or("Invalid memory candidates")?
        {
            let proposed = candidate["source_refs"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let mut sources = Vec::new();
            for reference in proposed {
                if let Some(path) = reference["path"].as_str()
                    && let Some(note) = notes.get(path)
                {
                    let quote = reference["quote"]
                        .as_str()
                        .filter(|q| q.chars().count() <= 4000 && note.contains(q));
                    sources.push(json!({"path":path,"title":reference["title"].as_str().filter(|s|s.chars().count()<=160),"quote":quote,"captured_at":chrono::Utc::now().to_rfc3339()}));
                }
            }
            if sources.is_empty() {
                sources = notes
                    .keys()
                    .map(|path| json!({"path":path,"captured_at":chrono::Utc::now().to_rfc3339()}))
                    .collect();
            }
            candidate["source_refs"] = json!(sources);
        }
        Ok(candidates)
        }.await;
        Store::open(&root)?.finish_extraction(&job_id, outcome.as_ref().ok())?;
        return outcome;
    }
    let method_clone = method.clone();
    let sync_root = root.clone();
    let mut result = tauri::async_runtime::spawn_blocking(move || {
        let actor = ui_actor(&root)?;
        let mut store = Store::open(&root)?;
        match method_clone.as_str() {
            "status" => {
                let p = policy(&root)?;
                Ok(json!({
                    "policy":p,"connections":connections::list(&root)?,"extraction_jobs":store.extraction_jobs()?,
                    "memories":store.search(&actor,"",None,50)?,
                    "history":store.history(&actor)?,"outbox":store.pending_cloud()?,
                    "remote_url":format!("{}/mcp",crate::config::api_url()),
                    "web_url":format!("{}/memory/connect",crate::config::web_url())
                }))
            }
            "policy" => {
                let p: Policy = serde_json::from_value(params).map_err(|e| e.to_string())?;
                if p.scopes.keys().any(|s| !kuku_memory::valid_id(s)) {
                    return Err("Scope names may contain letters, digits, _ and -".into());
                }
                let path = root.join(".kuku/knowledge/access.json");
                kuku_memory::ensure_safe(&root, &path)?;
                kuku_memory::atomic_write(
                    &path,
                    &serde_json::to_vec_pretty(&p).map_err(|e| e.to_string())?,
                )?;
                store.set_cloud_cursor("0")?;
                Ok(json!(p))
            }
            "manage" => {
                let id = params["id"].as_str().ok_or("ID required")?;
                let action = params["action"].as_str().ok_or("Action required")?;
                let expected = params["expected_version"]
                    .as_u64()
                    .ok_or("Version required")?;
                if action == "share" {
                    let memory = store.read(&actor, id)?;
                    let mut p = policy(&root)?;
                    p.scopes.entry(memory.scope).or_default();
                    kuku_memory::atomic_write(
                        &root.join(".kuku/knowledge/access.json"),
                        &serde_json::to_vec_pretty(&p).map_err(|e| e.to_string())?,
                    )?;
                }
                serde_json::to_value(store.manage(&actor, id, expected, action)?)
                    .map_err(|e| e.to_string())
            }
            "undo" => serde_json::to_value(
                store.undo(&actor, params["seq"].as_i64().ok_or("Change required")?)?,
            )
            .map_err(|e| e.to_string()),
            "read" => serde_json::to_value(
                store.read(&actor, params["id"].as_str().ok_or("ID required")?)?,
            )
            .map_err(|e| e.to_string()),
            "rebuild_index" => {
                store.rebuild_index()?;
                Ok(json!({"rebuilt":true}))
            }
            _ => Err("Unknown memory action".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    if matches!(method.as_str(), "manage" | "undo") && policy(&sync_root)?.cloud_enabled {
        match cloud::sync(&sync_root).await {
            Ok(sync) => result["cloud_sync"] = sync,
            Err(error) => result["sync_error"] = json!(error),
        }
    }

    if method == "policy" {
        cloud::start_sync(app);
    }
    Ok(result)
}

pub fn setup(app: &AppHandle) {
    connections::serve(app.clone());
    cloud::start_sync(app.clone());
}

pub fn app_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    let path = crate::variant::data_root(&home).join("memory-connections");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(path)
}
pub fn socket_path() -> Result<PathBuf, String> {
    Ok(app_root()?.join("bridge.sock"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proposed_memory_retries_and_review_preserve_scope_and_legacy_markdown() {
        let root =
            std::env::temp_dir().join(format!("kuku-memory-review-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        drop(Store::open(&root).unwrap());
        let p = Policy {
            enabled: true,
            writes_enabled: true,
            cloud_enabled: false,
            scopes: BTreeMap::from([("project".into(), ScopePolicy::default())]),
        };
        std::fs::write(
            root.join(".kuku/knowledge/access.json"),
            serde_json::to_vec(&p).unwrap(),
        )
        .unwrap();
        let actor = Actor {
            client: "test".into(),
            scopes: vec!["project".into()],
            auto_scopes: vec![],
        };
        let input = json!({"request_id":"test-request-with-hyphens","scope":"project","title":"Language preference","body":"한국어로 설명한다.","source_refs":[{"path":"chat://session/test","captured_at":chrono::Utc::now().to_rfc3339()}]});
        let result = tauri::async_runtime::block_on(dispatch(
            root.clone(),
            actor.clone(),
            "memory_remember".into(),
            input.clone(),
            true,
        ))
        .unwrap();
        assert_eq!(result["status"], "proposed");
        let path = result["decision_path"].as_str().unwrap();
        let id = result["id"].as_str().unwrap();
        let retry = tauri::async_runtime::block_on(dispatch(
            root.clone(),
            actor.clone(),
            "memory_remember".into(),
            input,
            true,
        ))
        .unwrap();
        assert_eq!(retry["id"], id);
        assert_eq!(
            std::fs::read_dir(root.join("Knowledge/decisions"))
                .unwrap()
                .count(),
            1
        );
        let document = std::fs::read_to_string(root.join(path))
            .unwrap()
            .replace("required: true", "required: true\nselected_option_id: yes");
        std::fs::write(root.join(path), &document).unwrap();
        let request = crate::knowledge::models::ApplyDecisionDocumentRequest {
            path: path.into(),
            expected_checksum: crate::knowledge::markdown::sha256_checksum_bytes(
                document.as_bytes(),
            ),
            source: "editor_document_apply".into(),
            recover: true,
        };
        tauri::async_runtime::block_on(crate::knowledge::apply::apply_decision_document_for_root(
            &root, request,
        ))
        .unwrap();
        let mut store = Store::open(&root).unwrap();
        let memory = store.read_active(&actor, id).unwrap();
        assert_eq!(memory.scope, "project");
        let markdown =
            std::fs::read_to_string(root.join(format!("Knowledge/memory/{id}.md"))).unwrap();
        assert!(crate::knowledge::markdown::parse_memory_item(&markdown).is_ok());
        let deleted = store.manage(&actor, id, memory.version, "delete").unwrap();
        let markdown = kuku_memory::markdown(&deleted).unwrap();
        assert!(crate::knowledge::markdown::parse_memory_item(&markdown).is_ok());
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
