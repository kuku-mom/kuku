use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, State, command};
use tauri_plugin_dialog::DialogExt;

use crate::models::{ChecksumWriteResult, FileEntry, FileReadResult};
use crate::search::SearchState;
use crate::vault::checksum::compute_checksum;
use crate::vault::{
    DEFAULT_FILE_EXTENSIONS, get_vault_root, read_directory_recursive, resolve_vault_path,
};
use crate::vault::{VaultState, watcher};

const KUKU_TRASH_DIR: &str = ".trash";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum VaultDeleteMode {
    Trash,
    KukuTrash,
    Permanent,
}

fn next_available_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }

    let parent = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .or_else(|| path.file_name().and_then(|value| value.to_str()))
        .unwrap_or("item");
    let ext = path.extension().and_then(|value| value.to_str());

    for index in 1.. {
        let candidate_name = match ext {
            Some(ext) if !ext.is_empty() => format!("{stem} {index}.{ext}"),
            _ => format!("{stem} {index}"),
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    unreachable!("path suffix loop must eventually find a free candidate");
}

fn build_kuku_trash_destination(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let candidate = resolve_vault_path(root, &format!("{KUKU_TRASH_DIR}/{relative_path}"))?;
    Ok(next_available_path(&candidate))
}

#[derive(Debug, Eq, PartialEq)]
enum ChecksumWritePlan {
    Conflict { expected: String, actual: String },
    Unchanged { checksum: String },
    Changed { checksum: String },
}

fn plan_checksum_write(
    current_content: &str,
    next_content: &str,
    expected_checksum: &str,
) -> ChecksumWritePlan {
    let current_checksum = compute_checksum(current_content);
    if current_checksum != expected_checksum {
        return ChecksumWritePlan::Conflict {
            expected: expected_checksum.to_string(),
            actual: current_checksum,
        };
    }

    if current_content == next_content {
        return ChecksumWritePlan::Unchanged {
            checksum: current_checksum,
        };
    }

    ChecksumWritePlan::Changed {
        checksum: compute_checksum(next_content),
    }
}

#[command]
pub async fn vault_open(
    app: AppHandle,
    state: State<'_, VaultState>,
    search: State<'_, SearchState>,
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

    search.switch_vault(root.to_path_buf())?;

    let stop_tx = watcher::start_watching_with_search(
        app,
        root.to_path_buf(),
        Some(search.inner().clone()),
        state.expected_mutations.clone(),
    )?;
    {
        let mut guard = state.inner.lock();
        guard.watcher_stop_tx = Some(stop_tx);
    }
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
pub async fn vault_close(
    state: State<'_, VaultState>,
    search: State<'_, SearchState>,
) -> Result<(), String> {
    {
        let mut guard = state.inner.lock();
        if let Some(stop_tx) = guard.watcher_stop_tx.take() {
            let _ = watcher::stop_watching(stop_tx);
        }
        guard.path = None;
    }
    search.close_runtime()?;
    Ok(())
}

#[command]
pub async fn vault_get_current(state: State<'_, VaultState>) -> Result<Option<String>, String> {
    let guard = state.inner.lock();
    Ok(guard
        .path
        .as_ref()
        .and_then(|p| p.to_str().map(|s| s.to_string())))
}

#[command]
pub async fn vault_read_text(state: State<'_, VaultState>, path: String) -> Result<String, String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    tokio::fs::read_to_string(&resolved)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn vault_write_text(
    state: State<'_, VaultState>,
    search: State<'_, SearchState>,
    path: String,
    content: String,
) -> Result<(), String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    let mutation = state.expected_mutations.record_write(&path, false);
    if let Some(parent) = resolved.parent() {
        if let Err(error) = tokio::fs::create_dir_all(parent).await {
            state.expected_mutations.cancel(mutation);
            return Err(error.to_string());
        }
    }
    if let Err(error) = tokio::fs::write(&resolved, &content).await {
        state.expected_mutations.cancel(mutation);
        return Err(error.to_string());
    }
    if let Err(error) = search.notify_written(&path) {
        state.expected_mutations.cancel(mutation);
        return Err(error);
    }
    Ok(())
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
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&resolved, &data)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn vault_read_with_checksum(
    state: State<'_, VaultState>,
    path: String,
) -> Result<FileReadResult, String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    let content = tokio::fs::read_to_string(&resolved)
        .await
        .map_err(|e| e.to_string())?;
    let checksum = compute_checksum(&content);
    Ok(FileReadResult { content, checksum })
}

