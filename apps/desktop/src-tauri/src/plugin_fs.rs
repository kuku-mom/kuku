use std::fs;
use std::path::{Component, Path, PathBuf};

use tauri::command;

// ── Sandbox Path Resolution ──

/// Resolves a relative path within a plugin's sandboxed data directory.
///
/// Uses lexical (component-by-component) path parsing instead of `canonicalize`
/// to prevent path traversal attacks. Each `..` component is checked against
/// the sandbox boundary — if it would escape, the call is rejected immediately.
///
/// Sandbox root: `~/.kuku/plugins/{plugin_id}/`
fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
    if plugin_id.is_empty() || plugin_id.contains('/') || plugin_id.contains('\\') {
        return Err("Invalid plugin ID".into());
    }

    Ok(())
}

fn resolve_sandboxed_path_from_root(
    sandbox: &Path,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let mut resolved = sandbox.to_path_buf();

    for component in Path::new(relative_path).components() {
        match component {
            Component::Normal(c) => resolved.push(c),
            Component::ParentDir => {
                resolved.pop();
                if !resolved.starts_with(sandbox) {
                    return Err(format!(
                        "Path traversal denied: '{relative_path}' escapes plugin sandbox"
                    ));
                }
            }
            Component::CurDir => {} // '.' is a no-op
            // RootDir, Prefix — absolute path components are not allowed
            _ => {
                return Err(format!("Absolute paths not allowed: '{relative_path}'"));
            }
        }
    }

    // Final safety check: resolved path must still be inside sandbox
    if !resolved.starts_with(sandbox) {
        return Err(format!(
            "Path traversal denied: '{relative_path}' resolved outside sandbox"
        ));
    }

    Ok(resolved)
}

fn resolve_sandboxed_path(plugin_id: &str, relative_path: &str) -> Result<PathBuf, String> {
    validate_plugin_id(plugin_id)?;

    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    let sandbox = home.join(".kuku").join("plugins").join(plugin_id);
    let resolved = resolve_sandboxed_path_from_root(&sandbox, relative_path)?;

    // Ensure sandbox directory exists
    fs::create_dir_all(&sandbox).map_err(|e| format!("Failed to create sandbox dir: {e}"))?;
    Ok(resolved)
}

// ── Tauri Commands ──

#[command]
pub async fn plugin_fs_read_text(plugin_id: String, path: String) -> Result<String, String> {
    let resolved = resolve_sandboxed_path(&plugin_id, &path)?;
    fs::read_to_string(&resolved)
        .map_err(|e| format!("Failed to read '{}': {e}", resolved.display()))
}

#[command]
pub async fn plugin_fs_write_text(
    plugin_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let resolved = resolve_sandboxed_path(&plugin_id, &path)?;

    // Ensure parent directories exist
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dirs: {e}"))?;
    }

    fs::write(&resolved, &content)
        .map_err(|e| format!("Failed to write '{}': {e}", resolved.display()))
}

#[command]
pub async fn plugin_fs_read_binary(plugin_id: String, path: String) -> Result<Vec<u8>, String> {
    let resolved = resolve_sandboxed_path(&plugin_id, &path)?;
    fs::read(&resolved).map_err(|e| format!("Failed to read binary '{}': {e}", resolved.display()))
}

#[command]
pub async fn plugin_fs_write_binary(
    plugin_id: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let resolved = resolve_sandboxed_path(&plugin_id, &path)?;

    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dirs: {e}"))?;
    }

    fs::write(&resolved, &data)
        .map_err(|e| format!("Failed to write binary '{}': {e}", resolved.display()))
}

#[command]
pub async fn plugin_fs_exists(plugin_id: String, path: String) -> Result<bool, String> {
    let resolved = resolve_sandboxed_path(&plugin_id, &path)?;
    Ok(resolved.exists())
}

#[command]
pub async fn plugin_fs_mkdir(plugin_id: String, path: String) -> Result<(), String> {
    let resolved = resolve_sandboxed_path(&plugin_id, &path)?;
    fs::create_dir_all(&resolved)
        .map_err(|e| format!("Failed to create directory '{}': {e}", resolved.display()))
}

#[command]
pub async fn plugin_fs_read_dir(plugin_id: String, path: String) -> Result<Vec<String>, String> {
    let resolved = resolve_sandboxed_path(&plugin_id, &path)?;

    let entries = fs::read_dir(&resolved)
        .map_err(|e| format!("Failed to read directory '{}': {e}", resolved.display()))?;

    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {e}"))?;
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_string());
        }
    }
    names.sort();
    Ok(names)
}

#[command]
pub async fn plugin_fs_remove(plugin_id: String, path: String) -> Result<(), String> {
    let resolved = resolve_sandboxed_path(&plugin_id, &path)?;

    // Don't allow removing the sandbox root itself
    if resolved == resolve_sandboxed_path(&plugin_id, "")? {
        return Err("Cannot remove plugin root directory".into());
    }

    if resolved.is_dir() {
        fs::remove_dir_all(&resolved)
            .map_err(|e| format!("Failed to remove directory '{}': {e}", resolved.display()))
    } else if resolved.exists() {
        fs::remove_file(&resolved)
            .map_err(|e| format!("Failed to remove file '{}': {e}", resolved.display()))
    } else {
        Ok(()) // Already gone — idempotent
    }
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;

    fn test_sandbox() -> PathBuf {
        std::env::temp_dir()
            .join("kuku-plugin-fs-tests")
            .join("test-plugin")
    }

    #[test]
    fn test_normal_path() {
        let sandbox = test_sandbox();
        let result = resolve_sandboxed_path_from_root(&sandbox, "data/cache.json");
        assert!(result.is_ok());
        let path = result.unwrap();
        assert_eq!(path, sandbox.join("data").join("cache.json"));
    }

    #[test]
    fn test_traversal_blocked() {
        let sandbox = test_sandbox();
        let result = resolve_sandboxed_path_from_root(&sandbox, "../../etc/passwd");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("traversal denied"));
    }

    #[test]
    fn test_sneaky_traversal_blocked() {
        let sandbox = test_sandbox();
        let result = resolve_sandboxed_path_from_root(&sandbox, "foo/../../../etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    fn test_absolute_path_blocked() {
        let sandbox = test_sandbox();
        let result = resolve_sandboxed_path_from_root(&sandbox, "/etc/passwd");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Absolute"));
    }

    #[test]
    fn test_current_dir_ignored() {
        let sandbox = test_sandbox();
        let result = resolve_sandboxed_path_from_root(&sandbox, "./data/./file.txt");
        assert!(result.is_ok());
        let path = result.unwrap();
        assert_eq!(path, sandbox.join("data").join("file.txt"));
    }

    #[test]
    fn test_safe_parent_within_sandbox() {
        // sub/.. should resolve back to sandbox root — that's fine
        let sandbox = test_sandbox();
        let result = resolve_sandboxed_path_from_root(&sandbox, "sub/../file.txt");
        assert!(result.is_ok());
        let path = result.unwrap();
        assert_eq!(path, sandbox.join("file.txt"));
    }

    #[test]
    fn test_invalid_plugin_id() {
        assert!(validate_plugin_id("").is_err());
        assert!(validate_plugin_id("../evil").is_err());
        assert!(validate_plugin_id("a/b").is_err());
        assert!(validate_plugin_id("a\\b").is_err());
    }
}
