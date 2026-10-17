use super::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Clone, Serialize, Deserialize)]
struct Grant {
    id: String,
    client: String,
    root: PathBuf,
    scopes: Vec<String>,
    revoked: bool,
    #[serde(default)]
    last_success: Option<String>,
}
fn grants() -> Result<Vec<Grant>, String> {
    match std::fs::read(app_root()?.join("grants.json")) {
        Ok(v) => serde_json::from_slice(&v).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.to_string()),
    }
}
static GRANT_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
fn save(value: &[Grant]) -> Result<(), String> {
    kuku_memory::atomic_write(
        &app_root()?.join("grants.json"),
        &serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
}
pub fn list(root: &Path) -> Result<Value, String> {
    Ok(json!(grants()?.into_iter().filter(|g|g.root==root&&!g.revoked).map(|g|json!({"id":g.id,"client":g.client,"scopes":g.scopes,"last_success":g.last_success})).collect::<Vec<_>>()))
}

pub async fn connect(app: &AppHandle, root: &Path, params: Value) -> Result<Value, String> {
    let client = params["client"].as_str().ok_or("Client is required")?;
    if !["codex", "claude-code", "claude-desktop"].contains(&client) {
        return Err("Unsupported local client".into());
    }
    let p = policy(root)?;
    if !p.enabled {
        return Err("Enable memory connections first".into());
    }
    let scopes: Vec<String> =
        serde_json::from_value(params["scopes"].clone()).map_err(|_| "Select allowed scopes")?;
    if scopes.is_empty() || scopes.iter().any(|s| !p.scopes.contains_key(s)) {
        return Err("Select configured scopes".into());
    }
    let executable = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("resources/memory/kuku-mcp");
    let executable = if executable.exists() {
        executable
    } else {
        std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("Missing executable directory")?
            .join("kuku-mcp")
    };
    if !executable.is_file() {
        return Err("The Kuku MCP executable is missing. Build with scripts/memory/package.py or reinstall Kuku.".into());
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let socket = socket_path()?;
    let args = vec![
        "--socket".to_string(),
        socket.to_string_lossy().into(),
        "--connection".into(),
        id.clone(),
        "--bundle".into(),
        app.config().identifier.clone(),
    ];
    let config = json!({"command":executable,"args":args});
    let _guard = GRANT_LOCK.lock();
    let mut all = grants()?;
    // Registration is transactional with respect to grants: failed config edits
    // cannot leave an authorized client behind.
    install(client, &config)?;
    if let Err(error) = install_instructions(client, &config, &id, &scopes) {
        let _ = remove_owned_config(client, &id);
        let _ = remove_instructions(client, &id);
        return Err(error);
    }
    for g in &mut all {
        if g.client == client && g.root == root {
            g.revoked = true;
        }
    }
    all.push(Grant {
        id: id.clone(),
        client: client.into(),
        root: root.to_path_buf(),
        scopes,
        revoked: false,
        last_success: None,
    });
    if let Err(error) = save(&all) {
        let _ = remove_owned_config(client, &id);
        let _ = remove_instructions(client, &id);
        return Err(error);
    }
    let instructions = app_root()?.join("MEMORY_INSTRUCTIONS.md");
    kuku_memory::atomic_write(
        &instructions,
        include_bytes!("../../../../../scripts/memory/MEMORY_INSTRUCTIONS.md"),
    )?;
    Ok(
        json!({"id":id,"installed":true,"verified":false,"instructions":instructions,"socket":socket,"bundle":app.config().identifier,"mcpb":app.path().resource_dir().map_err(|e|e.to_string())?.join("resources/memory/kuku-memory.mcpb"),"message":"Restart the AI client and ask it to search Kuku memory. The memory skill was installed; Claude Code also recalls context at session start. Connection is verified only after a successful tool call."}),
    )
}
fn install(client: &str, config: &Value) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    install_at(client, config, &home)
}
fn install_at(client: &str, config: &Value, home: &Path) -> Result<(), String> {
    if client == "codex" {
        let path = home.join(".codex/config.toml");
        let content = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.to_string()),
        };
        let mut document: toml_edit::DocumentMut = content
            .parse()
            .map_err(|_| "Codex config is invalid; repair it before connecting")?;
        if document
            .get("mcp_servers")
            .is_some_and(|v| !v.is_table_like())
        {
            return Err("Codex mcp_servers must be a table".into());
        }
        if document
            .get("mcp_servers")
            .and_then(|t| t.get("kuku"))
            .is_some()
        {
            return Err("Codex already has a kuku MCP entry. Disconnect it in Kuku or remove that entry first.".into());
        }
        document["mcp_servers"]["kuku"]["command"] =
            toml_edit::value(config["command"].as_str().ok_or("Invalid executable")?);
        let mut args = toml_edit::Array::new();
        for arg in config["args"].as_array().ok_or("Invalid arguments")? {
            args.push(arg.as_str().ok_or("Invalid argument")?);
        }
        document["mcp_servers"]["kuku"]["args"] = toml_edit::value(args);
        std::fs::create_dir_all(path.parent().ok_or("Invalid config path")?)
            .map_err(|e| e.to_string())?;
        return kuku_memory::atomic_write(&path, document.to_string().as_bytes());
    }
    let path = if client == "claude-code" {
        home.join(".claude.json")
    } else {
        home.join("Library/Application Support/Claude/claude_desktop_config.json")
    };
    let mut data: Value = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Claude config is invalid; repair it before connecting")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e.to_string()),
    };
    if !data.is_object() || data.get("mcpServers").is_some_and(|v| !v.is_object()) {
        return Err("Claude MCP settings must be an object".into());
    }
    if data["mcpServers"]["kuku"] != Value::Null {
        return Err("Claude already has a kuku MCP entry. Disconnect it in Kuku or remove that entry first.".into());
    }
    if data.get("mcpServers").is_none() {
        data["mcpServers"] = json!({});
    }
    data["mcpServers"]["kuku"] = config.clone();
    std::fs::create_dir_all(path.parent().ok_or("Invalid config path")?)
        .map_err(|e| e.to_string())?;
    kuku_memory::atomic_write(
        &path,
        &serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?,
    )
}
pub async fn disconnect(root: &Path, params: Value) -> Result<Value, String> {
    let id = params["id"].as_str().ok_or("Connection required")?;
    let _guard = GRANT_LOCK.lock();
    let mut all = grants()?;
    let g = all
        .iter_mut()
        .find(|g| g.id == id && g.root == root)
        .ok_or("Connection not found")?;
    g.revoked = true;
    let client = g.client.clone();
    save(&all)?;
    remove_owned_config(&client, id)?;
    remove_instructions(&client, id)?;
    Ok(json!({"revoked":true}))
}

