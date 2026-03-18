use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::Sender;

use parking_lot::Mutex;

pub mod commands;
pub mod watcher;

pub struct VaultState {
    pub inner: Mutex<VaultInner>,
}

pub struct VaultInner {
    pub path: Option<PathBuf>,
    pub watcher_stop_tx: Option<Sender<()>>,
}

impl VaultState {
    pub fn new() -> Self {
        Self { inner: Mutex::new(VaultInner { path: None, watcher_stop_tx: None }) }
    }
}

pub fn get_vault_root(state: &VaultState) -> Result<PathBuf, String> {
    let guard = state.inner.lock();
    guard.path.clone().ok_or_else(|| "No vault is currently open".into())
}

pub fn resolve_vault_path(vault_root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    if relative_path.is_empty() {
        return Ok(vault_root.to_path_buf());
    }

    let mut resolved = vault_root.to_path_buf();

    for component in Path::new(relative_path).components() {
        match component {
            Component::Normal(c) => resolved.push(c),
            Component::ParentDir => {
                resolved.pop();
                if !resolved.starts_with(vault_root) {
                    return Err(format!(
                        "Path traversal denied: '{relative_path}' escapes vault root"
                    ));
                }
            }
            Component::CurDir => {}
            _ => {
                return Err(format!("Absolute paths not allowed: '{relative_path}'"));
            }
        }
    }

    if !resolved.starts_with(vault_root) {
        return Err(format!("Path traversal denied: '{relative_path}' resolved outside vault"));
    }

    Ok(resolved)
}

pub fn should_ignore_path(path: &Path) -> bool {
    let mut last_segment: Option<String> = None;
    for component in path.components() {
        if let Component::Normal(c) = component {
            let name = c.to_string_lossy().to_string();
            if name.starts_with('.') {
                return true;
            }
            last_segment = Some(name);
        }
    }

    if let Some(name) = last_segment {
        if name == ".DS_Store" {
            return true;
        }
        if name.ends_with(".tmp") || name.ends_with('~') {
            return true;
        }
    }

    false
}

pub fn to_relative_path(root: &Path, path: &Path) -> String {
    if let Ok(rel) = path.strip_prefix(root) {
        let as_str = rel.to_string_lossy().to_string();
        return as_str.replace('\\', "/");
    }
    path.to_string_lossy().to_string().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_resolve_normal_path() {
        let root = PathBuf::from("/tmp/vault");
        let result = resolve_vault_path(&root, "notes/a.md").unwrap();
        assert!(result.ends_with("vault/notes/a.md"));
    }

    #[test]
    fn test_resolve_empty_path() {
        let root = PathBuf::from("/tmp/vault");
        let result = resolve_vault_path(&root, "").unwrap();
        assert_eq!(result, root);
    }

    #[test]
    fn test_traversal_blocked() {
        let root = PathBuf::from("/tmp/vault");
        let result = resolve_vault_path(&root, "../../etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    fn test_absolute_blocked() {
        let root = PathBuf::from("/tmp/vault");
        let result = resolve_vault_path(&root, "/etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    fn test_current_dir_ignored() {
        let root = PathBuf::from("/tmp/vault");
        let result = resolve_vault_path(&root, "./a/./b.md").unwrap();
        assert!(result.ends_with("vault/a/b.md"));
    }

    #[test]
    fn test_should_ignore_hidden() {
        assert!(should_ignore_path(Path::new(".git/config")));
        assert!(should_ignore_path(Path::new("notes/.idea")));
        assert!(should_ignore_path(Path::new("notes/.DS_Store")));
        assert!(should_ignore_path(Path::new("notes/tmp~")));
        assert!(should_ignore_path(Path::new("notes/file.tmp")));
        assert!(!should_ignore_path(Path::new("notes/file.md")));
    }
}