#[command]
pub async fn vault_write_with_checksum(
    state: State<'_, VaultState>,
    search: State<'_, SearchState>,
    path: String,
    content: String,
    checksum: String,
) -> Result<ChecksumWriteResult, String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    let current_content = tokio::fs::read_to_string(&resolved)
        .await
        .map_err(|e| e.to_string())?;

    let plan = plan_checksum_write(&current_content, &content, &checksum);
    let next_checksum = match plan {
        ChecksumWritePlan::Conflict { expected, actual } => {
            return Ok(ChecksumWriteResult::Conflict { expected, actual });
        }
        ChecksumWritePlan::Unchanged { checksum } => {
            return Ok(ChecksumWriteResult::Written { checksum });
        }
        ChecksumWritePlan::Changed { checksum } => checksum,
    };

    let mutation = state.expected_mutations.record_write(&path, false);
    if let Err(error) = tokio::fs::write(&resolved, &content).await {
        state.expected_mutations.cancel(mutation);
        return Err(error.to_string());
    }
    if let Err(error) = search.notify_written(&path) {
        state.expected_mutations.cancel(mutation);
        return Err(error);
    }
    Ok(ChecksumWriteResult::Written {
        checksum: next_checksum,
    })
}

#[command]
pub async fn vault_exists(state: State<'_, VaultState>, path: String) -> Result<bool, String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    tokio::fs::try_exists(&resolved)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn vault_list_dir(
    state: State<'_, VaultState>,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    read_directory_recursive(&resolved, &root, DEFAULT_FILE_EXTENSIONS).await
}

