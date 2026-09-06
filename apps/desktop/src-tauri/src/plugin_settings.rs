use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use tauri::command;

use crate::plugin_secrets::{self, PluginSecretError};
use crate::variant;

const SECURE_META_KEY: &str = "__secure";
const SECURE_META_STORAGE: &str = "keyring";
const SECURE_META_VERSION: u64 = 1;

// ── Root Directory Init ──

/// Core logic: ensure the variant app-data root and `{root}/plugins`
/// exist, return the root path. The root is `~/.kuku` for prod and
/// `~/.kuku.preview` / `~/.kuku.dev` for other variants.
fn ensure_root_dirs() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    let root = variant::data_root(&home);
    let plugins_dir = root.join("plugins");

    fs::create_dir_all(&plugins_dir).map_err(|e| format!("Failed to create root dirs: {e}"))?;

    root.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "App root path contains invalid UTF-8".into())
}

/// Tauri command wrapper. Called once at app startup before any plugin operations.
#[command]
pub async fn plugin_ensure_root_dirs() -> Result<String, String> {
    ensure_root_dirs()
}

// ── Path Resolution ──

/// Returns the settings file path for a given plugin, scoped to the
/// current variant's data root.
fn settings_path(plugin_id: &str) -> Result<PathBuf, String> {
    plugin_secrets::validate_plugin_id(plugin_id).map_err(|error| error.to_string())?;

    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    Ok(variant::data_root(&home)
        .join("plugins")
        .join(plugin_id)
        .join("settings.json"))
}

fn plugins_root_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    Ok(variant::data_root(&home).join("plugins"))
}

// ── Tauri Commands ──

// Keychain can synchronously wait for a system authorization dialog. Keep that
// wait off the command executor so the webview and unrelated document IPC stay
// responsive. Do not time out or retry writes: the original operation still owns
// its result, including a user denial.
async fn run_secret_task<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| "Plugin secure settings worker failed".to_string())?
}

/// Load a plugin's settings from `~/.kuku/plugins/{id}/settings.json`.
/// Returns an empty JSON object `{}` if the file doesn't exist yet.
#[command]
pub async fn plugin_get_settings(plugin_id: String) -> Result<Value, String> {
    Ok(Value::Object(read_settings_object(&plugin_id)?))
}

/// Save a plugin's settings to `~/.kuku/plugins/{id}/settings.json`.
/// Creates parent directories if they don't exist.
/// The `settings` parameter must be a JSON object.
#[command]
pub async fn plugin_save_settings(plugin_id: String, settings: Value) -> Result<(), String> {
    let settings = into_object(settings)?;
    write_settings_object(&plugin_id, &settings)
}

#[command]
pub async fn plugin_get_settings_with_secrets(
    plugin_id: String,
    secure_keys: Vec<String>,
) -> Result<Value, String> {
    run_secret_task(move || get_settings_with_secrets(&plugin_id, &secure_keys)).await
}

fn get_settings_with_secrets(plugin_id: &str, secure_keys: &[String]) -> Result<Value, String> {
    validate_secure_keys(&secure_keys)?;

    let settings = read_settings_object(&plugin_id)?;
    let mut secret_values = Vec::with_capacity(secure_keys.len());
    for key in secure_keys {
        let value = plugin_secrets::read_plugin_secret(&plugin_id, key)
            .map_err(|error| error.to_string())?;
        secret_values.push((key.clone(), value));
    }

    Ok(Value::Object(apply_secure_values(settings, &secret_values)))
}

#[command]
pub async fn plugin_save_settings_with_secrets(
    plugin_id: String,
    settings: Value,
    secure_keys: Vec<String>,
) -> Result<(), String> {
    run_secret_task(move || save_settings_with_secrets(&plugin_id, settings, &secure_keys)).await
}

