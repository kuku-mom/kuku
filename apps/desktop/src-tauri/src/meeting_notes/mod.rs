//! Native half of the optional meeting-notes built-in plugin.
mod audio;
mod audio_capture;
pub mod controller;
pub mod journal;
pub mod meeting_detection;
mod recovery;
mod resources;
mod worker_protocol;

use controller::{MeetingController, MeetingStateSnapshot};
use journal::{DocumentCheckpoint, MeetingJournal, MeetingTarget};
use meeting_detection::MeetingDetectionController;
use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{Emitter, Manager};

static ENABLED: AtomicBool = AtomicBool::new(false);
static PENDING_EXIT: Mutex<Option<i32>> = Mutex::new(None);
static ALLOW_EXIT: AtomicBool = AtomicBool::new(false);

fn data_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    Ok(crate::variant::data_root(&home).join("plugins/meeting-notes"))
}

fn ensure_enabled() -> Result<(), String> {
    if ENABLED.load(Ordering::Acquire) {
        Ok(())
    } else {
        Err("Meeting notes plugin is disabled".into())
    }
}

pub fn setup(app: &tauri::AppHandle) {
    app.manage(MeetingController::new(app.clone()));
    app.manage(MeetingDetectionController::new(app.clone()));
}

pub fn on_exit(app: &tauri::AppHandle, api: &tauri::ExitRequestApi, code: Option<i32>) {
    let phase = app.state::<MeetingController>().status().phase;
    if !ALLOW_EXIT.load(Ordering::Acquire) && !matches!(phase.as_str(), "idle" | "error") {
        api.prevent_exit();
        if let Ok(mut pending) = PENDING_EXIT.lock() {
            *pending = Some(code.unwrap_or(0));
        }
        let _ = app.emit("meeting-notes://exit-requested", ());
    }
}

#[tauri::command]
pub fn meeting_notes_complete_exit(app: tauri::AppHandle, proceed: bool) -> Result<(), String> {
    let code = PENDING_EXIT.lock().map_err(|_| "Exit lock failed")?.take();
    if proceed {
        let phase = app.state::<MeetingController>().status().phase;
        if !matches!(phase.as_str(), "idle" | "error") {
            return Err("Finish and save the meeting first".into());
        }
        if let Some(code) = code {
            ALLOW_EXIT.store(true, Ordering::Release);
            app.exit(code);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn meeting_notes_available() -> bool {
    audio_capture::is_available()
}

#[tauri::command]
pub fn meeting_notes_enable(
    enabled: bool,
    detection: bool,
    controller: tauri::State<'_, MeetingController>,
    detector: tauri::State<'_, MeetingDetectionController>,
) -> Result<(), String> {
    if !enabled {
        controller.cancel(false)?;
    }
    ENABLED.store(enabled, Ordering::Release);
    detector.set_enabled(enabled && detection);
    Ok(())
}

async fn validate_target(
    app: &tauri::AppHandle,
    target: &MeetingTarget,
) -> Result<PathBuf, String> {
    let root = crate::vault::get_vault_root(&app.state::<crate::vault::VaultState>())?;
    if root != PathBuf::from(&target.vault_root) {
        return Err("The meeting belongs to a different vault".into());
    }
    if !target.file_path.to_lowercase().ends_with(".md") {
        return Err("Open a Markdown document first".into());
    }
    let path = crate::vault::resolve_vault_path(&root, &target.file_path)?;
    crate::vault::assert_no_symlink_within_vault(&root, &path).await?;
    Ok(path)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn meeting_notes_start(
    app: tauri::AppHandle,
    session_id: String,
    target: MeetingTarget,
    checkpoint: DocumentCheckpoint,
    microphone_only: bool,
    system_only: bool,
    capture_bundle_id: Option<String>,
    capture_window_id: Option<u32>,
) -> Result<MeetingStateSnapshot, String> {
    ensure_enabled()?;
    let path = validate_target(&app, &target).await?;
    let disk = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| e.to_string())?;
    if crate::vault::checksum::compute_checksum(&disk) != checkpoint.expected_checksum {
        return Err("Document changed before recording started".into());
    }
    app.state::<MeetingController>().start(
        session_id,
        target,
        checkpoint,
        microphone_only,
        system_only,
        capture_bundle_id,
        capture_window_id,
    )
}

#[tauri::command]
pub fn meeting_notes_stop(
    session_id: String,
    controller: tauri::State<'_, MeetingController>,
) -> Result<MeetingStateSnapshot, String> {
    if controller.status().session_id.as_deref() != Some(&session_id) {
        return Err("Stale meeting session".into());
    }
    controller.stop()
}

#[tauri::command]
pub fn meeting_notes_cancel(
    session_id: String,
    discard: bool,
    controller: tauri::State<'_, MeetingController>,
) -> Result<MeetingStateSnapshot, String> {
    if controller.status().session_id.as_deref() != Some(&session_id) {
        return Err("Stale meeting session".into());
    }
    controller.cancel(discard)
}

#[tauri::command]
pub fn meeting_notes_checkpoint(
    session_id: String,
    checkpoint: DocumentCheckpoint,
    controller: tauri::State<'_, MeetingController>,
) -> Result<(), String> {
    controller.journal.checkpoint(&session_id, checkpoint)
}

#[tauri::command]
pub fn meeting_notes_recoveries(
    controller: tauri::State<'_, MeetingController>,
) -> Result<Vec<MeetingJournal>, String> {
    controller.journal.list()
}

#[tauri::command]
pub async fn meeting_notes_ack(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let controller = app.state::<MeetingController>();
    let entry = controller.journal.get(&session_id)?;
    if !entry.checkpoint.finalized {
        return Err("Meeting document has not been finalized".into());
    }
    let path = validate_target(&app, &entry.target).await?;
    let disk = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| e.to_string())?;
    if disk != entry.checkpoint.content {
        return Err("Meeting document has not been saved, or changed externally".into());
    }
    controller.acknowledge(&session_id)
}

#[tauri::command]
pub fn meeting_notes_discard_recovery(
    session_id: String,
    controller: tauri::State<'_, MeetingController>,
) -> Result<(), String> {
    if controller.status().session_id.as_deref() == Some(&session_id)
        && !matches!(controller.status().phase.as_str(), "idle" | "error")
    {
        return Err("Finish the meeting first".into());
    }
    controller.journal.remove(&session_id)
}
