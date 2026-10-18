use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
static RUNNING: AtomicBool = AtomicBool::new(false);
// Timer, explicit sync and tool writes must not race the shared cursor/outbox.
static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub async fn request(method: &str, params: Value) -> Result<Value, String> {
    let authorization = crate::auth_commands::authorization_header_for_plugin("knowledge")
        .await?
        .ok_or("Sign in and allow Second Brain account access before syncing")?;
    request_with_authorization(method, params, &authorization).await
}
async fn request_with_authorization(
    method: &str,
    params: Value,
    authorization: &str,
) -> Result<Value, String> {
    request_at(crate::config::api_url(), method, params, authorization).await
}
async fn request_at(
    endpoint: &str,
    method: &str,
    params: Value,
    authorization: &str,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(format!("{endpoint}/api/memory"))
        .header("Authorization", authorization)
        .json(&json!({"method":method,"params":params}))
        .send()
        .await
        .map_err(|_| "Could not reach the memory server; changes remain queued")?;
    let status = response.status();
    if status.as_u16() == 401 {
        return Err("Sign in again to sync shared memories".into());
    }
    if status.as_u16() == 404 {
        return Err("Shared memory is not enabled on this server".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Could not read the memory server reply")?;
    if bytes.len() > 8_000_000 {
        return Err("Memory server reply is too large".into());
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid memory server reply")?;
    if !status.is_success() {
        return Err(body["error"]
            .as_str()
            .unwrap_or("Memory sync failed")
            .into());
    }
    Ok(body)
}
pub async fn sync(root: &Path) -> Result<Value, String> {
    let _guard = SYNC_LOCK.lock().await;
    let started = std::time::Instant::now();
    let result = sync_inner(root).await;
    eprintln!(
        "memory_sync duration_ms={} success={} conflicts={}",
        started.elapsed().as_millis(),
        result.is_ok(),
        result
            .as_ref()
            .ok()
            .and_then(|r| r["conflicts"].as_u64())
            .unwrap_or(0)
    );
    result
}

async fn sync_inner(root: &Path) -> Result<Value, String> {
    let authorization = crate::auth_commands::authorization_header_for_plugin("knowledge")
        .await?
        .ok_or("Sign in and allow Second Brain account access before syncing")?;
    sync_authenticated(root, &authorization, crate::config::api_url()).await
}
async fn sync_authenticated(
    root: &Path,
    authorization: &str,
    endpoint: &str,
) -> Result<Value, String> {
    let identity = request_at(endpoint, "scopes", json!({}), authorization).await?;
    let user = identity["user_id"]
        .as_str()
        .ok_or("Invalid account reply")?
        .to_string();
    {
        let root = root.to_path_buf();
        tauri::async_runtime::spawn_blocking(move || Store::open(&root)?.bind_cloud_account(&user))
            .await
            .map_err(|e| e.to_string())??;
    }
    let pending = {
        let root = root.to_path_buf();
        tauri::async_runtime::spawn_blocking(move || Store::open(&root)?.pending_cloud())
            .await
            .map_err(|e| e.to_string())??
    };
    let p = policy(root)?;
    let scopes: Vec<Value> = p
        .scopes
        .iter()
        .filter(|(_, s)| s.shared)
        .map(|(name, s)| json!({"name":name,"auto_save":s.auto_save}))
        .collect();
    // Existing per-memory sharing also needs a scope on first publication.
    let mut scope_map: BTreeMap<String, bool> = scopes
        .iter()
        .filter_map(|s| Some((s["name"].as_str()?.to_string(), s["auto_save"].as_bool()?)))
        .collect();
    for entry in &pending {
        if let Some(scope) = entry["memory"]["scope"].as_str() {
            scope_map
                .entry(scope.into())
                .or_insert_with(|| p.scopes.get(scope).is_some_and(|s| s.auto_save));
        }
    }
    request_at(endpoint, "configure",json!({"scopes":scope_map.iter().map(|(name,auto)|json!({"name":name,"auto_save":auto})).collect::<Vec<_>>()}),authorization).await?;
    let mut committed = 0;
    let mut conflicts = 0;
    for entry in pending {
        if !p.writes_enabled
            && entry["memory"]["shared"] == true
            && entry["memory"]["status"] != "deleted"
        {
            continue;
        }
        if entry["state"] == "conflict" {
            conflicts += 1;
            continue;
        }
        // Only explicit source excerpts are published. Local paths and
        // full source notes never leave the vault through this endpoint.
        let mut public = entry.clone();
        if let Some(sources) = public["memory"]["source_refs"].as_array_mut() {
            for source in sources {
                source["path"] = json!("shared-source");
                source["origin"] = Value::Null;
            }
        }
        let response = request_at(endpoint, "publish", public, authorization).await?;
        let id = entry["id"]
            .as_str()
            .ok_or("Invalid queued memory")?
            .to_string();
        if response["status"] == "conflict" {
            let root = root.to_path_buf();
            tauri::async_runtime::spawn_blocking(move || Store::open(&root)?.cloud_conflict(&id))
                .await
                .map_err(|e| e.to_string())??;
            conflicts += 1;
            continue;
        }
        let mut record: kuku_memory::Memory = serde_json::from_value(response["memory"].clone())
            .map_err(|_| "Invalid cloud memory")?;
        // Retain private source references in the local projection.
        record.source_refs = serde_json::from_value(entry["memory"]["source_refs"].clone())
            .map_err(|e| e.to_string())?;
        let request_id = entry["request_id"]
            .as_str()
            .ok_or("Invalid queued request")?
            .to_string();
        let root = root.to_path_buf();
        tauri::async_runtime::spawn_blocking(move || {
            Store::open(&root)?.cloud_ack(&id, &request_id, &record)
        })
        .await
        .map_err(|e| e.to_string())??;
        committed += 1;
    }
    let cursor = {
        let root = root.to_path_buf();
        tauri::async_runtime::spawn_blocking(move || Store::open(&root)?.cloud_cursor())
            .await
            .map_err(|e| e.to_string())??
    };
    let changes = request_at(endpoint, "changes", json!({"cursor":cursor}), authorization).await?;
    let records: Vec<kuku_memory::Memory> =
        serde_json::from_value(changes["memories"].clone()).map_err(|_| "Invalid cloud changes")?;
    let proposals: Vec<kuku_memory::Memory> = serde_json::from_value(changes["proposals"].clone())
        .map_err(|_| "Invalid cloud proposals")?;
    for mut proposal in proposals {
        if !p.scopes.contains_key(&proposal.scope) {
            continue;
        }
        let key =
            kuku_memory::digest(format!("{}:{}", proposal.client, proposal.proposal_id).as_bytes());
        let seen = {
            let root = root.to_path_buf();
            let key = key.clone();
            tauri::async_runtime::spawn_blocking(move || {
                Store::open(&root)?.has_remote_proposal(&key)
            })
            .await
            .map_err(|e| e.to_string())??
        };
        if seen {
            continue;
        }
        use crate::knowledge::models::*;
        proposal.id = format!("mem_{}", &key[..32]);
        let created = crate::knowledge::proposal::create_decision_document_for_root(
            root,
            CreateDecisionDocumentRequest {
                title: Some(proposal.title.clone()),
                context: Some(format!(
                    "Shared memory proposal from {} in scope {}",
                    proposal.client, proposal.scope
                )),
                source_refs: vec![],
                proposed_memories: vec![ProposedMemoryInput {
                    suggested_id: Some(proposal.id.clone()),
                    kind: proposal.kind.clone(),
                    title: proposal.title.clone(),
                    body: proposal.body.clone(),
                    tags: proposal.tags.clone(),
                    source_refs: vec![],
                    decision: None,
                }],
                request_source: Some(ProposalRequestSource::AiTool),
                default_selection: ProposalDefaultSelection::None,
            },
            ProposalRequestSource::AiTool,
        )
        .await
        .map_err(|e| e.message)?;
        proposal.decision_document = created.path;
        let root = root.to_path_buf();
        tauri::async_runtime::spawn_blocking(move || {
            Store::open(&root)?.stage_remote_proposal(&key, &proposal)
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    let next = changes["cursor"]
        .as_str()
        .ok_or("Invalid cloud cursor")?
        .to_string();
    let root = root.to_path_buf();
    let count = records.len();
    tauri::async_runtime::spawn_blocking(move || {
        let mut store = Store::open(&root)?;
        let p = policy(&root)?;
        for record in records {
            if p.scopes.contains_key(&record.scope) {
                store.cloud_pull(&record)?;
            }
        }
        store.set_cloud_cursor(&next)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(json!({"committed":committed,"conflicts":conflicts,"downloaded":count}))
}
pub async fn resolve(root: &Path, params: Value) -> Result<Value, String> {
    let id = params["id"]
        .as_str()
        .ok_or("Memory ID required")?
        .to_string();
    let authorization = crate::auth_commands::authorization_header_for_plugin("knowledge")
        .await?
        .ok_or("Sign in before resolving a shared memory")?;
    let identity = request_with_authorization("scopes", json!({}), &authorization).await?;
    let user = identity["user_id"]
        .as_str()
        .ok_or("Invalid account reply")?
        .to_string();
    {
        let root = root.to_path_buf();
        tauri::async_runtime::spawn_blocking(move || Store::open(&root)?.bind_cloud_account(&user))
            .await
            .map_err(|e| e.to_string())??;
    }
    let record: kuku_memory::Memory = serde_json::from_value(
        request_with_authorization("read", json!({"id":id}), &authorization).await?,
    )
    .map_err(|_| "Invalid server memory")?;
    let root = root.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let actor = ui_actor(&root)?;
        Store::open(&root)?.accept_cloud(&actor, &id, &record)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(json!({"resolved":true}))
}
pub fn start_sync(app: AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let Ok(root) = crate::vault::get_vault_root(&app.state::<crate::vault::VaultState>())
            else {
                continue;
            };
            if !policy(&root).is_ok_and(|p| p.cloud_enabled) {
                continue;
            }
            let _ = sync(&root).await;
        }
    });
}

#[cfg(test)]
mod integration_tests {
    use super::*;

    // Run against an isolated Go server/PostgreSQL and a synthetic account.
    // The credential is read from a private file and never included in output.
    #[tokio::test]
    #[ignore = "requires KUKU_MEMORY_SYNC_TEST_URL and KUKU_MEMORY_SYNC_TEST_TOKEN_FILE"]
    async fn real_server_roundtrip_offline_conflict_and_delete() {
        let endpoint = std::env::var("KUKU_MEMORY_SYNC_TEST_URL").unwrap();
        let token =
            std::fs::read_to_string(std::env::var("KUKU_MEMORY_SYNC_TEST_TOKEN_FILE").unwrap())
                .unwrap();
        let authorization = format!("Bearer {}", token.trim());
        let scope = format!("sync-{}", uuid::Uuid::new_v4().simple());
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        for root in [first.path(), second.path()] {
            Store::open(root).unwrap();
            kuku_memory::atomic_write(
                &root.join(".kuku/knowledge/access.json"),
                &serde_json::to_vec(&json!({
                    "enabled":true,"writes_enabled":true,"cloud_enabled":true,
                    "scopes":{scope.clone():{"auto_save":true,"shared":true}}
                }))
                .unwrap(),
            )
            .unwrap();
        }
        let actor = Actor {
            client: "sync-integration".into(),
            scopes: vec![scope.clone()],
            auto_scopes: vec![scope.clone()],
        };
        let request: Remember = serde_json::from_value(json!({"request_id":"initial", "scope":scope,"title":"Sync integration", "body":"initial"})).unwrap();
        let id = Store::open(first.path())
            .unwrap()
            .remember_in_scope(&actor, request, true)
            .unwrap()
            .id;
        let uploaded = sync_authenticated(first.path(), &authorization, &endpoint)
            .await
            .unwrap();
        assert_eq!(uploaded["committed"], 1);
        sync_authenticated(second.path(), &authorization, &endpoint)
            .await
            .unwrap();
        assert_eq!(
            Store::open(second.path())
                .unwrap()
                .read(&actor, &id)
                .unwrap()
                .body,
            "initial"
        );
        // Both replicas edit the same version while disconnected. Neither may silently win.
        for (root, body) in [
            (first.path(), "first offline edit"),
            (second.path(), "second offline edit"),
        ] {
            let mut store = Store::open(root).unwrap();
            let version = store.read(&actor, &id).unwrap().version;
            let update: Remember = serde_json::from_value(json!({"request_id":body.replace(' ',"-"),"scope":scope,"id":id,"expected_version":version,"title":"Sync integration","body":body})).unwrap();
            store.remember_in_scope(&actor, update, true).unwrap();
        }
        sync_authenticated(first.path(), &authorization, &endpoint)
            .await
            .unwrap();
        let conflicted = sync_authenticated(second.path(), &authorization, &endpoint)
            .await
            .unwrap();
        assert_eq!(conflicted["conflicts"], 1);
        assert_eq!(
            Store::open(second.path()).unwrap().pending_cloud().unwrap()[0]["state"],
            "conflict"
        );
        let server: kuku_memory::Memory = serde_json::from_value(
            request_at(&endpoint, "read", json!({"id":id}), &authorization)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(server.body, "first offline edit");
        Store::open(second.path())
            .unwrap()
            .accept_cloud(&actor, &id, &server)
            .unwrap();
        let version = Store::open(first.path())
            .unwrap()
            .read(&actor, &id)
            .unwrap()
            .version;
        Store::open(first.path())
            .unwrap()
            .manage(&actor, &id, version, "delete")
            .unwrap();
        sync_authenticated(first.path(), &authorization, &endpoint)
            .await
            .unwrap();
        sync_authenticated(second.path(), &authorization, &endpoint)
            .await
            .unwrap();
        assert!(
            Store::open(second.path())
                .unwrap()
                .search(&actor, "", Some(&scope), 50)
                .unwrap()
                .is_empty()
        );
        sync_authenticated(second.path(), &authorization, &endpoint)
            .await
            .unwrap();
        assert!(
            Store::open(second.path())
                .unwrap()
                .pending_cloud()
                .unwrap()
                .is_empty()
        );
    }
}