fn shell_word(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn install_instructions(
    client: &str,
    config: &Value,
    id: &str,
    scopes: &[String],
) -> Result<(), String> {
    if client == "claude-desktop" {
        return Ok(());
    }
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    let folder = home
        .join(if client == "codex" {
            ".codex/skills"
        } else {
            ".claude/skills"
        })
        .join(format!("kuku-memory-{id}"));
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let instructions = format!(
        "---\nname: kuku-memory-{id}\ndescription: Recall Kuku preferences and project decisions before starting or continuing work; save confirmed user decisions and corrections.\n---\n\n<!-- kuku-owned:{id} -->\nAuthorized scopes: {}.\n\n{}",
        scopes.join(", "),
        include_str!("../../../../../scripts/memory/MEMORY_INSTRUCTIONS.md")
    );
    kuku_memory::atomic_write(&folder.join("SKILL.md"), instructions.as_bytes())?;
    if client == "claude-code" {
        let path = home.join(".claude/settings.json");
        let mut value: Value = if path.exists() {
            serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|_| "Claude settings are invalid")?
        } else {
            json!({})
        };
        let mut command = vec![shell_word(
            config["command"].as_str().ok_or("Invalid executable")?,
        )];
        for arg in config["args"].as_array().ok_or("Invalid arguments")? {
            command.push(shell_word(arg.as_str().ok_or("Invalid argument")?));
        }
        command.push("--recall-hook".into());
        if value.get("hooks").is_none() {
            value["hooks"] = json!({});
        }
        if value["hooks"].get("SessionStart").is_none() {
            value["hooks"]["SessionStart"] = json!([]);
        }
        value["hooks"]["SessionStart"]
            .as_array_mut()
            .ok_or("Invalid Claude SessionStart settings")?
            .push(json!({"hooks":[{"type":"command","command":command.join(" "),"timeout":35}]}));
        kuku_memory::atomic_write(
            &path,
            &serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?,
        )?;
    }
    Ok(())
}
fn remove_instructions(client: &str, id: &str) -> Result<(), String> {
    if client == "claude-desktop" {
        return Ok(());
    }
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    let folder = home
        .join(if client == "codex" {
            ".codex/skills"
        } else {
            ".claude/skills"
        })
        .join(format!("kuku-memory-{id}"));
    let skill = folder.join("SKILL.md");
    if std::fs::read_to_string(&skill)
        .is_ok_and(|s| s.contains(&format!("<!-- kuku-owned:{id} -->")))
    {
        std::fs::remove_file(skill).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir(folder);
    }
    if client == "claude-code" {
        let path = home.join(".claude/settings.json");
        if path.exists() {
            let mut value: Value =
                serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if let Some(items) = value["hooks"]["SessionStart"].as_array_mut() {
                for item in items.iter_mut() {
                    if let Some(hooks) = item["hooks"].as_array_mut() {
                        hooks.retain(|h| {
                            !h["command"]
                                .as_str()
                                .is_some_and(|s| s.contains(id) && s.contains("--recall-hook"))
                        });
                    }
                }
                items.retain(|h| h["hooks"].as_array().is_none_or(|a| !a.is_empty()));
            }
            kuku_memory::atomic_write(
                &path,
                &serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?,
            )?;
        }
    }
    Ok(())
}
fn remove_owned_config(client: &str, id: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    remove_owned_config_at(client, id, &home)
}
fn remove_owned_config_at(client: &str, id: &str, home: &Path) -> Result<(), String> {
    if client == "codex" {
        let path = home.join(".codex/config.toml");
        if !path.exists() {
            return Ok(());
        }
        let mut doc: toml_edit::DocumentMut = std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())?
            .parse()
            .map_err(|_| "Codex config is invalid")?;
        let owned = doc
            .get("mcp_servers")
            .and_then(|t| t.get("kuku"))
            .and_then(|t| t.get("args"))
            .and_then(|a| a.as_array())
            .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(id)));
        if owned {
            if let Some(t) = doc
                .get_mut("mcp_servers")
                .and_then(|v| v.as_table_like_mut())
            {
                t.remove("kuku");
            }
            kuku_memory::atomic_write(&path, doc.to_string().as_bytes())?;
        }
        return Ok(());
    }
    let path = if client == "claude-code" {
        home.join(".claude.json")
    } else {
        home.join("Library/Application Support/Claude/claude_desktop_config.json")
    };
    if !path.exists() {
        return Ok(());
    }
    let mut data: Value = serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if data["mcpServers"]["kuku"]["args"]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(id)))
    {
        if let Some(o) = data["mcpServers"].as_object_mut() {
            o.remove("kuku");
        }
        kuku_memory::atomic_write(
            &path,
            &serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?,
        )?;
    }
    Ok(())
}

