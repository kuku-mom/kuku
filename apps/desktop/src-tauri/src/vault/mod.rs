use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::mpsc::Sender;

use parking_lot::Mutex;

use crate::models::FileEntry;

pub mod checksum;
pub mod commands;
pub mod watcher;

/// Default file extensions shown in directory listings.
pub const DEFAULT_FILE_EXTENSIONS: &[&str] = &["md"];

pub struct VaultState {
    pub inner: Mutex<VaultInner>,
    pub expected_mutations: watcher::ExpectedMutationLedger,
}

pub struct VaultInner {
    pub path: Option<PathBuf>,
    pub watcher_stop_tx: Option<Sender<()>>,
}

impl VaultState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(VaultInner {
                path: None,
                watcher_stop_tx: None,
            }),
            expected_mutations: watcher::ExpectedMutationLedger::default(),
        }
    }
}

pub fn get_vault_root(state: &VaultState) -> Result<PathBuf, String> {
    let guard = state.inner.lock();
    guard
        .path
        .clone()
        .ok_or_else(|| "No vault is currently open".into())
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
        return Err(format!(
            "Path traversal denied: '{relative_path}' resolved outside vault"
        ));
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

/// Returns `true` when `name` ends with any of `extensions` (case-insensitive).
/// An empty slice means "accept everything".
fn matches_extensions(name: &str, extensions: &[&str]) -> bool {
    if extensions.is_empty() {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    extensions
        .iter()
        .any(|ext| lower.ends_with(&format!(".{}", ext.to_ascii_lowercase())))
}

/// Recursively list a directory, filtering **files** by `extensions`.
/// Directories are always included (but pruned when empty after filtering).
pub fn read_directory_recursive<'a>(
    dir: &'a Path,
    root: &'a Path,
    extensions: &'a [&'a str],
) -> Pin<Box<dyn Future<Output = Result<Vec<FileEntry>, String>> + Send + 'a>> {
    Box::pin(async move {
        let mut reader = tokio::fs::read_dir(dir)
            .await
            .map_err(|e| format!("Failed to read directory {}: {e}", dir.display()))?;

        let mut files: Vec<FileEntry> = Vec::new();
        let mut folders: Vec<FileEntry> = Vec::new();

        while let Some(entry) = reader.next_entry().await.map_err(|e| e.to_string())? {
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();

            if should_ignore_path(&rel) {
                continue;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            let is_directory = entry
                .file_type()
                .await
                .map(|ft| ft.is_dir())
                .unwrap_or(false);

            if is_directory {
                let children = read_directory_recursive(&path, root, extensions)
                    .await
                    .unwrap_or_default();
                folders.push(FileEntry {
                    name,
                    path: to_relative_path(root, &path),
                    is_directory: true,
                    children: Some(children),
                });
            } else if matches_extensions(&name, extensions) {
                files.push(FileEntry {
                    name,
                    path: to_relative_path(root, &path),
                    is_directory: false,
                    children: None,
                });
            }
        }

        folders.sort_by(|a, b| human_sort::compare(&a.name, &b.name));
        files.sort_by(|a, b| human_sort::compare(&a.name, &b.name));

        folders.extend(files);
        Ok(folders)
    })
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

    #[test]
    fn test_matches_extensions_default() {
        assert!(super::matches_extensions("note.md", &["md"]));
        assert!(super::matches_extensions("NOTE.MD", &["md"]));
        assert!(!super::matches_extensions("image.png", &["md"]));
    }

    #[test]
    fn test_matches_extensions_empty_accepts_all() {
        assert!(super::matches_extensions("anything.xyz", &[]));
    }

    #[test]
    fn test_matches_extensions_multiple() {
        let exts = &["md", "markdown"];
        assert!(super::matches_extensions("a.md", exts));
        assert!(super::matches_extensions("b.markdown", exts));
        assert!(!super::matches_extensions("c.txt", exts));
    }
}
