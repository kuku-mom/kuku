use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tauri::command;

// ── Root Directory Init ──

/// Core logic: ensure ~/.kuku and ~/.kuku/plugins exist, return the root path.
fn ensure_root_dirs() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    let root = home.join(".kuku");
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

/// Returns the settings file path for a given plugin.
/// `~/.kuku/plugins/{plugin_id}/settings.json`
///
/// The plugin ID is validated to prevent directory traversal.
fn settings_path(plugin_id: &str) -> Result<PathBuf, String> {
    if plugin_id.is_empty() || plugin_id.contains('/') || plugin_id.contains('\\') {
        return Err("Invalid plugin ID".into());
    }

    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    let path = home
        .join(".kuku")
        .join("plugins")
        .join(plugin_id)
        .join("settings.json");

    Ok(path)
}

fn plugins_root_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    Ok(home.join(".kuku").join("plugins"))
}

// ── Tauri Commands ──

/// Load a plugin's settings from `~/.kuku/plugins/{id}/settings.json`.
/// Returns an empty JSON object `{}` if the file doesn't exist yet.
#[command]
pub async fn plugin_get_settings(plugin_id: String) -> Result<Value, String> {
    let path = settings_path(&plugin_id)?;

    if !path.exists() {
        return Ok(Value::Object(serde_json::Map::new()));
    }

    let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {e}"))?;

    let value: Value =
        serde_json::from_str(&content).map_err(|e| format!("Invalid settings JSON: {e}"))?;

    // Ensure root is always an object
    match value {
        Value::Object(_) => Ok(value),
        _ => {
            // Corrupted file — return empty and let TS defaults take over
            Ok(Value::Object(serde_json::Map::new()))
        }
    }
}

/// Save a plugin's settings to `~/.kuku/plugins/{id}/settings.json`.
/// Creates parent directories if they don't exist.
/// The `settings` parameter must be a JSON object.
#[command]
pub async fn plugin_save_settings(plugin_id: String, settings: Value) -> Result<(), String> {
    if !settings.is_object() {
        return Err("Settings must be a JSON object".into());
    }

    let path = settings_path(&plugin_id)?;

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create settings directory: {e}"))?;
    }

    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;

    fs::write(&path, content).map_err(|e| format!("Failed to write settings: {e}"))?;

    Ok(())
}

#[command]
pub async fn plugin_clear_all_settings() -> Result<(), String> {
    let plugins_dir = plugins_root_path()?;
    if plugins_dir.exists() {
        fs::remove_dir_all(&plugins_dir)
            .map_err(|e| format!("Failed to clear plugin settings: {e}"))?;
    }
    fs::create_dir_all(&plugins_dir)
        .map_err(|e| format!("Failed to recreate plugin settings directory: {e}"))?;
    Ok(())
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;

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
}
