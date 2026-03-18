use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use tauri::{command, AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::app_settings::set_last_opened_vault;
use crate::models::{ChecksumWriteResult, FileEntry, FileReadResult};
use crate::vault::{get_vault_root, resolve_vault_path, should_ignore_path, to_relative_path};
use crate::vault::{watcher, VaultState};

fn compute_checksum(content: &str) -> String {
    blake3::hash(content.as_bytes()).to_hex().to_string()
}

fn read_directory_recursive<'a>(
    dir: &'a Path,
    root: &'a Path,
) -> Pin<Box<dyn Future<Output = Result<Vec<FileEntry>, String>> + Send + 'a>> {
    Box::pin(async move {
        let mut reader = tokio::fs::read_dir(dir)
            .await
            .map_err(|e| format!("Failed to read directory {}: {e}", dir.display()))?;

        let mut files: Vec<FileEntry> = Vec::new();
        let mut folders: Vec<FileEntry> = Vec::new();

        while let Some(entry) = reader.next_entry().await.map_err(|e| e.to_string())? {
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_path_buf();

            if should_ignore_path(&rel) {
                continue;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            let is_directory = entry.file_type().await.map(|ft| ft.is_dir()).unwrap_or(false);

            if is_directory {
                let children = read_directory_recursive(&path, root).await.unwrap_or_default();
                folders.push(FileEntry {
                    name,
                    path: to_relative_path(root, &path),
                    is_directory: true,
                    children: Some(children),
                });
            } else {
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

#[command]
pub async fn vault_open(
    app: AppHandle,
    state: State<'_, VaultState>,
    path: String,
) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Vault path is empty".into());
    }
    let root = Path::new(&path);
    let metadata = tokio::fs::metadata(root)
        .await
        .map_err(|e| format!("Vault path must be an existing directory: {e}"))?;
    if !metadata.is_dir() {
        return Err("Vault path must be an existing directory".into());
    }

    {
        let mut guard = state.inner.lock();
        if let Some(stop_tx) = guard.watcher_stop_tx.take() {
            let _ = watcher::stop_watching(stop_tx);
        }
        guard.path = Some(root.to_path_buf());
    }

    let stop_tx = watcher::start_watching(app, root.to_path_buf())?;
    {
        let mut guard = state.inner.lock();
        guard.watcher_stop_tx = Some(stop_tx);
    }

    set_last_opened_vault(Some(&path))?;
    Ok(())
}

#[command]
pub async fn vault_choose_directory(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();

        app.dialog().file().pick_folder(move |path| {
            let selected = path
                .and_then(|p| p.into_path().ok())
                .map(|p| p.to_string_lossy().to_string());
            let _ = tx.send(selected);
        });

        rx.recv().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Failed to open folder dialog: {e}"))?
}

#[command]
pub async fn vault_close(state: State<'_, VaultState>) -> Result<(), String> {
    {
        let mut guard = state.inner.lock();
        if let Some(stop_tx) = guard.watcher_stop_tx.take() {
            let _ = watcher::stop_watching(stop_tx);
        }
        guard.path = None;
    }
    Ok(())
}

#[command]
pub async fn vault_get_current(state: State<'_, VaultState>) -> Result<Option<String>, String> {
    let guard = state.inner.lock();
    Ok(guard.path.as_ref().and_then(|p| p.to_str().map(|s| s.to_string())))
}

#[command]
pub async fn vault_read_text(state: State<'_, VaultState>, path: String) -> Result<String, String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    tokio::fs::read_to_string(&resolved).await.map_err(|e| e.to_string())
}

#[command]
pub async fn vault_write_text(
    state: State<'_, VaultState>,
    path: String,
    content: String,
) -> Result<(), String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    if let Some(parent) = resolved.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&resolved, &content).await.map_err(|e| e.to_string())
}

#[command]
pub async fn vault_read_binary(
    state: State<'_, VaultState>,
    path: String,
) -> Result<Vec<u8>, String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    tokio::fs::read(&resolved).await.map_err(|e| e.to_string())
}

#[command]
pub async fn vault_write_binary(
    state: State<'_, VaultState>,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    if let Some(parent) = resolved.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&resolved, &data).await.map_err(|e| e.to_string())
}

#[command]
pub async fn vault_read_with_checksum(
    state: State<'_, VaultState>,
    path: String,
) -> Result<FileReadResult, String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    let content = tokio::fs::read_to_string(&resolved).await.map_err(|e| e.to_string())?;
    let checksum = compute_checksum(&content);
    Ok(FileReadResult { content, checksum })
}

#[command]
pub async fn vault_write_with_checksum(
    state: State<'_, VaultState>,
    path: String,
    content: String,
    checksum: String,
) -> Result<ChecksumWriteResult, String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    let current_content = tokio::fs::read_to_string(&resolved).await.map_err(|e| e.to_string())?;
    let current_checksum = compute_checksum(&current_content);

    if current_checksum != checksum {
        return Ok(ChecksumWriteResult::Conflict { expected: checksum, actual: current_checksum });
    }

    tokio::fs::write(&resolved, &content).await.map_err(|e| e.to_string())?;
    Ok(ChecksumWriteResult::Written { checksum: compute_checksum(&content) })
}

#[command]
pub async fn vault_exists(state: State<'_, VaultState>, path: String) -> Result<bool, String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    tokio::fs::try_exists(&resolved).await.map_err(|e| e.to_string())
}

#[command]
pub async fn vault_list_dir(
    state: State<'_, VaultState>,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    read_directory_recursive(&resolved, &root).await
}

#[command]
pub async fn vault_mkdir(state: State<'_, VaultState>, path: String) -> Result<(), String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    tokio::fs::create_dir_all(&resolved).await.map_err(|e| e.to_string())
}

#[command]
pub async fn vault_remove(state: State<'_, VaultState>, path: String) -> Result<(), String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    if resolved == root {
        return Err("Cannot delete the vault root".into());
    }

    match tokio::fs::metadata(&resolved).await {
        Ok(metadata) if metadata.is_dir() => tokio::fs::remove_dir_all(&resolved)
            .await
            .map_err(|e| e.to_string()),
        Ok(_) => tokio::fs::remove_file(&resolved).await.map_err(|e| e.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[command]
pub async fn vault_rename(
    state: State<'_, VaultState>,
    from: String,
    to: String,
) -> Result<(), String> {
    let root = get_vault_root(&state)?;
    let from_resolved = resolve_vault_path(&root, &from)?;
    let to_resolved = resolve_vault_path(&root, &to)?;
    if from_resolved == root || to_resolved == root {
        return Err("Cannot rename the vault root".into());
    }
    if let Some(parent) = to_resolved.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    tokio::fs::rename(&from_resolved, &to_resolved).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::async_runtime;

    fn temp_vault() -> PathBuf {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        let dir = std::env::temp_dir().join(format!("kuku-vault-test-{now}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_checksum_roundtrip() {
        let content = "hello";
        let checksum = compute_checksum(content);
        assert_eq!(checksum.len(), 64);
    }

    #[test]
    fn test_read_directory_recursive_filters_hidden() {
        let root = temp_vault();
        fs::write(root.join("a.md"), "a").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "x").unwrap();

        let entries = async_runtime::block_on(read_directory_recursive(&root, &root)).unwrap();
        assert!(entries.iter().any(|e| e.path == "a.md"));
        assert!(!entries.iter().any(|e| e.path.starts_with(".git")));
    }
}
