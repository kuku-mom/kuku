use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::time::{Duration, Instant};

use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::models::FileChangeEvent;
use crate::vault::{should_ignore_path, to_relative_path};

struct PendingRename {
    path: PathBuf,
    at: Instant,
}

fn is_ignored(root: &Path, path: &Path) -> bool {
    if let Ok(rel) = path.strip_prefix(root) {
        return should_ignore_path(rel);
    }
    false
}

fn maybe_cleanup_pending(
    pending: &mut Option<PendingRename>,
    app: &AppHandle,
    root: &Path,
    last_emit: &mut Instant,
    debounce: Duration,
) {
    if let Some(p) = pending {
        if p.at.elapsed() > Duration::from_millis(600) {
            let rel = to_relative_path(root, &p.path);
            let event = FileChangeEvent {
                kind: "delete".to_string(),
                path: rel,
                is_dir: p.path.is_dir(),
                old_path: None,
            };
            if last_emit.elapsed() >= debounce {
                let _ = app.emit("vault:file-changed", event);
                *last_emit = Instant::now();
            }
            *pending = None;
        }
    }
}

fn map_event(
    event: Event,
    root: &Path,
    pending: &mut Option<PendingRename>,
) -> Option<FileChangeEvent> {
    if event.paths.is_empty() {
        return None;
    }

    match event.kind {
        EventKind::Create(CreateKind::File) | EventKind::Create(CreateKind::Any) => {
            let path = &event.paths[0];
            if is_ignored(root, path) {
                return None;
            }
            Some(FileChangeEvent {
                kind: "create".to_string(),
                path: to_relative_path(root, path),
                is_dir: false,
                old_path: None,
            })
        }
        EventKind::Create(CreateKind::Folder) => {
            let path = &event.paths[0];
            if is_ignored(root, path) {
                return None;
            }
            Some(FileChangeEvent {
                kind: "create".to_string(),
                path: to_relative_path(root, path),
                is_dir: true,
                old_path: None,
            })
        }
        EventKind::Modify(ModifyKind::Data(_)) | EventKind::Modify(ModifyKind::Any) => {
            let path = &event.paths[0];
            if is_ignored(root, path) {
                return None;
            }
            Some(FileChangeEvent {
                kind: "modify".to_string(),
                path: to_relative_path(root, path),
                is_dir: path.is_dir(),
                old_path: None,
            })
        }
        EventKind::Remove(RemoveKind::File) | EventKind::Remove(RemoveKind::Any) => {
            let path = &event.paths[0];
            if is_ignored(root, path) {
                return None;
            }
            Some(FileChangeEvent {
                kind: "delete".to_string(),
                path: to_relative_path(root, path),
                is_dir: false,
                old_path: None,
            })
        }
        EventKind::Remove(RemoveKind::Folder) => {
            let path = &event.paths[0];
            if is_ignored(root, path) {
                return None;
            }
            Some(FileChangeEvent {
                kind: "delete".to_string(),
                path: to_relative_path(root, path),
                is_dir: true,
                old_path: None,
            })
        }
        EventKind::Modify(ModifyKind::Name(rename)) => match rename {
            RenameMode::Both if event.paths.len() >= 2 => {
                let old_path = &event.paths[0];
                let new_path = &event.paths[1];
                if is_ignored(root, old_path) || is_ignored(root, new_path) {
                    return None;
                }
                Some(FileChangeEvent {
                    kind: "rename".to_string(),
                    path: to_relative_path(root, new_path),
                    is_dir: new_path.is_dir(),
                    old_path: Some(to_relative_path(root, old_path)),
                })
            }
            RenameMode::From => {
                let old_path = &event.paths[0];
                if is_ignored(root, old_path) {
                    return None;
                }
                *pending = Some(PendingRename { path: old_path.clone(), at: Instant::now() });
                None
            }
            RenameMode::To => {
                let new_path = &event.paths[0];
                if is_ignored(root, new_path) {
                    return None;
                }
                if let Some(prev) = pending.take() {
                    if prev.at.elapsed() <= Duration::from_millis(600) {
                        return Some(FileChangeEvent {
                            kind: "rename".to_string(),
                            path: to_relative_path(root, new_path),
                            is_dir: new_path.is_dir(),
                            old_path: Some(to_relative_path(root, &prev.path)),
                        });
                    }
                }
                Some(FileChangeEvent {
                    kind: "create".to_string(),
                    path: to_relative_path(root, new_path),
                    is_dir: new_path.is_dir(),
                    old_path: None,
                })
            }
            _ => None,
        },
        _ => None,
    }
}

pub fn start_watching(app: AppHandle, vault_root: PathBuf) -> Result<Sender<()>, String> {
    let (event_tx, event_rx) = mpsc::channel::<notify::Result<Event>>();
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
        let debounce = Duration::from_millis(300);
        let mut last_emit = Instant::now().checked_sub(debounce).unwrap_or_else(Instant::now);
        let mut pending_rename: Option<PendingRename> = None;

        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }

            match event_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(event)) => {
                    maybe_cleanup_pending(
                        &mut pending_rename,
                        &app_handle,
                        &vault_root,
                        &mut last_emit,
                        debounce,
                    );

                    if let Some(mapped) = map_event(event, &vault_root, &mut pending_rename) {
                        if last_emit.elapsed() >= debounce || mapped.kind == "rename" {
                            let _ = app_handle.emit("vault:file-changed", mapped);
                            last_emit = Instant::now();
                        }
                    }
                }
                Ok(Err(_)) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    maybe_cleanup_pending(
                        &mut pending_rename,
                        &app_handle,
                        &vault_root,
                        &mut last_emit,
                        debounce,
                    );
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Ok(stop_tx)
}

pub fn stop_watching(stop_tx: Sender<()>) -> Result<(), String> {
    stop_tx.send(()).map_err(|e| format!("Failed to stop watcher: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind};

    #[test]
    fn test_map_create_event() {
        let root = PathBuf::from("/tmp/vault");
        let event = Event {
            kind: EventKind::Create(CreateKind::File),
            paths: vec![root.join("notes/a.md")],
            attrs: notify::event::EventAttributes::new(),
        };
        let mut pending = None;
        let mapped = map_event(event, &root, &mut pending).unwrap();
        assert_eq!(mapped.kind, "create");
        assert_eq!(mapped.path, "notes/a.md");
    }

    #[test]
    fn test_map_modify_event() {
        let root = PathBuf::from("/tmp/vault");
        let event = Event {
            kind: EventKind::Modify(ModifyKind::Any),
            paths: vec![root.join("notes/a.md")],
            attrs: notify::event::EventAttributes::new(),
        };
        let mut pending = None;
        let mapped = map_event(event, &root, &mut pending).unwrap();
        assert_eq!(mapped.kind, "modify");
    }
}
