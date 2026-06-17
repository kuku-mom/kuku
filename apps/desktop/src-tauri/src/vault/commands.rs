use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, State, command};
use tauri_plugin_dialog::DialogExt;

use crate::models::{ChecksumWriteResult, FileEntry, FileReadResult};
use crate::search::SearchState;
use crate::sync::{self, SyncState};
use crate::vault::checksum::compute_checksum;
use crate::vault::{
    DEFAULT_FILE_EXTENSIONS, get_vault_root, read_directory_recursive, resolve_vault_path_strict,
};
use crate::vault::{VaultState, watcher};

const KUKU_TRASH_DIR: &str = ".trash";
const VAULT_PLUGIN_DIR: &str = ".kuku/plugins";
/// Bound on `next_available_path`'s suffix scan. Real trash collisions
/// resolve in the first few attempts; a cap turns a pathological filesystem
/// (permission flips, another process racing the counter) into a clean
/// error instead of a busy loop that only escapes via integer overflow.
const MAX_SUFFIX_ATTEMPTS: u32 = 10_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum VaultDeleteMode {
    Trash,
    KukuTrash,
    Permanent,
}

fn is_case_only_rename(from: &Path, to: &Path) -> bool {
    if from == to {
        return false;
    }
    match (from.to_str(), to.to_str()) {
        (Some(from_str), Some(to_str)) => from_str.eq_ignore_ascii_case(to_str),
        _ => false,
    }
}

async fn rename_via_intermediate(from: &Path, to: &Path) -> Result<(), String> {
    let parent = to
        .parent()
        .ok_or_else(|| "Destination has no parent".to_string())?;
    let base_name = to
        .file_name()
        .and_then(|segment| segment.to_str())
        .ok_or_else(|| "Destination file name is not valid UTF-8".to_string())?;

    // Leading dot keeps the intermediate hidden and filtered by the vault
    // watcher's `should_ignore_path`, so clients don't see the stepping-stone.
    let intermediate = parent.join(format!(
        ".kuku-case-rename-{}-{}",
        std::process::id(),
        base_name
    ));

    tokio::fs::rename(from, &intermediate)
        .await
        .map_err(|error| error.to_string())?;
    if let Err(error) = tokio::fs::rename(&intermediate, to).await {
        // Best-effort rollback so a failure doesn't leave the entry under
        // the hidden intermediate name.
        let _ = tokio::fs::rename(&intermediate, from).await;
        return Err(error.to_string());
    }
    Ok(())
}

fn next_available_path(path: &Path) -> Result<PathBuf, String> {
    match path.try_exists() {
        Ok(false) => return Ok(path.to_path_buf()),
        Ok(true) => {}
        Err(error) => {
            return Err(format!(
                "Failed to check trash destination availability for {}: {error}",
                path.display()
            ));
        }
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

    for index in 1..=MAX_SUFFIX_ATTEMPTS {
        let candidate_name = match ext {
            Some(ext) if !ext.is_empty() => format!("{stem} {index}.{ext}"),
            _ => format!("{stem} {index}"),
        };
        let candidate = parent.join(candidate_name);
        match candidate.try_exists() {
            Ok(false) => return Ok(candidate),
            Ok(true) => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to check trash destination availability for {}: {error}",
                    candidate.display()
                ));
            }
        }
    }

    Err(format!(
        "Could not find an available trash destination for {} after {MAX_SUFFIX_ATTEMPTS} attempts",
        path.display()
    ))
}

async fn build_kuku_trash_destination(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let candidate =
        resolve_vault_path_strict(root, &format!("{KUKU_TRASH_DIR}/{relative_path}")).await?;
    next_available_path(&candidate)
}

#[derive(Debug, Eq, PartialEq)]
enum ChecksumWritePlan {
    Conflict { expected: String, actual: String },
    Unchanged { checksum: String },
    Changed { checksum: String },
}

fn validate_vault_plugin_id(plugin_id: &str) -> Result<(), String> {
    if plugin_id.is_empty()
        || plugin_id == "."
        || plugin_id == ".."
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
    {
        return Err("Invalid plugin ID".into());
    }
    Ok(())
}

