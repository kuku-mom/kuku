use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tauri::{command, AppHandle, Runtime};

fn ensure_root_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    let root = home.join(".kuku");
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create app root: {e}"))?;
    Ok(root)
}

fn settings_path() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("KUKU_SETTINGS_PATH") {
        return Ok(PathBuf::from(path));
    }
    let root = ensure_root_dir()?;
    Ok(root.join("settings.json"))
}

fn read_settings() -> Result<Value, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {e}"))?;
    let value: Value =
        serde_json::from_str(&content).map_err(|e| format!("Invalid settings JSON: {e}"))?;
    match value {
        Value::Object(_) => Ok(value),
        _ => Ok(Value::Object(serde_json::Map::new())),
    }
}

fn write_settings(settings: Value) -> Result<(), String> {
    if !settings.is_object() {
        return Err("Settings must be a JSON object".into());
    }
    let path = settings_path()?;
    let content =
        serde_json::to_string_pretty(&settings).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write settings: {e}"))?;
    Ok(())
}

#[command]
pub async fn app_settings_get() -> Result<Value, String> {
    read_settings()
}

#[command]
pub async fn app_settings_set(settings: Value) -> Result<(), String> {
    write_settings(settings)
}

#[command]
pub async fn app_restart<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_settings() -> Value {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        serde_json::json!({ "last_opened_vault": format!("test-{now}") })
    }

    fn write_settings_at(path: &Path, settings: Value) -> Result<(), String> {
        if !settings.is_object() {
            return Err("Settings must be a JSON object".into());
        }
        let content =
            serde_json::to_string_pretty(&settings).map_err(|e| format!("Serialize error: {e}"))?;
        fs::write(path, content).map_err(|e| format!("Failed to write settings: {e}"))?;
        Ok(())
    }

    fn read_settings_at(path: &Path) -> Result<Value, String> {
        if !path.exists() {
            return Ok(Value::Object(serde_json::Map::new()));
        }
        let content =
            fs::read_to_string(path).map_err(|e| format!("Failed to read settings: {e}"))?;
        let value: Value =
            serde_json::from_str(&content).map_err(|e| format!("Invalid settings JSON: {e}"))?;
        match value {
            Value::Object(_) => Ok(value),
            _ => Ok(Value::Object(serde_json::Map::new())),
        }
    }

    #[test]
    fn test_settings_roundtrip() {
        let path = std::env::temp_dir().join("kuku-settings-test-roundtrip.json");
        let settings = unique_settings();
        write_settings_at(&path, settings.clone()).unwrap();
        let loaded = read_settings_at(&path).unwrap();
        assert_eq!(
            loaded.get("last_opened_vault"),
            settings.get("last_opened_vault")
        );
        let _ = fs::remove_file(&path);
    }

}