fn save_settings_with_secrets(
    plugin_id: &str,
    settings: Value,
    secure_keys: &[String],
) -> Result<(), String> {
    validate_secure_keys(&secure_keys)?;

    let settings = into_object(settings)?;
    let existing_meta = read_settings_object(&plugin_id)
        .map(|stored| extract_secure_meta(&stored))
        .unwrap_or_default();
    let (public_settings, secret_values) =
        strip_secure_values_for_save(settings, &secure_keys, existing_meta)?;

    for (key, value) in &secret_values {
        match value {
            Some(value) => plugin_secrets::write_plugin_secret(&plugin_id, key, value)
                .map_err(|error| error.to_string())?,
            None => match plugin_secrets::delete_plugin_secret(&plugin_id, key) {
                Ok(()) | Err(PluginSecretError::NotFound) => {}
                Err(error) => return Err(error.to_string()),
            },
        }
    }

    write_settings_object(&plugin_id, &public_settings)
}

#[command]
pub async fn plugin_clear_settings_with_secrets(
    plugin_id: String,
    secure_keys: Vec<String>,
) -> Result<(), String> {
    run_secret_task(move || clear_settings_with_secrets(&plugin_id, &secure_keys)).await
}

fn clear_settings_with_secrets(plugin_id: &str, secure_keys: &[String]) -> Result<(), String> {
    validate_secure_keys(&secure_keys)?;

    let path = settings_path(&plugin_id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| format!("Failed to clear settings: {error}"))?;
    }

    for key in secure_keys {
        match plugin_secrets::delete_plugin_secret(&plugin_id, key) {
            Ok(()) | Err(PluginSecretError::NotFound) => {}
            Err(error) => return Err(error.to_string()),
        }
    }

    Ok(())
}

#[command]
pub async fn plugin_clear_all_settings() -> Result<(), String> {
    run_secret_task(clear_all_settings).await
}

fn clear_all_settings() -> Result<(), String> {
    let plugins_dir = plugins_root_path()?;
    if plugins_dir.exists() {
        clear_all_plugin_secure_secrets(&plugins_dir)?;
        fs::remove_dir_all(&plugins_dir)
            .map_err(|e| format!("Failed to clear plugin settings: {e}"))?;
    }
    fs::create_dir_all(&plugins_dir)
        .map_err(|e| format!("Failed to recreate plugin settings directory: {e}"))?;
    Ok(())
}

// ── Settings Helpers ──

fn read_settings_object(plugin_id: &str) -> Result<Map<String, Value>, String> {
    let path = settings_path(plugin_id)?;
    read_settings_object_at_path(&path)
}

fn read_settings_object_at_path(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }

    let content = fs::read_to_string(path).map_err(|e| format!("Failed to read settings: {e}"))?;
    let value: Value =
        serde_json::from_str(&content).map_err(|e| format!("Invalid settings JSON: {e}"))?;

    match value {
        Value::Object(object) => Ok(object),
        _ => Ok(Map::new()),
    }
}

fn write_settings_object(plugin_id: &str, settings: &Map<String, Value>) -> Result<(), String> {
    let path = settings_path(plugin_id)?;
    write_settings_object_at_path(&path, settings)
}

fn write_settings_object_at_path(path: &Path, settings: &Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create settings directory: {e}"))?;
    }

    let content = serde_json::to_string_pretty(&Value::Object(settings.clone()))
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    fs::write(path, content).map_err(|e| format!("Failed to write settings: {e}"))
}

fn into_object(settings: Value) -> Result<Map<String, Value>, String> {
    match settings {
        Value::Object(object) => Ok(object),
        _ => Err("Settings must be a JSON object".into()),
    }
}