fn resolve_vault_plugin_path_from_root(
    vault_root: &Path,
    plugin_id: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    validate_vault_plugin_id(plugin_id)?;

    let sandbox = vault_root.join(VAULT_PLUGIN_DIR).join(plugin_id);
    let mut resolved = sandbox.clone();

    for component in Path::new(relative_path).components() {
        match component {
            Component::Normal(c) => resolved.push(c),
            Component::ParentDir => {
                resolved.pop();
                if !resolved.starts_with(&sandbox) {
                    return Err(format!(
                        "Path traversal denied: '{relative_path}' escapes vault plugin sandbox"
                    ));
                }
            }
            Component::CurDir => {}
            _ => {
                return Err(format!("Absolute paths not allowed: '{relative_path}'"));
            }
        }
    }

    if !resolved.starts_with(&sandbox) {
        return Err(format!(
            "Path traversal denied: '{relative_path}' resolved outside vault plugin sandbox"
        ));
    }

    Ok(resolved)
}

async fn resolve_vault_plugin_path_strict(
    vault_root: &Path,
    plugin_id: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let resolved = resolve_vault_plugin_path_from_root(vault_root, plugin_id, relative_path)?;
    crate::vault::assert_no_symlink_within_vault(vault_root, &resolved).await?;
    Ok(resolved)
}

fn plan_checksum_write(
    current_content: &str,
    next_content: &str,
    expected_checksum: &str,
) -> ChecksumWritePlan {
    let current_checksum = compute_checksum(current_content);
    if current_content == next_content {
        return ChecksumWritePlan::Unchanged {
            checksum: current_checksum,
        };
    }

    if current_checksum != expected_checksum {
        return ChecksumWritePlan::Conflict {
            expected: expected_checksum.to_string(),
            actual: current_checksum,
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
    sync_state: State<'_, SyncState>,
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
    validate_vault_owner(root, &metadata)?;

    {
        let mut guard = state.inner.lock();
        if let Some(stop_tx) = guard.watcher_stop_tx.take() {
            let _ = watcher::stop_watching(stop_tx);
        }
        guard.path = Some(root.to_path_buf());
    }

    search.switch_vault(root.to_path_buf())?;
    if let Err(error) = sync::commands::restore_vault_config_for_root(&app, &sync_state, root) {
        eprintln!(
            "failed to restore sync config for vault {}: {error}",
            root.display()
        );
        sync::commands::reset_vault_config_runtime(&app, &sync_state);
    }

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

fn validate_vault_owner(root: &Path, metadata: &std::fs::Metadata) -> Result<(), String> {
    validate_path_owner(root, metadata, "Vault path")?;
    let config_dir = root.join(".kuku");
    match std::fs::metadata(&config_dir) {
        Ok(metadata) => validate_path_owner(&config_dir, &metadata, "Vault sync config directory"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to inspect vault sync config directory {}: {error}",
            config_dir.display()
        )),
    }
}

#[cfg(unix)]
fn validate_path_owner(
    path: &Path,
    metadata: &std::fs::Metadata,
    label: &str,
) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;

    let owner_uid = metadata.uid();
    let current_uid = current_user_uid();
    if is_current_user_owned_uid(owner_uid, current_uid) {
        return Ok(());
    }
    Err(format!(
        "{label} is owned by another OS user: {}",
        path.display()
    ))
}

#[cfg(not(unix))]
fn validate_path_owner(
    _path: &Path,
    _metadata: &std::fs::Metadata,
    _label: &str,
) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn current_user_uid() -> u32 {
    unsafe { getuid() }
}

#[cfg(unix)]
fn is_current_user_owned_uid(owner_uid: u32, current_uid: u32) -> bool {
    owner_uid == current_uid
}

#[cfg(unix)]
unsafe extern "C" {
    fn getuid() -> u32;
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
    app: AppHandle,
    state: State<'_, VaultState>,
    search: State<'_, SearchState>,
    sync_state: State<'_, SyncState>,
) -> Result<(), String> {
    {
        let mut guard = state.inner.lock();
        if let Some(stop_tx) = guard.watcher_stop_tx.take() {
            let _ = watcher::stop_watching(stop_tx);
        }
        guard.path = None;
    }
    search.close_runtime()?;
    sync::commands::reset_vault_config_runtime(&app, &sync_state);
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
    let resolved = resolve_vault_path_strict(&root, &path).await?;
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
    // Generic imperative write path for vault APIs and plugins.
    // Unlike checksum-based editor saves, this path intentionally does
    // not short-circuit unchanged content yet.
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path_strict(&root, &path).await?;
    let mutation = state.expected_mutations.record_write(&path, false);
    if let Some(parent) = resolved.parent()
        && let Err(error) = tokio::fs::create_dir_all(parent).await
    {
        state.expected_mutations.cancel(mutation);
        return Err(error.to_string());
    }
    if let Err(error) = tokio::fs::write(&resolved, &content).await {
        state.expected_mutations.cancel(mutation);
        return Err(error.to_string());
    }
    if let Err(error) = search.notify_written_with_source(&path, "app-save") {
        state.expected_mutations.cancel(mutation);
        return Err(error);
    }
    Ok(())
}

#[command]
pub async fn vault_plugin_fs_read_text(
    state: State<'_, VaultState>,
    plugin_id: String,
    path: String,
) -> Result<String, String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_plugin_path_strict(&root, &plugin_id, &path).await?;
    tokio::fs::read_to_string(&resolved)
        .await
        .map_err(|e| format!("Failed to read '{}': {e}", resolved.display()))
}