#[command]
pub async fn vault_mkdir(state: State<'_, VaultState>, path: String) -> Result<(), String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    tokio::fs::create_dir_all(&resolved)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn vault_get_trash_path(
    state: State<'_, VaultState>,
    ensure_exists: bool,
) -> Result<String, String> {
    let root = get_vault_root(&state)?;
    let trash_path = root.join(KUKU_TRASH_DIR);
    if ensure_exists {
        tokio::fs::create_dir_all(&trash_path)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(trash_path.to_string_lossy().to_string())
}

#[command]
pub async fn vault_empty_trash(state: State<'_, VaultState>) -> Result<(), String> {
    let root = get_vault_root(&state)?;
    let trash_path = root.join(KUKU_TRASH_DIR);

    if tokio::fs::try_exists(&trash_path)
        .await
        .map_err(|e| e.to_string())?
    {
        tokio::fs::remove_dir_all(&trash_path)
            .await
            .map_err(|e| e.to_string())?;
    }

    tokio::fs::create_dir_all(&trash_path)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[command]
pub async fn vault_delete(
    state: State<'_, VaultState>,
    search: State<'_, SearchState>,
    path: String,
    mode: VaultDeleteMode,
) -> Result<(), String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path(&root, &path)?;
    if resolved == root {
        return Err("Cannot delete the vault root".into());
    }

    let metadata = match tokio::fs::metadata(&resolved).await {
        Ok(metadata) => Some(metadata),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(err.to_string()),
    };
    let is_dir = metadata.as_ref().is_some_and(|entry| entry.is_dir());
    let mutation = metadata
        .as_ref()
        .map(|_| state.expected_mutations.record_delete(&path, is_dir));

    let mutation_result = async {
        match (mode, metadata) {
            (_, None) => {}
            (VaultDeleteMode::Permanent, Some(metadata)) if metadata.is_dir() => {
                tokio::fs::remove_dir_all(&resolved)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            (VaultDeleteMode::Permanent, Some(_)) => {
                tokio::fs::remove_file(&resolved)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            (VaultDeleteMode::KukuTrash, Some(_)) => {
                let destination = build_kuku_trash_destination(&root, &path)?;
                let parent = destination
                    .parent()
                    .ok_or_else(|| "Failed to resolve trash destination parent".to_string())?;
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| e.to_string())?;
                tokio::fs::rename(&resolved, &destination)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            (VaultDeleteMode::Trash, Some(_)) => {
                let resolved_for_delete = resolved.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    trash::delete(&resolved_for_delete)
                        .map_err(|e| format!("Failed to move item to system trash: {e}"))
                })
                .await
                .map_err(|e| format!("Failed to move item to system trash: {e}"))??;
            }
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = mutation_result {
        if let Some(mutation) = mutation {
            state.expected_mutations.cancel(mutation);
        }
        return Err(error);
    }

    if let Err(error) = search.notify_removed(&path, is_dir) {
        if let Some(mutation) = mutation {
            state.expected_mutations.cancel(mutation);
        }
        return Err(error);
    }
    Ok(())
}

#[command]
pub async fn vault_remove(
    state: State<'_, VaultState>,
    search: State<'_, SearchState>,
    path: String,
) -> Result<(), String> {
    vault_delete(state, search, path, VaultDeleteMode::Permanent).await
}

#[command]
pub async fn vault_rename(
    state: State<'_, VaultState>,
    search: State<'_, SearchState>,
    from: String,
    to: String,
) -> Result<(), String> {
    let root = get_vault_root(&state)?;
    let from_resolved = resolve_vault_path(&root, &from)?;
    let to_resolved = resolve_vault_path(&root, &to)?;
    let metadata = tokio::fs::metadata(&from_resolved)
        .await
        .map_err(|e| e.to_string())?;
    let is_dir = metadata.is_dir();
    if from_resolved == root || to_resolved == root {
        return Err("Cannot rename the vault root".into());
    }
    if let Some(parent) = to_resolved.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    let mutation = state.expected_mutations.record_rename(&from, &to, is_dir);
    if let Err(error) = tokio::fs::rename(&from_resolved, &to_resolved).await {
        state.expected_mutations.cancel(mutation);
        return Err(error.to_string());
    }
    if let Err(error) = search.notify_renamed(&from, &to, is_dir) {
        state.expected_mutations.cancel(mutation);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::async_runtime;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_vault() -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let suffix = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("kuku-vault-test-{now}-{suffix}"));
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
    fn test_plan_checksum_write_skips_unchanged_content() {
        let current = "same";
        let checksum = compute_checksum(current);

        let plan = plan_checksum_write(current, current, &checksum);

        assert_eq!(plan, ChecksumWritePlan::Unchanged { checksum });
    }

    #[test]
    fn test_plan_checksum_write_detects_changed_content() {
        let checksum = compute_checksum("old");

        let plan = plan_checksum_write("old", "new", &checksum);

        assert_eq!(
            plan,
            ChecksumWritePlan::Changed {
                checksum: compute_checksum("new")
            }
        );
    }

    #[test]
    fn test_plan_checksum_write_reports_conflict() {
        let expected = compute_checksum("expected");
        let actual = compute_checksum("actual");

        let plan = plan_checksum_write("actual", "new", &expected);

        assert_eq!(plan, ChecksumWritePlan::Conflict { expected, actual });
    }

    #[test]
    fn test_read_directory_recursive_filters_hidden() {
        let root = temp_vault();
        fs::write(root.join("a.md"), "a").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "x").unwrap();

        let entries = async_runtime::block_on(read_directory_recursive(
            &root,
            &root,
            DEFAULT_FILE_EXTENSIONS,
        ))
        .unwrap();
        assert!(entries.iter().any(|e| e.path == "a.md"));
        assert!(!entries.iter().any(|e| e.path.starts_with(".git")));
    }

    #[test]
    fn test_read_directory_recursive_filters_non_md_files() {
        let root = temp_vault();
        fs::write(root.join("note.md"), "# note").unwrap();
        fs::write(root.join("image.png"), "binary").unwrap();
        fs::write(root.join("data.json"), "{}").unwrap();

        let entries = async_runtime::block_on(read_directory_recursive(
            &root,
            &root,
            DEFAULT_FILE_EXTENSIONS,
        ))
        .unwrap();
        assert!(entries.iter().any(|e| e.path == "note.md"));
        assert!(!entries.iter().any(|e| e.path == "image.png"));
        assert!(!entries.iter().any(|e| e.path == "data.json"));
    }

    #[test]
    fn test_build_kuku_trash_destination_preserves_relative_path() {
        let root = temp_vault();

        let destination = build_kuku_trash_destination(&root, "notes/a.md").unwrap();

        assert_eq!(destination, root.join(".trash/notes/a.md"));
    }

    #[test]
    fn test_build_kuku_trash_destination_appends_suffix_when_needed() {
        let root = temp_vault();
        let existing = root.join(".trash/notes/a.md");
        fs::create_dir_all(existing.parent().unwrap()).unwrap();
        fs::write(&existing, "old").unwrap();

        let destination = build_kuku_trash_destination(&root, "notes/a.md").unwrap();

        assert_eq!(destination, root.join(".trash/notes/a 1.md"));
    }
}
