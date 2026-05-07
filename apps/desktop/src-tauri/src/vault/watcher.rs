use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::time::{Duration, Instant};

use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use crate::models::FileChangeEvent;
use crate::search::{SearchState, is_markdown_path};
use crate::vault::{should_ignore_path, to_relative_path};

struct PendingRename {
    path: PathBuf,
    is_dir: bool,
    at: Instant,
}

struct SearchStormState {
    window_started_at: Instant,
    modify_create_count: usize,
}

type PathKindCache = HashMap<PathBuf, bool>;

const PENDING_RENAME_TIMEOUT_MS: u64 = 600;
const EXPECTED_MUTATION_TTL_MS: u64 = 2_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExpectedMutationKind {
    Write,
    Delete,
    Rename,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExpectedMutationToken {
    id: u64,
}

#[derive(Clone, Debug)]
struct ExpectedFsMutation {
    id: u64,
    kind: ExpectedMutationKind,
    path: String,
    old_path: Option<String>,
    is_dir: bool,
    created_at: Instant,
}

#[derive(Clone, Default)]
pub struct ExpectedMutationLedger {
    entries: Arc<Mutex<Vec<ExpectedFsMutation>>>,
    next_id: Arc<AtomicU64>,
}

impl ExpectedMutationLedger {
    pub fn record_write(&self, path: &str, is_dir: bool) -> ExpectedMutationToken {
        self.record(ExpectedMutationKind::Write, path, None, is_dir)
    }

    pub fn record_delete(&self, path: &str, is_dir: bool) -> ExpectedMutationToken {
        self.record(ExpectedMutationKind::Delete, path, None, is_dir)
    }

    pub fn record_rename(
        &self,
        old_path: &str,
        new_path: &str,
        is_dir: bool,
    ) -> ExpectedMutationToken {
        self.record(
            ExpectedMutationKind::Rename,
            new_path,
            Some(old_path.to_string()),
            is_dir,
        )
    }

    pub fn cancel(&self, token: ExpectedMutationToken) {
        let mut entries = self.entries.lock();
        entries.retain(|entry| entry.id != token.id);
    }

    fn record(
        &self,
        kind: ExpectedMutationKind,
        path: &str,
        old_path: Option<String>,
        is_dir: bool,
    ) -> ExpectedMutationToken {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.entries.lock().push(ExpectedFsMutation {
            id,
            kind,
            path: path.to_string(),
            old_path,
            is_dir,
            created_at: Instant::now(),
        });
        ExpectedMutationToken { id }
    }

    pub(crate) fn consume_matching(&self, event: &FileChangeEvent) -> bool {
        let mut entries = self.entries.lock();
        let now = Instant::now();
        entries.retain(|entry| {
            now.duration_since(entry.created_at) <= Duration::from_millis(EXPECTED_MUTATION_TTL_MS)
        });

        let Some(index) = entries
            .iter()
            .position(|entry| expected_mutation_matches_event(entry, event))
        else {
            return false;
        };
        entries.remove(index);
        true
    }
}

fn expected_mutation_matches_event(entry: &ExpectedFsMutation, event: &FileChangeEvent) -> bool {
    match entry.kind {
        ExpectedMutationKind::Write => {
            matches!(event.kind.as_str(), "create" | "modify")
                && entry.is_dir == event.is_dir
                && paths_match(&entry.path, &event.path)
        }
        ExpectedMutationKind::Delete => {
            (event.kind == "delete"
                && entry.is_dir == event.is_dir
                && paths_match(&entry.path, &event.path))
                || (event.kind == "rename"
                    && event
                        .old_path
                        .as_deref()
                        .is_some_and(|old_path| paths_match(&entry.path, old_path)))
        }
        ExpectedMutationKind::Rename => {
            if matches!(event.kind.as_str(), "create" | "modify") {
                return entry.is_dir == event.is_dir && paths_match(&entry.path, &event.path);
            }

            event.kind == "rename"
                && entry.is_dir == event.is_dir
                && paths_match(&entry.path, &event.path)
                && match (&entry.old_path, &event.old_path) {
                    (Some(expected), Some(actual)) => paths_match(expected, actual),
                    (_, None) => true,
                    (None, Some(_)) => true,
                }
        }
    }
}

fn paths_match(left: &str, right: &str) -> bool {
    left == right || left.eq_ignore_ascii_case(right)
}

fn is_ignored(root: &Path, path: &Path) -> bool {
    if let Ok(rel) = path.strip_prefix(root) {
        return should_ignore_path(rel);
    }
    false
}

fn maybe_cleanup_pending(
    pending: &mut Option<PendingRename>,
    root: &Path,
    cache: &mut PathKindCache,
) -> Option<FileChangeEvent> {
    // Peek first to keep the value in place if the timeout hasn't elapsed —
    // `.take().expect(...)` would panic the watcher thread if the borrow
    // check invariant ever drifted, and the watcher has no supervisor to
    // restart it.
    let elapsed = pending
        .as_ref()
        .is_some_and(|p| p.at.elapsed() > Duration::from_millis(PENDING_RENAME_TIMEOUT_MS));
    if !elapsed {
        return None;
    }
    let p = pending.take()?;
    remove_cached_path(cache, &p.path, p.is_dir);
    let rel = to_relative_path(root, &p.path);
    Some(FileChangeEvent {
        kind: "delete".to_string(),
        path: rel,
        is_dir: p.is_dir,
        old_path: None,
    })
}

fn seed_path_kind_cache(root: &Path) -> Result<PathKindCache, String> {
    let mut cache = PathKindCache::new();
    collect_path_kinds(root, root, &mut cache)?;
    Ok(cache)
}

fn collect_path_kinds(root: &Path, dir: &Path, cache: &mut PathKindCache) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|error| {
        format!(
            "Failed to read watcher directory {}: {error}",
            dir.display()
        )
    })?;

    for entry in entries {
        let entry = entry
            .map_err(|error| format!("Failed to read watcher entry {}: {error}", dir.display()))?;
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .map_err(|error| format!("Failed to strip watcher root prefix: {error}"))?;
        if should_ignore_path(rel) {
            continue;
        }

        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to stat watcher path {}: {error}", path.display()))?;
        let is_dir = file_type.is_dir();
        cache.insert(path.clone(), is_dir);
        if is_dir {
            collect_path_kinds(root, &path, cache)?;
        }
    }

    Ok(())
}