#[command]
pub async fn vault_plugin_fs_write_text(
    state: State<'_, VaultState>,
    plugin_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_plugin_path_strict(&root, &plugin_id, &path).await?;
    if let Some(parent) = resolved.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create parent dirs: {e}"))?;
    }
    tokio::fs::write(&resolved, &content)
        .await
        .map_err(|e| format!("Failed to write '{}': {e}", resolved.display()))
}

#[command]
pub async fn vault_plugin_fs_read_dir(
    state: State<'_, VaultState>,
    plugin_id: String,
    path: String,
) -> Result<Vec<String>, String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_plugin_path_strict(&root, &plugin_id, &path).await?;
    let mut reader = tokio::fs::read_dir(&resolved)
        .await
        .map_err(|e| format!("Failed to read directory '{}': {e}", resolved.display()))?;
    let mut names = Vec::new();
    while let Some(entry) = reader.next_entry().await.map_err(|e| e.to_string())? {
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_string());
        }
    }
    names.sort();
    Ok(names)
}

#[command]
pub async fn vault_plugin_fs_remove(
    state: State<'_, VaultState>,
    plugin_id: String,
    path: String,
) -> Result<(), String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_plugin_path_strict(&root, &plugin_id, &path).await?;
    let sandbox = resolve_vault_plugin_path_from_root(&root, &plugin_id, "")?;
    if resolved == sandbox {
        return Err("Cannot remove vault plugin root directory".into());
    }

    if tokio::fs::try_exists(&resolved)
        .await
        .map_err(|e| e.to_string())?
    {
        tokio::fs::remove_dir_all(&resolved)
            .await
            .map_err(|e| format!("Failed to remove '{}': {e}", resolved.display()))?;
    }
    Ok(())
}

#[command]
pub async fn vault_read_binary(
    state: State<'_, VaultState>,
    path: String,
) -> Result<Vec<u8>, String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path_strict(&root, &path).await?;
    tokio::fs::read(&resolved).await.map_err(|e| e.to_string())
}

#[command]
pub async fn vault_write_binary(
    state: State<'_, VaultState>,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path_strict(&root, &path).await?;
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
    search: State<'_, SearchState>,
    path: String,
) -> Result<FileReadResult, String> {
    // Read-only bootstrap path for editor load. This command does not
    // trigger index reconciliation or other write-side effects.
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path_strict(&root, &path).await?;
    let content = tokio::fs::read_to_string(&resolved)
        .await
        .map_err(|e| e.to_string())?;
    let checksum = compute_checksum(&content);
    let search_state = search.inner().clone();
    let reconcile_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = search_state.reconcile_loaded_markdown(&reconcile_path);
    });
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
    // Editor save path with conflict detection and unchanged-content skip.
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path_strict(&root, &path).await?;
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
    if let Err(error) = search.notify_written_with_source(&path, "app-save") {
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
    let resolved = resolve_vault_path_strict(&root, &path).await?;
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
    let resolved = resolve_vault_path_strict(&root, &path).await?;
    read_directory_recursive(&resolved, &root, DEFAULT_FILE_EXTENSIONS).await
}

