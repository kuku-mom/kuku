//! Inspection and explicit removal of local transcription resources.
//!
//! The UI uses this before the first meeting so it can disclose the real
//! download and disk cost instead of beginning a multi-gigabyte setup without
//! context.

use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

const RUNTIME_BYTES: u64 = 500_000_000;
const ASR_MODEL_BYTES: u64 = 1_020_000_000;
const DIAR_MODEL_BYTES: u64 = 240_000_000;
const DOWNLOAD_HEADROOM_BYTES: u64 = 500_000_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingResourceStatus {
    pub ready: bool,
    pub runtime_ready: bool,
    pub transcription_model_ready: bool,
    pub speaker_model_ready: bool,
    pub estimated_download_bytes: u64,
    pub estimated_installed_bytes: u64,
    pub available_disk_bytes: Option<u64>,
    pub disk_space_sufficient: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingResourceRemoval {
    pub removed_bytes: u64,
}

pub(crate) fn inspect(resource_dir: &Path, app_data: &Path) -> MeetingResourceStatus {
    let runtime_ready = runtime_candidates(resource_dir, app_data)
        .iter()
        .any(|path| {
            path.join("bin/python3").exists()
                && (path != &app_data.join("ASR Runtime")
                    || path.join(".kuku-meeting-ready").exists())
        });
    let models = app_data.join("Models");
    let transcription_model_ready = model_ready(&models.join("qwen3-asr-0.6b-8bit"));
    let speaker_model_ready = model_ready(&models.join("sortformer-v2.1-fp16"));

    let mut estimated_download_bytes = 0;
    if !runtime_ready {
        estimated_download_bytes += RUNTIME_BYTES;
    }
    if !transcription_model_ready {
        estimated_download_bytes += ASR_MODEL_BYTES;
    }
    if !speaker_model_ready {
        estimated_download_bytes += DIAR_MODEL_BYTES;
    }

    let available_disk_bytes =
        nearest_existing_ancestor(app_data).and_then(|path| fs2::available_space(path).ok());
    let required_available_bytes = estimated_download_bytes.saturating_add(DOWNLOAD_HEADROOM_BYTES);
    let disk_space_sufficient = available_disk_bytes
        .map(|available| available >= required_available_bytes)
        .unwrap_or(true);

    MeetingResourceStatus {
        ready: runtime_ready && transcription_model_ready && speaker_model_ready,
        runtime_ready,
        transcription_model_ready,
        speaker_model_ready,
        estimated_download_bytes,
        estimated_installed_bytes: RUNTIME_BYTES + ASR_MODEL_BYTES + DIAR_MODEL_BYTES,
        available_disk_bytes,
        disk_space_sufficient,
    }
}

fn nearest_existing_ancestor(path: &Path) -> Option<&Path> {
    path.ancestors().find(|candidate| candidate.exists())
}

fn runtime_candidates(resource_dir: &Path, app_data: &Path) -> [PathBuf; 3] {
    [
        resource_dir.join("meeting_notes/asr-runtime"),
        resource_dir.join("resources/meeting_notes/asr-runtime"),
        app_data.join("ASR Runtime"),
    ]
}

fn model_ready(path: &Path) -> bool {
    if !path.join("config.json").exists() {
        return false;
    }
    std::fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| {
            entry.path().extension().and_then(|value| value.to_str()) == Some("safetensors")
        })
}

pub(crate) fn remove_downloaded(app_data: &Path) -> Result<MeetingResourceRemoval, String> {
    let targets = [
        app_data.join("Models"),
        app_data.join("ASR Runtime"),
        app_data.join("ASR Tools"),
        app_data.join("Meeting Recovery"),
    ];
    let removed_bytes = targets.iter().map(|path| directory_bytes(path)).sum();
    for target in targets {
        if !target.exists() {
            continue;
        }
        if target.is_dir() {
            fs::remove_dir_all(&target)
        } else {
            fs::remove_file(&target)
        }
        .map_err(|error| format!("Could not remove {}: {error}", target.display()))?;
    }
    Ok(MeetingResourceRemoval { removed_bytes })
}

fn directory_bytes(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return 0;
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return metadata.len();
    }
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| directory_bytes(&entry.path()))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("kuku-meeting-resource-status-{}", Uuid::new_v4()))
    }

    fn create_ready_model(path: &Path) {
        std::fs::create_dir_all(path).expect("create model directory");
        std::fs::write(path.join("config.json"), b"{}").expect("write config");
        std::fs::write(path.join("model.safetensors"), b"weights").expect("write weights");
    }

    #[test]
    fn reports_the_full_first_use_cost_when_nothing_is_installed() {
        let root = test_root();
        let status = inspect(&root.join("resources"), &root.join("data"));
        assert!(!status.ready);
        assert_eq!(
            status.estimated_download_bytes,
            RUNTIME_BYTES + ASR_MODEL_BYTES + DIAR_MODEL_BYTES
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recognizes_bundled_runtime_and_both_complete_models() {
        let root = test_root();
        let resources = root.join("resources");
        let data = root.join("data");
        std::fs::create_dir_all(resources.join("meeting_notes/asr-runtime/bin"))
            .expect("create runtime");
        std::fs::write(
            resources.join("meeting_notes/asr-runtime/bin/python3"),
            b"python",
        )
        .expect("write runtime");
        create_ready_model(&data.join("Models/qwen3-asr-0.6b-8bit"));
        create_ready_model(&data.join("Models/sortformer-v2.1-fp16"));

        let status = inspect(&resources, &data);
        assert!(status.ready);
        assert_eq!(status.estimated_download_bytes, 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn removes_only_downloaded_transcription_data() {
        let root = test_root();
        let data = root.join("data");
        std::fs::create_dir_all(data.join("Models/model")).expect("create models");
        std::fs::create_dir_all(data.join("ASR Runtime/bin")).expect("create runtime");
        std::fs::create_dir_all(data.join("ASR Tools")).expect("create tools");
        std::fs::create_dir_all(data.join("Meeting Recovery")).expect("create recovery");
        std::fs::write(data.join("Models/model/weights"), b"1234").expect("write model");
        std::fs::write(data.join("ASR Runtime/bin/python3"), b"12").expect("write runtime");
        std::fs::write(data.join("ASR Tools/uv"), b"1").expect("write tool");
        std::fs::write(data.join("Meeting Recovery/session.wav"), b"123").expect("write audio");
        std::fs::write(data.join("keep.txt"), b"document state").expect("write unrelated data");

        let removal = remove_downloaded(&data).expect("remove downloaded data");

        assert_eq!(removal.removed_bytes, 10);
        assert!(!data.join("Models").exists());
        assert!(!data.join("ASR Runtime").exists());
        assert!(!data.join("ASR Tools").exists());
        assert!(!data.join("Meeting Recovery").exists());
        assert!(data.join("keep.txt").exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