fn infer_path_kind(path: &Path, hinted_is_dir: Option<bool>, cache: &PathKindCache) -> bool {
    hinted_is_dir
        .or_else(|| fs::metadata(path).ok().map(|metadata| metadata.is_dir()))
        .or_else(|| cache.get(path).copied())
        .unwrap_or(false)
}

fn insert_cached_path(cache: &mut PathKindCache, path: &Path, is_dir: bool) {
    cache.insert(path.to_path_buf(), is_dir);
}

fn remove_cached_path(cache: &mut PathKindCache, path: &Path, is_dir: bool) {
    if !is_dir {
        cache.remove(path);
        return;
    }

    let to_remove = cache
        .keys()
        .filter(|candidate| candidate.starts_with(path))
        .cloned()
        .collect::<Vec<_>>();

    for candidate in to_remove {
        cache.remove(&candidate);
    }
}

fn rename_cached_path(cache: &mut PathKindCache, from: &Path, to: &Path, is_dir: bool) {
    if !is_dir {
        let _ = cache.remove(from);
        cache.insert(to.to_path_buf(), false);
        return;
    }

    let descendants = cache
        .iter()
        .filter(|(candidate, _)| candidate.starts_with(from))
        .map(|(candidate, cached_is_dir)| (candidate.clone(), *cached_is_dir))
        .collect::<Vec<_>>();

    for (candidate, cached_is_dir) in descendants {
        cache.remove(&candidate);
        let suffix = candidate.strip_prefix(from).unwrap_or(Path::new(""));
        let remapped = if suffix.as_os_str().is_empty() {
            to.to_path_buf()
        } else {
            to.join(suffix)
        };
        cache.insert(remapped, cached_is_dir);
    }

    cache.entry(to.to_path_buf()).or_insert(true);
}