fn validate_secure_keys(secure_keys: &[String]) -> Result<(), String> {
    for key in secure_keys {
        plugin_secrets::validate_field_name(key).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn secure_meta_entry(present: bool) -> Value {
    let mut meta = Map::new();
    meta.insert("storage".into(), Value::String(SECURE_META_STORAGE.into()));
    meta.insert("present".into(), Value::Bool(present));
    meta.insert("version".into(), Value::from(SECURE_META_VERSION));
    Value::Object(meta)
}

fn secure_keys_from_meta(settings: &Map<String, Value>) -> Vec<String> {
    extract_secure_meta(settings)
        .into_iter()
        .filter_map(|(key, meta)| match meta {
            Value::Object(meta)
                if meta.get("storage") == Some(&Value::String(SECURE_META_STORAGE.into())) =>
            {
                plugin_secrets::validate_field_name(&key).ok()?;
                Some(key)
            }
            _ => None,
        })
        .collect()
}

fn extract_secure_meta(settings: &Map<String, Value>) -> Map<String, Value> {
    match settings.get(SECURE_META_KEY) {
        Some(Value::Object(meta)) => meta.clone(),
        _ => Map::new(),
    }
}

fn clear_all_plugin_secure_secrets(plugins_dir: &Path) -> Result<(), String> {
    for entry in fs::read_dir(plugins_dir).map_err(|error| {
        format!("Failed to enumerate plugin settings directories for secret cleanup: {error}")
    })? {
        let entry = entry.map_err(|error| {
            format!("Failed to read plugin settings directory entry for secret cleanup: {error}")
        })?;

        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }

        let Some(plugin_id) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            continue;
        };
        if plugin_secrets::validate_plugin_id(&plugin_id).is_err() {
            continue;
        }

        let settings_path = entry.path().join("settings.json");
        let Ok(settings) = read_settings_object_at_path(&settings_path) else {
            continue;
        };

        for key in secure_keys_from_meta(&settings) {
            match plugin_secrets::delete_plugin_secret(&plugin_id, &key) {
                Ok(()) | Err(PluginSecretError::NotFound) => {}
                Err(error) => return Err(error.to_string()),
            }
        }
    }

    Ok(())
}

fn apply_secure_values(
    mut settings: Map<String, Value>,
    secret_values: &[(String, Option<String>)],
) -> Map<String, Value> {
    let mut secure_meta = extract_secure_meta(&settings);
    settings.remove(SECURE_META_KEY);

    for (key, value) in secret_values {
        match value {
            Some(value) => {
                settings.insert(key.clone(), Value::String(value.clone()));
                secure_meta.insert(key.clone(), secure_meta_entry(true));
            }
            None => {
                settings.insert(key.clone(), Value::Null);
                secure_meta.insert(key.clone(), secure_meta_entry(false));
            }
        }
    }

    if !secure_meta.is_empty() {
        settings.insert(SECURE_META_KEY.into(), Value::Object(secure_meta));
    }

    settings
}

type StrippedSettings = (Map<String, Value>, Vec<(String, Option<String>)>);