pub fn serve(app: AppHandle) {
    #[cfg(unix)]
    tauri::async_runtime::spawn(async move {
        let Ok(path) = socket_path() else {
            return;
        };
        // Never unlink another live process's socket.
        if tokio::net::UnixStream::connect(&path).await.is_ok() {
            return;
        }
        let _ = std::fs::remove_file(&path);
        let Ok(listener) = tokio::net::UnixListener::bind(&path) else {
            return;
        };
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        let permits = Arc::new(tokio::sync::Semaphore::new(16));
        while let Ok((stream, _)) = listener.accept().await {
            if !stream
                .peer_cred()
                .is_ok_and(|c| c.uid() == unsafe { libc::geteuid() })
            {
                continue;
            }
            let Ok(permit) = permits.clone().try_acquire_owned() else {
                continue;
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                let _ =
                    tokio::time::timeout(std::time::Duration::from_secs(30), handle(stream, app))
                        .await;
            });
        }
    });
}
#[cfg(unix)]
async fn handle(stream: tokio::net::UnixStream, _app: AppHandle) -> Result<(), String> {
    use tokio::io::AsyncReadExt;
    let (reader, mut writer) = stream.into_split();
    let mut line = String::new();
    BufReader::new(reader.take(1_048_577))
        .read_line(&mut line)
        .await
        .map_err(|e| e.to_string())?;
    let result = async {
        if line.len() > 1_048_576 {
            return Err("Request is too large".into());
        }
        let request: Value = serde_json::from_str(&line).map_err(|_| "Invalid request")?;
        let id = request["connection"]
            .as_str()
            .ok_or("Connection required")?;
        let g = grants()?
            .into_iter()
            .find(|g| g.id == id && !g.revoked)
            .ok_or("Connection revoked; reconnect from Kuku settings")?;
        let p = policy(&g.root)?;
        let actor = Actor {
            client: g.id.clone(),
            scopes: g
                .scopes
                .iter()
                .filter(|s| p.scopes.contains_key(*s))
                .cloned()
                .collect(),
            auto_scopes: g
                .scopes
                .iter()
                .filter(|s| p.scopes.get(*s).is_some_and(|p| p.auto_save))
                .cloned()
                .collect(),
        };
        let value = dispatch(
            g.root,
            actor,
            request["method"].as_str().ok_or("Method required")?.into(),
            request["params"].clone(),
            true,
        )
        .await?;
        {
            let _guard = GRANT_LOCK.lock();
            let mut all = grants()?;
            if let Some(g) = all.iter_mut().find(|g| g.id == id && !g.revoked) {
                g.last_success = Some(chrono::Utc::now().to_rfc3339());
                save(&all)?;
            }
        }
        Ok::<_, String>(value)
    }
    .await;
    let response = match result {
        Ok(v) => json!({"result":v}),
        Err(e) => json!({"error":e}),
    };
    let mut bytes = serde_json::to_vec(&response).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installation_preserves_existing_configuration_and_removes_only_owned_entries() {
        let home =
            std::env::temp_dir().join(format!("kuku-connection-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        let config = json!({"command":"/Applications/Kuku.app/Contents/Resources/resources/memory/kuku-mcp","args":["--connection","test-id"]});
        let path = home.join(".codex/config.toml");
        std::fs::write(&path,"# keep this comment\nmodel = \"configured-model\"\n[mcp_servers.other]\ncommand = \"other\"\n").unwrap();
        install_at("codex", &config, &home).unwrap();
        assert!(install_at("codex", &config, &home).is_err());
        remove_owned_config_at("codex", "not-the-owner", &home).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("test-id"));
        remove_owned_config_at("codex", "test-id", &home).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("# keep this comment"));
        assert!(content.contains("configured-model"));
        assert!(content.contains("mcp_servers.other"));
        assert!(!content.contains("test-id"));
        let path = home.join(".claude.json");
        std::fs::write(
            &path,
            serde_json::to_vec(
                &json!({"unrelated":true,"mcpServers":{"other":{"command":"other"}}}),
            )
            .unwrap(),
        )
        .unwrap();
        install_at("claude-code", &config, &home).unwrap();
        remove_owned_config_at("claude-code", "test-id", &home).unwrap();
        let value: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(value["unrelated"], true);
        assert_eq!(value["mcpServers"]["other"]["command"], "other");
        assert!(value["mcpServers"].get("kuku").is_none());
        std::fs::remove_dir_all(home).unwrap();
    }
}