fn find_case_only_cached_path(cache: &PathKindCache, path: &Path) -> Option<PathBuf> {
    let path_text = path.to_string_lossy();
    cache
        .keys()
        .find(|candidate| {
            candidate.as_path() != path
                && candidate.to_string_lossy().eq_ignore_ascii_case(&path_text)
        })
        .cloned()
}

fn map_case_only_cached_rename(
    root: &Path,
    path: &Path,
    is_dir: bool,
    cache: &mut PathKindCache,
) -> Option<FileChangeEvent> {
    let old_path = find_case_only_cached_path(cache, path)?;
    let is_dir = is_dir || cache.get(&old_path).copied().unwrap_or(false);
    rename_cached_path(cache, &old_path, path, is_dir);
    Some(FileChangeEvent {
        kind: "rename".to_string(),
        path: to_relative_path(root, path),
        is_dir,
        old_path: Some(to_relative_path(root, &old_path)),
    })
}

fn map_event(
    event: Event,
    root: &Path,
    pending: &mut Option<PendingRename>,
    cache: &mut PathKindCache,
) -> Option<FileChangeEvent> {
    if event.paths.is_empty() {
        return None;
    }

    match event.kind {
        EventKind::Create(CreateKind::File)
        | EventKind::Create(CreateKind::Any)
        | EventKind::Create(CreateKind::Other) => {
            let path = &event.paths[0];
            if is_ignored(root, path) {
                return None;
            }
            let is_dir = infer_path_kind(path, None, cache);
            insert_cached_path(cache, path, is_dir);
            Some(FileChangeEvent {
                kind: "create".to_string(),
                path: to_relative_path(root, path),
                is_dir,
                old_path: None,
            })
        }
        EventKind::Create(CreateKind::Folder) => {
            let path = &event.paths[0];
            if is_ignored(root, path) {
                return None;
            }
            insert_cached_path(cache, path, true);
            Some(FileChangeEvent {
                kind: "create".to_string(),
                path: to_relative_path(root, path),
                is_dir: true,
                old_path: None,
            })
        }
        EventKind::Modify(ModifyKind::Data(_))
        | EventKind::Modify(ModifyKind::Metadata(_))
        | EventKind::Modify(ModifyKind::Any)
        | EventKind::Modify(ModifyKind::Other) => {
            let path = &event.paths[0];
            if is_ignored(root, path) {
                return None;
            }
            let is_dir = infer_path_kind(path, None, cache);
            insert_cached_path(cache, path, is_dir);
            Some(FileChangeEvent {
                kind: "modify".to_string(),
                path: to_relative_path(root, path),
                is_dir,
                old_path: None,
            })
        }
        EventKind::Remove(RemoveKind::File)
        | EventKind::Remove(RemoveKind::Any)
        | EventKind::Remove(RemoveKind::Other) => {
            let path = &event.paths[0];
            if is_ignored(root, path) {
                return None;
            }
            let is_dir = infer_path_kind(
                path,
                matches!(event.kind, EventKind::Remove(RemoveKind::Folder)).then_some(true),
                cache,
            );
            remove_cached_path(cache, path, is_dir);
            Some(FileChangeEvent {
                kind: "delete".to_string(),
                path: to_relative_path(root, path),
                is_dir,
                old_path: None,
            })
        }
        EventKind::Remove(RemoveKind::Folder) => {
            let path = &event.paths[0];
            if is_ignored(root, path) {
                return None;
            }
            remove_cached_path(cache, path, true);
            Some(FileChangeEvent {
                kind: "delete".to_string(),
                path: to_relative_path(root, path),
                is_dir: true,
                old_path: None,
            })
        }
        EventKind::Modify(ModifyKind::Name(rename)) => match rename {
            RenameMode::Both | RenameMode::Any | RenameMode::Other if event.paths.len() >= 2 => {
                let old_path = &event.paths[0];
                let new_path = &event.paths[1];
                if is_ignored(root, old_path) || is_ignored(root, new_path) {
                    return None;
                }
                let is_dir = infer_path_kind(new_path, None, cache)
                    || cache.get(old_path).copied().unwrap_or(false);
                rename_cached_path(cache, old_path, new_path, is_dir);
                Some(FileChangeEvent {
                    kind: "rename".to_string(),
                    path: to_relative_path(root, new_path),
                    is_dir,
                    old_path: Some(to_relative_path(root, old_path)),
                })
            }
            RenameMode::From => {
                let old_path = &event.paths[0];
                if is_ignored(root, old_path) {
                    return None;
                }
                let is_dir = infer_path_kind(old_path, None, cache);
                *pending = Some(PendingRename {
                    path: old_path.clone(),
                    is_dir,
                    at: Instant::now(),
                });
                None
            }
            RenameMode::To => {
                let new_path = &event.paths[0];
                if is_ignored(root, new_path) {
                    return None;
                }
                if let Some(prev) = pending.take()
                    && prev.at.elapsed() <= Duration::from_millis(PENDING_RENAME_TIMEOUT_MS)
                {
                    let is_dir = infer_path_kind(new_path, Some(prev.is_dir), cache);
                    rename_cached_path(cache, &prev.path, new_path, is_dir);
                    return Some(FileChangeEvent {
                        kind: "rename".to_string(),
                        path: to_relative_path(root, new_path),
                        is_dir,
                        old_path: Some(to_relative_path(root, &prev.path)),
                    });
                }
                let is_dir = infer_path_kind(new_path, None, cache);
                insert_cached_path(cache, new_path, is_dir);
                Some(FileChangeEvent {
                    kind: "create".to_string(),
                    path: to_relative_path(root, new_path),
                    is_dir,
                    old_path: None,
                })
            }
            RenameMode::Any | RenameMode::Other => {
                let path = &event.paths[0];
                if is_ignored(root, path) {
                    return None;
                }
                let is_dir = infer_path_kind(path, None, cache);
                if let Some(mapped) = map_case_only_cached_rename(root, path, is_dir, cache) {
                    return Some(mapped);
                }
                insert_cached_path(cache, path, is_dir);
                Some(FileChangeEvent {
                    kind: "modify".to_string(),
                    path: to_relative_path(root, path),
                    is_dir,
                    old_path: None,
                })
            }
            _ => None,
        },
        _ => None,
    }
}