fn strip_secure_values_for_save(
    mut settings: Map<String, Value>,
    secure_keys: &[String],
    mut secure_meta: Map<String, Value>,
) -> Result<StrippedSettings, String> {
    settings.remove(SECURE_META_KEY);

    let mut secret_values = Vec::with_capacity(secure_keys.len());
    for key in secure_keys {
        let value = match settings.remove(key) {
            Some(Value::String(value)) if !value.is_empty() => Some(value),
            Some(Value::String(_)) | Some(Value::Null) | None => None,
            Some(_) => return Err(format!("Secure setting '{key}' must be a string or null")),
        };

        secure_meta.insert(key.clone(), secure_meta_entry(value.is_some()));
        secret_values.push((key.clone(), value));
    }

    if !secure_meta.is_empty() {
        settings.insert(SECURE_META_KEY.into(), Value::Object(secure_meta));
    }

    Ok((settings, secret_values))
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_settings_work_runs_off_the_calling_thread() {
        let caller = std::thread::current().id();
        let worker =
            tauri::async_runtime::block_on(run_secret_task(|| Ok(std::thread::current().id())))
                .unwrap();
        assert_ne!(caller, worker);
    }

    #[test]
    fn secure_settings_worker_preserves_operation_errors() {
        let error = tauri::async_runtime::block_on(run_secret_task(|| {
            Err::<(), _>("Access denied by user".to_string())
        }))
        .unwrap_err();
        assert_eq!(error, "Access denied by user");
    }

    #[test]
    fn test_ensure_root_dirs_returns_path() {
        let result = ensure_root_dirs();
        assert!(result.is_ok());
        assert!(result.unwrap().ends_with(".kuku"));
    }

    #[test]
    fn test_settings_path_valid() {
        let result = settings_path("graph-view");
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.ends_with("plugins/graph-view/settings.json"));
    }

    #[test]
    fn test_settings_path_rejects_traversal() {
        assert!(settings_path("../evil").is_err());
        assert!(settings_path("a/b").is_err());
        assert!(settings_path("").is_err());
    }

    #[test]
    fn test_settings_path_rejects_backslash() {
        assert!(settings_path("a\\b").is_err());
    }

    #[test]
    fn strip_secure_values_for_save_removes_plaintext_and_writes_meta() {
        let mut settings = Map::new();
        settings.insert("provider".into(), Value::String("gemini".into()));
        settings.insert("apiKey".into(), Value::String("secret-value".into()));

        let mut existing_meta = Map::new();
        existing_meta.insert("otherKey".into(), secure_meta_entry(true));

        let (public_settings, secret_values) =
            strip_secure_values_for_save(settings, &[String::from("apiKey")], existing_meta)
                .unwrap();

        assert_eq!(
            secret_values,
            vec![(String::from("apiKey"), Some(String::from("secret-value")))]
        );
        assert_eq!(
            public_settings.get("provider"),
            Some(&Value::String(String::from("gemini")))
        );
        assert!(!public_settings.contains_key("apiKey"));

        let secure_meta = public_settings
            .get(SECURE_META_KEY)
            .and_then(Value::as_object)
            .unwrap();
        assert_eq!(
            secure_meta
                .get("apiKey")
                .and_then(Value::as_object)
                .unwrap()
                .get("storage"),
            Some(&Value::String(String::from("keyring")))
        );
        assert_eq!(
            secure_meta
                .get("apiKey")
                .and_then(Value::as_object)
                .unwrap()
                .get("present"),
            Some(&Value::Bool(true))
        );
        assert!(secure_meta.contains_key("otherKey"));
    }

    #[test]
    fn strip_secure_values_for_save_marks_empty_secret_as_not_present() {
        let mut settings = Map::new();
        settings.insert("apiKey".into(), Value::String(String::new()));

        let (public_settings, secret_values) =
            strip_secure_values_for_save(settings, &[String::from("apiKey")], Map::new()).unwrap();

        assert_eq!(secret_values, vec![(String::from("apiKey"), None)]);
        assert_eq!(
            public_settings
                .get(SECURE_META_KEY)
                .and_then(Value::as_object)
                .and_then(|meta| meta.get("apiKey"))
                .and_then(Value::as_object)
                .and_then(|entry| entry.get("present")),
            Some(&Value::Bool(false))
        );
    }

    #[test]
    fn apply_secure_values_merges_secret_values_and_updates_meta() {
        let mut settings = Map::new();
        settings.insert("provider".into(), Value::String("remote".into()));
        settings.insert(
            SECURE_META_KEY.into(),
            Value::Object({
                let mut meta = Map::new();
                meta.insert("otherKey".into(), secure_meta_entry(true));
                meta
            }),
        );

        let merged = apply_secure_values(
            settings,
            &[
                (String::from("apiKey"), Some(String::from("secret"))),
                (String::from("clientSecret"), None),
            ],
        );

        assert_eq!(
            merged.get("apiKey"),
            Some(&Value::String(String::from("secret")))
        );
        assert_eq!(merged.get("clientSecret"), Some(&Value::Null));
        let secure_meta = merged
            .get(SECURE_META_KEY)
            .and_then(Value::as_object)
            .unwrap();
        assert!(secure_meta.contains_key("otherKey"));
        assert_eq!(
            secure_meta
                .get("clientSecret")
                .and_then(Value::as_object)
                .and_then(|entry| entry.get("present")),
            Some(&Value::Bool(false))
        );
    }

    #[test]
    fn secure_keys_from_meta_only_returns_valid_keyring_entries() {
        let mut settings = Map::new();
        settings.insert(
            SECURE_META_KEY.into(),
            Value::Object({
                let mut meta = Map::new();
                meta.insert("apiKey".into(), secure_meta_entry(true));
                meta.insert(
                    "ignored".into(),
                    Value::Object({
                        let mut entry = Map::new();
                        entry.insert("storage".into(), Value::String("plaintext".into()));
                        entry
                    }),
                );
                meta.insert("bad/key".into(), secure_meta_entry(true));
                meta
            }),
        );

        assert_eq!(
            secure_keys_from_meta(&settings),
            vec![String::from("apiKey")]
        );
    }
}
