//! Native integration-only entry point. Not compiled into Kuku or KukuDev.
use kuku_ai::{AiConfig, AiState, ChatMode, ProviderKind, ProxyToolResult};
use tauri::{AppHandle, State, Wry};

/// Reuse the user's configured model only for an explicitly requested live test.
/// Credentials remain in native memory and are never persisted in the isolated
/// smoke data directory or returned over IPC. Normal builds omit this module.
#[tauri::command]
pub async fn planner_smoke_ai_use_configured_model(
    app: AppHandle<Wry>,
    state: State<'_, AiState>,
) -> Result<serde_json::Value, String> {
    if !cfg!(debug_assertions)
        || app.config().identifier != "mom.kuku.app.native-smoke"
        || std::env::var("KUKU_NATIVE_SMOKE").as_deref() != Ok("1")
        || std::env::var("KUKU_NATIVE_SMOKE_LIVE_MODEL_SOURCE").as_deref() != Ok("kuku-dev")
    {
        return Err("Live model smoke test requires explicit KukuDev configuration opt-in".into());
    }
    let home = dirs::home_dir().ok_or("Cannot resolve the user home directory")?;
    let public_settings =
        std::fs::read_to_string(home.join(".kuku.dev/plugins/ai-chat/settings.json"))
            .map_err(|_| "Cannot read existing KukuDev AI settings")?;
    let settings: serde_json::Value = serde_json::from_str(&public_settings)
        .map_err(|_| "Existing KukuDev AI settings are invalid")?;
    if settings["provider"].as_str() != Some("gemini") {
        return Err("Live smoke test currently supports the configured Gemini connection".into());
    }
    let model = settings["model"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or("Existing KukuDev model is missing")?
        .to_string();
    // Keychain access may require the user's normal macOS authorization. Do not
    // fall back to exporting the key or borrowing the production app's session.
    eprintln!("Live model smoke: waiting for the configured KukuDev Keychain credential");
    let key = tauri::async_runtime::spawn_blocking(crate::secure_storage::read_smoke_dev_ai_key)
        .await
        .map_err(|_| "Unable to read the configured model credential")?
        .map_err(|_| "Unable to read the configured model credential from Keychain")?
        .ok_or("Configured KukuDev model credential was not found in Keychain")?;
    let key = String::from_utf8(key).map_err(|_| "Configured model credential is invalid")?;
    if key.trim().is_empty() {
        return Err("Configured model credential is empty".into());
    }
    eprintln!("Live model smoke: Keychain credential loaded into native memory");
    state
        .set_native_smoke_model(AiConfig {
            provider: ProviderKind::Gemini,
            api_key: Some(key),
            model: model.clone(),
            server_url: None,
            round_limit: settings["roundLimit"].as_u64().unwrap_or(12).clamp(1, 24) as u32,
            proxy_tool_timeout_ms: settings["proxyToolTimeoutMs"]
                .as_u64()
                .unwrap_or(15_000)
                .clamp(1_000, 60_000),
        })
        .map_err(|_| "Unable to initialize the configured model")?;
    Ok(serde_json::json!({"provider": "gemini", "model": model, "source": "kuku-dev"}))
}

#[tauri::command]
pub async fn planner_smoke_ai_tool(
    app: AppHandle<Wry>,
    state: State<'_, AiState>,
    mode: ChatMode,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<ProxyToolResult, String> {
    kuku_ai::run_native_smoke_tool(&app, &state, mode, tool_name, arguments)
        .await
        .map_err(|error| error.to_string())
}