pub fn start_watching_with_search(
    app: AppHandle,
    vault_root: PathBuf,
    search_state: Option<SearchState>,
    expected_mutations: ExpectedMutationLedger,
) -> Result<Sender<()>, String> {
    let (event_tx, event_rx) = mpsc::channel::<notify::Result<Event>>();
    let path_kind_cache = seed_path_kind_cache(&vault_root)?;
    let mut watcher = RecommendedWatcher::new(
        move |res| {
            let _ = event_tx.send(res);
        },
        notify::Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {e}"))?;

    watcher
        .watch(&vault_root, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch vault: {e}"))?;

    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let _watcher = watcher;
        let mut path_kind_cache = path_kind_cache;
        let mut pending_rename: Option<PendingRename> = None;
        let mut storm_state = SearchStormState {
            window_started_at: Instant::now(),
            modify_create_count: 0,
        };

        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }

            match event_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(event)) => {
                    if let Some(pending_delete) = maybe_cleanup_pending(
                        &mut pending_rename,
                        &vault_root,
                        &mut path_kind_cache,
                    ) {
                        let skip_search = expected_mutations.consume_matching(&pending_delete);
                        if let Some(search_state) = &search_state {
                            search_state.note_watcher_event(
                                &pending_delete,
                                if skip_search {
                                    "deduped-app-mutation"
                                } else {
                                    "external-watch"
                                },
                                skip_search,
                            );
                        }
                        if let Some(search_state) = &search_state
                            && !skip_search
                        {
                            handle_search_event(search_state, &pending_delete, &mut storm_state);
                        }
                        let _ = app_handle.emit("vault:file-changed", pending_delete);
                    }

                    if let Some(mapped) = map_event(
                        event,
                        &vault_root,
                        &mut pending_rename,
                        &mut path_kind_cache,
                    ) {
                        let skip_search = expected_mutations.consume_matching(&mapped);
                        if let Some(search_state) = &search_state {
                            search_state.note_watcher_event(
                                &mapped,
                                if skip_search {
                                    "deduped-app-mutation"
                                } else {
                                    "external-watch"
                                },
                                skip_search,
                            );
                        }
                        if let Some(search_state) = &search_state
                            && !skip_search
                        {
                            handle_search_event(search_state, &mapped, &mut storm_state);
                        }
                        let _ = app_handle.emit("vault:file-changed", mapped);
                    }
                }
                Ok(Err(_)) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Some(pending_delete) = maybe_cleanup_pending(
                        &mut pending_rename,
                        &vault_root,
                        &mut path_kind_cache,
                    ) {
                        let skip_search = expected_mutations.consume_matching(&pending_delete);
                        if let Some(search_state) = &search_state {
                            search_state.note_watcher_event(
                                &pending_delete,
                                if skip_search {
                                    "deduped-app-mutation"
                                } else {
                                    "external-watch"
                                },
                                skip_search,
                            );
                        }
                        if let Some(search_state) = &search_state
                            && !skip_search
                        {
                            handle_search_event(search_state, &pending_delete, &mut storm_state);
                        }
                        let _ = app_handle.emit("vault:file-changed", pending_delete);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Ok(stop_tx)
}

fn handle_search_event(
    search_state: &SearchState,
    event: &FileChangeEvent,
    storm_state: &mut SearchStormState,
) {
    if storm_state.window_started_at.elapsed() >= Duration::from_secs(1) {
        storm_state.window_started_at = Instant::now();
        storm_state.modify_create_count = 0;
    }

    if matches!(event.kind.as_str(), "create" | "modify")
        && !event.is_dir
        && is_markdown_path(&event.path)
    {
        storm_state.modify_create_count += 1;
        if storm_state.modify_create_count > 100 {
            let _ = search_state.request_rebuild_with_reason("watcher-storm");
            return;
        }
    }

    let _ = search_state.handle_watcher_event(event);
}

pub fn stop_watching(stop_tx: Sender<()>) -> Result<(), String> {
    stop_tx
        .send(())
        .map_err(|e| format!("Failed to stop watcher: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, EventAttributes, ModifyKind, RemoveKind};

    #[test]
    fn test_map_create_event() {
        let root = PathBuf::from("/tmp/vault");
        let event = Event {
            kind: EventKind::Create(CreateKind::File),
            paths: vec![root.join("notes/a.md")],
            attrs: EventAttributes::new(),
        };
        let mut pending = None;
        let mut cache = PathKindCache::new();
        let mapped = map_event(event, &root, &mut pending, &mut cache).unwrap();
        assert_eq!(mapped.kind, "create");
        assert_eq!(mapped.path, "notes/a.md");
        assert_eq!(cache.get(&root.join("notes/a.md")), Some(&false));
    }

    #[test]
    fn test_map_modify_event() {
        let root = PathBuf::from("/tmp/vault");
        let event = Event {
            kind: EventKind::Modify(ModifyKind::Any),
            paths: vec![root.join("notes/a.md")],
            attrs: EventAttributes::new(),
        };
        let mut pending = None;
        let mut cache = PathKindCache::new();
        cache.insert(root.join("notes/a.md"), false);
        let mapped = map_event(event, &root, &mut pending, &mut cache).unwrap();
        assert_eq!(mapped.kind, "modify");
    }

    #[test]
    fn test_pending_rename_cleanup_emits_directory_delete() {
        let root = PathBuf::from("/tmp/vault");
        let path = root.join("notes/archive");
        let mut pending = Some(PendingRename {
            path: path.clone(),
            is_dir: true,
            at: Instant::now() - Duration::from_millis(PENDING_RENAME_TIMEOUT_MS + 10),
        });
        let mut cache = PathKindCache::new();
        cache.insert(path.clone(), true);
        cache.insert(path.join("note.md"), false);

        let mapped = maybe_cleanup_pending(&mut pending, &root, &mut cache).unwrap();

        assert_eq!(mapped.kind, "delete");
        assert_eq!(mapped.path, "notes/archive");
        assert!(mapped.is_dir);
        assert!(pending.is_none());
        assert!(!cache.contains_key(&path));
        assert!(!cache.contains_key(&path.join("note.md")));
    }

    #[test]
    fn test_remove_any_uses_cached_directory_kind() {
        let root = PathBuf::from("/tmp/vault");
        let path = root.join("notes/archive");
        let event = Event {
            kind: EventKind::Remove(RemoveKind::Any),
            paths: vec![path.clone()],
            attrs: EventAttributes::new(),
        };
        let mut pending = None;
        let mut cache = PathKindCache::new();
        cache.insert(path.clone(), true);
        cache.insert(path.join("nested.md"), false);

        let mapped = map_event(event, &root, &mut pending, &mut cache).unwrap();

        assert_eq!(mapped.kind, "delete");
        assert!(mapped.is_dir);
        assert!(!cache.contains_key(&path));
        assert!(!cache.contains_key(&path.join("nested.md")));
    }

    #[test]
    fn test_directory_rename_updates_cache() {
        let root = PathBuf::from("/tmp/vault");
        let old_path = root.join("notes/archive");
        let new_path = root.join("notes/renamed");
        let event = Event {
            kind: EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            paths: vec![old_path.clone(), new_path.clone()],
            attrs: EventAttributes::new(),
        };
        let mut pending = None;
        let mut cache = PathKindCache::new();
        cache.insert(old_path.clone(), true);
        cache.insert(old_path.join("nested.md"), false);

        let mapped = map_event(event, &root, &mut pending, &mut cache).unwrap();

        assert_eq!(mapped.kind, "rename");
        assert_eq!(mapped.old_path.as_deref(), Some("notes/archive"));
        assert_eq!(mapped.path, "notes/renamed");
        assert!(mapped.is_dir);
        assert!(!cache.contains_key(&old_path));
        assert!(!cache.contains_key(&old_path.join("nested.md")));
        assert_eq!(cache.get(&new_path), Some(&true));
        assert_eq!(cache.get(&new_path.join("nested.md")), Some(&false));
    }

    #[test]
    fn test_rename_any_with_two_paths_maps_to_rename() {
        let root = PathBuf::from("/tmp/vault");
        let old_path = root.join("notes/a.md");
        let new_path = root.join("notes/b.md");
        let event = Event {
            kind: EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            paths: vec![old_path.clone(), new_path.clone()],
            attrs: EventAttributes::new(),
        };
        let mut pending = None;
        let mut cache = PathKindCache::new();
        cache.insert(old_path.clone(), false);

        let mapped = map_event(event, &root, &mut pending, &mut cache).unwrap();

        assert_eq!(mapped.kind, "rename");
        assert_eq!(mapped.old_path.as_deref(), Some("notes/a.md"));
        assert_eq!(mapped.path, "notes/b.md");
        assert!(!mapped.is_dir);
        assert!(!cache.contains_key(&old_path));
        assert_eq!(cache.get(&new_path), Some(&false));
    }

    #[test]
    fn test_rename_any_with_single_path_still_triggers_refreshable_modify() {
        let root = PathBuf::from("/tmp/vault");
        let path = root.join("notes/renamed.md");
        let event = Event {
            kind: EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            paths: vec![path.clone()],
            attrs: EventAttributes::new(),
        };
        let mut pending = None;
        let mut cache = PathKindCache::new();
        cache.insert(path.clone(), false);

        let mapped = map_event(event, &root, &mut pending, &mut cache).unwrap();

        assert_eq!(mapped.kind, "modify");
        assert_eq!(mapped.path, "notes/renamed.md");
        assert!(!mapped.is_dir);
    }

    #[test]
    fn test_rename_any_with_single_case_changed_path_uses_cache_as_rename() {
        let root = PathBuf::from("/tmp/vault");
        let old_path = root.join("notes/BAse.md");
        let new_path = root.join("notes/Base.md");
        let event = Event {
            kind: EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            paths: vec![new_path.clone()],
            attrs: EventAttributes::new(),
        };
        let mut pending = None;
        let mut cache = PathKindCache::new();
        cache.insert(old_path.clone(), false);

        let mapped = map_event(event, &root, &mut pending, &mut cache).unwrap();

        assert_eq!(mapped.kind, "rename");
        assert_eq!(mapped.old_path.as_deref(), Some("notes/BAse.md"));
        assert_eq!(mapped.path, "notes/Base.md");
        assert!(!mapped.is_dir);
        assert!(!cache.contains_key(&old_path));
        assert_eq!(cache.get(&new_path), Some(&false));
    }

    #[test]
    fn expected_mutation_ledger_consumes_matching_write_once() {
        let ledger = ExpectedMutationLedger::default();
        ledger.record_write("notes/a.md", false);
        let event = FileChangeEvent {
            kind: "modify".to_string(),
            path: "notes/a.md".to_string(),
            is_dir: false,
            old_path: None,
        };

        assert!(ledger.consume_matching(&event));
        assert!(!ledger.consume_matching(&event));
    }

    #[test]
    fn expected_mutation_ledger_does_not_consume_external_write() {
        let ledger = ExpectedMutationLedger::default();
        let event = FileChangeEvent {
            kind: "modify".to_string(),
            path: "notes/a.md".to_string(),
            is_dir: false,
            old_path: None,
        };

        assert!(!ledger.consume_matching(&event));
    }

    #[test]
    fn expected_mutation_ledger_matches_rename_by_old_and_new_path() {
        let ledger = ExpectedMutationLedger::default();
        ledger.record_rename("notes/old.md", "notes/new.md", false);
        let event = FileChangeEvent {
            kind: "rename".to_string(),
            path: "notes/new.md".to_string(),
            is_dir: false,
            old_path: Some("notes/old.md".to_string()),
        };

        assert!(ledger.consume_matching(&event));
    }

    #[test]
    fn expected_mutation_ledger_matches_directory_write() {
        let ledger = ExpectedMutationLedger::default();
        ledger.record_write("notes/archive", true);
        let event = FileChangeEvent {
            kind: "create".to_string(),
            path: "notes/archive".to_string(),
            is_dir: true,
            old_path: None,
        };

        assert!(ledger.consume_matching(&event));
    }

    #[test]
    fn expected_mutation_ledger_matches_directory_delete() {
        let ledger = ExpectedMutationLedger::default();
        ledger.record_delete("notes/archive", true);
        let event = FileChangeEvent {
            kind: "delete".to_string(),
            path: "notes/archive".to_string(),
            is_dir: true,
            old_path: None,
        };

        assert!(ledger.consume_matching(&event));
    }

    #[test]
    fn expected_mutation_ledger_matches_directory_rename() {
        let ledger = ExpectedMutationLedger::default();
        ledger.record_rename("notes/old", "notes/new", true);
        let event = FileChangeEvent {
            kind: "rename".to_string(),
            path: "notes/new".to_string(),
            is_dir: true,
            old_path: Some("notes/old".to_string()),
        };

        assert!(ledger.consume_matching(&event));
    }

    #[test]
    fn expected_mutation_ledger_does_not_match_wrong_path_kind() {
        let ledger = ExpectedMutationLedger::default();
        ledger.record_write("notes/archive", true);
        let event = FileChangeEvent {
            kind: "create".to_string(),
            path: "notes/archive".to_string(),
            is_dir: false,
            old_path: None,
        };

        assert!(!ledger.consume_matching(&event));
    }

    #[test]
    fn expected_mutation_ledger_can_cancel_pending_mutation() {
        let ledger = ExpectedMutationLedger::default();
        let token = ledger.record_write("notes/a.md", false);
        ledger.cancel(token);
        let event = FileChangeEvent {
            kind: "modify".to_string(),
            path: "notes/a.md".to_string(),
            is_dir: false,
            old_path: None,
        };

        assert!(!ledger.consume_matching(&event));
    }
}