#[command]
pub async fn vault_mkdir(state: State<'_, VaultState>, path: String) -> Result<(), String> {
    let root = get_vault_root(&state)?;
    let resolved = resolve_vault_path_strict(&root, &path).await?;
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
    let resolved = resolve_vault_path_strict(&root, &path).await?;
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
                let destination = build_kuku_trash_destination(&root, &path).await?;
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

    if let Err(error) = search.notify_removed_with_source(&path, is_dir, "app-delete") {
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
    let from_resolved = resolve_vault_path_strict(&root, &from).await?;
    let to_resolved = resolve_vault_path_strict(&root, &to).await?;
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
    let rename_result = if is_case_only_rename(&from_resolved, &to_resolved) {
        // APFS (macOS default) is case-insensitive and case-preserving: a
        // direct `rename("Foo.md", "foo.md")` resolves both paths to the same
        // entry and leaves the on-disk name unchanged. Bouncing through a
        // dotfile intermediate forces the filesystem to commit the new case.
        rename_via_intermediate(&from_resolved, &to_resolved).await
    } else {
        tokio::fs::rename(&from_resolved, &to_resolved)
            .await
            .map_err(|e| e.to_string())
    };
    if let Err(error) = rename_result {
        state.expected_mutations.cancel(mutation);
        return Err(error);
    }
    if let Err(error) = search.notify_renamed_with_source(&from, &to, is_dir, "app-rename") {
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
    fn test_plan_checksum_write_accepts_unchanged_content_after_external_write() {
        let current = "same";
        let checksum = compute_checksum(current);

        let plan = plan_checksum_write(current, current, &compute_checksum("old"));

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

        let destination =
            async_runtime::block_on(build_kuku_trash_destination(&root, "notes/a.md")).unwrap();

        assert_eq!(destination, root.join(".trash/notes/a.md"));
    }

    #[test]
    fn test_build_kuku_trash_destination_appends_suffix_when_needed() {
        let root = temp_vault();
        let existing = root.join(".trash/notes/a.md");
        fs::create_dir_all(existing.parent().unwrap()).unwrap();
        fs::write(&existing, "old").unwrap();

        let destination =
            async_runtime::block_on(build_kuku_trash_destination(&root, "notes/a.md")).unwrap();

        assert_eq!(destination, root.join(".trash/notes/a 1.md"));
    }

    #[test]
    fn vault_plugin_path_resolves_inside_vault_plugin_directory() {
        let root = PathBuf::from("/tmp/vault");
        let result =
            resolve_vault_plugin_path_from_root(&root, "ai-widgets", "projects/demo/manifest.json")
                .unwrap();

        assert_eq!(
            result,
            root.join(".kuku")
                .join("plugins")
                .join("ai-widgets")
                .join("projects")
                .join("demo")
                .join("manifest.json")
        );
    }

    #[test]
    fn vault_plugin_path_blocks_plugin_directory_escape() {
        let root = PathBuf::from("/tmp/vault");
        let result =
            resolve_vault_plugin_path_from_root(&root, "ai-widgets", "../../other/file.json");

        assert!(result.is_err());
    }

    #[test]
    fn vault_plugin_path_blocks_invalid_plugin_id() {
        let root = PathBuf::from("/tmp/vault");
        let result = resolve_vault_plugin_path_from_root(&root, "../evil", "projects");

        assert!(result.is_err());

        let result = resolve_vault_plugin_path_from_root(&root, "..", "projects");

        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn vault_owner_check_allows_current_user_owned_temp_dir() {
        let root = temp_vault();
        let metadata = fs::metadata(&root).unwrap();

        validate_vault_owner(&root, &metadata).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn vault_owner_check_rejects_mismatched_uid() {
        assert!(is_current_user_owned_uid(7, 7));
        assert!(!is_current_user_owned_uid(7, 8));
    }
}
