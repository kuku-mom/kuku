use super::audio::{
    AUDIO_FRAME_SAMPLES, MAX_MEETING_SAMPLES, SAMPLE_RATE, StreamingResampler, TimestampMixer,
    bounded_audio_take, required_microphone_stalled,
};
use super::audio_capture::{self, AudioSource, CaptureEvent};
use super::recovery::repair_recovery_wav_headers;
use super::resources::{MeetingResourceRemoval, MeetingResourceStatus};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Seek, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

use super::worker_protocol::{
    WorkerInput, WorkerQueueMessage, append_worker_pcm, f32_bytes, worker_feeder_loop,
    write_worker_frame,
};

use super::{journal, resources};

fn diagnostics_enabled() -> bool {
    cfg!(debug_assertions)
        || std::env::var("KUKU_MEETING_ASR_DIAGNOSTICS")
            .ok()
            .as_deref()
            == Some("1")
}

const RUNTIME_IMPORT_PROBE: &str =
    "import huggingface_hub, mlx.core, mlx_audio.vad, mlx_qwen3_asr, numpy, tqdm";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RuntimeProbeResult {
    Ready,
    Failed,
    Canceled,
}

fn probe_runtime_imports(python: &Path, should_continue: impl Fn() -> bool) -> RuntimeProbeResult {
    let Ok(mut child) = Command::new(python)
        .arg("-c")
        .arg(RUNTIME_IMPORT_PROBE)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return RuntimeProbeResult::Failed;
    };
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if !should_continue() {
            let _ = child.kill();
            let _ = child.wait();
            return RuntimeProbeResult::Canceled;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    RuntimeProbeResult::Ready
                } else {
                    RuntimeProbeResult::Failed
                };
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return RuntimeProbeResult::Failed;
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return RuntimeProbeResult::Failed;
            }
        }
    }
}

fn worker_finish_timeout(pcm_bytes: u64) -> Duration {
    const BASE_SECONDS: u64 = 120;
    let bytes_per_second = SAMPLE_RATE as u64 * std::mem::size_of::<f32>() as u64;
    let audio_seconds = pcm_bytes.saturating_add(bytes_per_second - 1) / bytes_per_second;
    Duration::from_secs(BASE_SECONDS.saturating_add(audio_seconds / 2))
}

fn append_wav_samples<W: Write + Seek>(
    writer: &mut hound::WavWriter<W>,
    samples: &[f32],
) -> Result<(), String> {
    for sample in samples {
        let integer = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer
            .write_sample(integer)
            .map_err(|error| format!("Could not write meeting audio: {error}"))?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AudioLoopCommand {
    Finish,
    Cancel,
}

struct AudioLoopCompletion(Option<Sender<()>>);

impl Drop for AudioLoopCompletion {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStateSnapshot {
    pub phase: String,
    pub session_id: Option<String>,
    pub progress: Option<f32>,
    pub message: Option<String>,
    pub started_at_ms: Option<i64>,
    pub error_code: Option<String>,
    pub microphone_only: bool,
    pub system_only: bool,
}

impl Default for MeetingStateSnapshot {
    fn default() -> Self {
        Self {
            phase: "idle".into(),
            session_id: None,
            progress: None,
            message: None,
            started_at_ms: None,
            error_code: None,
            microphone_only: false,
            system_only: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub speaker: Option<u8>,
    pub text: String,
    pub start: Option<f64>,
    pub end: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPayload {
    pub session_id: String,
    pub kind: String,
    pub stable_text: String,
    pub unstable_text: String,
    pub speaker_id: Option<u8>,
    pub segments: Vec<TranscriptSegment>,
    pub speaker_limit_warning: bool,
}

struct ActiveSession {
    id: String,
    audio_path: PathBuf,
    pcm_path: PathBuf,
    worker_stdin: WorkerInput,
    worker_generation: Arc<AtomicU64>,
    worker_shutdown: Arc<AtomicBool>,
    worker_final_received: Arc<AtomicBool>,
    pending_worker_stdin: Option<ChildStdin>,
    worker_child: Option<Arc<Mutex<Child>>>,
    audio_stop: Option<Sender<AudioLoopCommand>>,
    audio_done: Option<Receiver<()>>,
    worker_restarts: u8,
    capture_bundle_id: Option<String>,
    capture_window_id: Option<u32>,
    capture_sender_generation: Option<u64>,
}

struct AudioLoopContext {
    session_id: String,
    capture_rx: Receiver<CaptureEvent>,
    stop_rx: Receiver<AudioLoopCommand>,
    stdin: WorkerInput,
    worker_generation: Arc<AtomicU64>,
    worker_shutdown: Arc<AtomicBool>,
    worker_final_received: Arc<AtomicBool>,
    capture_sender_generation: Option<u64>,
    audio_path: PathBuf,
    pcm_path: PathBuf,
    microphone_only: bool,
    system_only: bool,
    done_tx: Sender<()>,
}

struct MeetingInner {
    state: MeetingStateSnapshot,
    active: Option<ActiveSession>,
}

#[derive(Clone)]
pub struct MeetingController {
    app: AppHandle,
    inner: Arc<Mutex<MeetingInner>>,
    pub journal: Arc<journal::JournalStore>,
}

impl MeetingController {
    pub fn new(app: AppHandle) -> Self {
        if let Ok(app_data) = super::data_dir() {
            repair_recovery_wav_headers(&app_data.join("Meeting Recovery"));
        }
        Self {
            app,
            journal: Arc::new(journal::JournalStore::new(
                super::data_dir().map(|p| p.join("Meeting Recovery")),
            )),
            inner: Arc::new(Mutex::new(MeetingInner {
                state: MeetingStateSnapshot::default(),
                active: None,
            })),
        }
    }

    pub fn status(&self) -> MeetingStateSnapshot {
        self.inner
            .lock()
            .map(|inner| inner.state.clone())
            .unwrap_or_default()
    }

    pub fn resources(&self) -> Result<MeetingResourceStatus, String> {
        let resource_dir = self
            .app
            .path()
            .resource_dir()
            .map_err(|error| format!("Could not locate the app resource folder: {error}"))?;
        let app_data = super::data_dir()?;
        Ok(resources::inspect(&resource_dir, &app_data))
    }

    pub fn remove_local_data(&self) -> Result<MeetingResourceRemoval, String> {
        let active = self
            .inner
            .lock()
            .map_err(|_| "Could not inspect the meeting state".to_string())?
            .active
            .is_some();
        if active || self.status().phase == "saving" {
            return Err("Finish the current meeting before removing transcription data".into());
        }
        let app_data = super::data_dir()?;
        resources::remove_downloaded(&app_data)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        session_id: String,
        target: journal::MeetingTarget,
        checkpoint: journal::DocumentCheckpoint,
        microphone_only: bool,
        system_only: bool,
        capture_bundle_id: Option<String>,
        capture_window_id: Option<u32>,
    ) -> Result<MeetingStateSnapshot, String> {
        if !audio_capture::is_available() {
            return Err(
                "Meeting transcription requires an Apple Silicon Mac running macOS 15 or later"
                    .into(),
            );
        }
        if microphone_only && system_only {
            return Err(
                "Microphone-only and system-audio-only modes cannot be enabled together".into(),
            );
        }
        super::ensure_enabled()?;
        journal::validate_id(&session_id)?;
        let app_data = super::data_dir()?;
        let recovery_dir = app_data.join("Meeting Recovery");
        fs::create_dir_all(&recovery_dir)
            .map_err(|error| format!("Could not create the recovery folder: {error}"))?;
        let audio_path = recovery_dir.join(format!("{session_id}.wav"));
        let pcm_path = recovery_dir.join(format!("{session_id}.pcm"));

        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Could not lock meeting state")?;
            if !matches!(inner.state.phase.as_str(), "idle" | "error") {
                return Err("Meeting transcription is already running".into());
            }
            self.journal.create(&session_id, target, checkpoint)?;
            inner.state = MeetingStateSnapshot {
                phase: "preparing".into(),
                session_id: Some(session_id.clone()),
                progress: None,
                message: Some("Preparing the local transcription engine".into()),
                started_at_ms: None,
                error_code: None,
                microphone_only,
                system_only,
            };
            let capture_bundle_id = capture_bundle_id
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let capture_window_id = capture_bundle_id
                .as_ref()
                .and(capture_window_id.filter(|value| *value != 0));
            inner.active = Some(ActiveSession {
                id: session_id.clone(),
                audio_path,
                pcm_path,
                worker_stdin: Arc::new(Mutex::new(None)),
                worker_generation: Arc::new(AtomicU64::new(0)),
                worker_shutdown: Arc::new(AtomicBool::new(false)),
                worker_final_received: Arc::new(AtomicBool::new(false)),
                pending_worker_stdin: None,
                worker_child: None,
                audio_stop: None,
                audio_done: None,
                worker_restarts: 0,
                capture_bundle_id,
                capture_window_id,
                capture_sender_generation: None,
            });
        }
        self.emit_state();

        let controller = self.clone();
        thread::spawn(move || {
            if let Err(error) = controller.prepare_worker(&session_id) {
                controller.fail_session(&session_id, "worker_prepare", error);
            }
        });
        Ok(self.status())
    }

    pub fn stop(&self) -> Result<MeetingStateSnapshot, String> {
        let stop_sender = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Could not lock meeting state")?;
            if inner.state.phase != "recording" && inner.state.phase != "permission" {
                return Err("No meeting is currently being recorded".into());
            }
            inner.state.phase = "finalizing".into();
            inner.state.message = Some("Organizing the final sentences and speakers".into());
            inner.state.progress = Some(0.0);
            inner
                .active
                .as_ref()
                .and_then(|active| active.audio_stop.clone())
        };
        self.emit_state();
        audio_capture::stop();
        if let Some(sender) = stop_sender {
            let _ = sender.send(AudioLoopCommand::Finish);
        }
        Ok(self.status())
    }

    pub fn cancel(&self, discard: bool) -> Result<MeetingStateSnapshot, String> {
        let session_id = self.status().session_id;
        audio_capture::stop();
        let (stdin, child, stop, done, shutdown, sender_generation, temporary_paths) = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Could not lock meeting state")?;
            let handles = inner.active.as_mut().map(|active| {
                (
                    Some(active.worker_stdin.clone()),
                    active.worker_child.clone(),
                    active.audio_stop.clone(),
                    active.audio_done.take(),
                    Some(active.worker_shutdown.clone()),
                    active.capture_sender_generation,
                    Some((active.audio_path.clone(), active.pcm_path.clone())),
                )
            });
            inner.state = MeetingStateSnapshot::default();
            inner.active = None;
            handles.unwrap_or((None, None, None, None, None, None, None))
        };
        if let Some(shutdown) = shutdown {
            shutdown.store(true, Ordering::Release);
        }
        if let Some(sender) = stop {
            let _ = sender.send(AudioLoopCommand::Cancel);
        }
        if let Some(done) = done {
            let _ = done.recv_timeout(Duration::from_secs(3));
        }
        if let Some(stdin) = stdin {
            let _ = write_worker_frame(&stdin, 3, &[]);
        }
        if let Some(child) = child
            && let Ok(mut child) = child.lock()
        {
            kill_worker(&mut child);
        }
        if discard {
            if let Some((audio_path, pcm_path)) = temporary_paths {
                let _ = fs::remove_file(audio_path);
                let _ = fs::remove_file(pcm_path);
            }
            if let Some(id) = session_id {
                self.journal.remove(&id)?;
            }
        }
        if let Some(generation) = sender_generation {
            audio_capture::clear_sender_if(generation);
        }
        self.emit_state();
        Ok(self.status())
    }

    fn prepare_worker(&self, expected_session: &str) -> Result<(), String> {
        let python = self.ensure_runtime(expected_session)?;
        if self.status().session_id.as_deref() != Some(expected_session) {
            return Ok(());
        }
        let resource_dir = self
            .app
            .path()
            .resource_dir()
            .map_err(|error| format!("Could not locate the app resource folder: {error}"))?;
        let worker_path = find_worker_script(&resource_dir)?;
        let app_data = super::data_dir()?;
        let model_dir = app_data.join("Models");
        fs::create_dir_all(&model_dir)
            .map_err(|error| format!("Could not create the model folder: {error}"))?;
        let (session_id, audio_path, worker_restarts) = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| "Could not lock meeting state")?;
            let active = inner
                .active
                .as_ref()
                .filter(|active| active.id == expected_session)
                .ok_or("The meeting session was canceled")?;
            (
                active.id.clone(),
                active.audio_path.clone(),
                active.worker_restarts,
            )
        };

        if worker_restarts == 0 {
            self.set_state(
                "downloading",
                Some(0.0),
                Some("Checking local transcription and speaker models"),
                None,
            );
        }

        let mut command = Command::new(python);
        command
            .arg("-u")
            .arg(worker_path)
            .arg("--model-dir")
            .arg(&model_dir)
            .arg("--audio-path")
            .arg(&audio_path)
            .arg("--session-id")
            .arg(&session_id)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env("HF_HOME", model_dir.join(".hf-cache"))
            .env("XDG_CACHE_HOME", app_data.join("ASR Tools/cache"))
            .env("TOKENIZERS_PARALLELISM", "false")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env(
                "KUKU_MEETING_ASR_RECOVERY",
                if worker_restarts > 0 { "1" } else { "0" },
            );
        if std::env::var("KUKU_MEETING_ASR_MOCK").ok().as_deref() == Some("1") {
            command.arg("--mock");
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start the transcription worker: {error}"))?;
        let stdin = child.stdin.take().ok_or("Could not open worker input")?;
        let stdout = child.stdout.take().ok_or("Could not open worker output")?;
        let child = Arc::new(Mutex::new(child));
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Could not lock meeting state")?;
            let Some(active) = inner
                .active
                .as_mut()
                .filter(|active| active.id == expected_session)
            else {
                if let Ok(mut child) = child.lock() {
                    kill_worker(&mut child);
                }
                return Ok(());
            };
            active.pending_worker_stdin = Some(stdin);
            active.worker_child = Some(child);
        }

        let controller = self.clone();
        thread::spawn(move || controller.read_worker(stdout, session_id));
        Ok(())
    }

    fn ensure_runtime(&self, expected_session: &str) -> Result<PathBuf, String> {
        if let Ok(path) = std::env::var("KUKU_MEETING_ASR_PYTHON") {
            let path = PathBuf::from(path);
            if path.exists() {
                return Ok(path);
            }
        }
        if std::env::var("KUKU_MEETING_ASR_MOCK").ok().as_deref() == Some("1") {
            return Ok(PathBuf::from("/usr/bin/python3"));
        }

        let resource_dir = self
            .app
            .path()
            .resource_dir()
            .map_err(|error| format!("Could not locate the app resource folder: {error}"))?;
        for candidate in [
            resource_dir.join("meeting_notes/asr-runtime/bin/python3"),
            resource_dir.join("resources/meeting_notes/asr-runtime/bin/python3"),
        ] {
            if candidate.is_file() {
                match probe_runtime_imports(&candidate, || {
                    self.status().session_id.as_deref() == Some(expected_session)
                }) {
                    RuntimeProbeResult::Ready => {
                        if diagnostics_enabled() {
                            eprintln!(
                                "[meeting-runtime] using bundled Python: {}",
                                candidate.display()
                            );
                        }
                        return Ok(candidate);
                    }
                    RuntimeProbeResult::Canceled => {
                        return Err("Meeting setup was canceled".into());
                    }
                    RuntimeProbeResult::Failed => {}
                }
            }
        }

        let app_data = super::data_dir()?;
        let runtime_dir = app_data.join("ASR Runtime");
        let python = runtime_dir.join("bin/python3");
        if resources::installed_runtime_ready(&runtime_dir) {
            match probe_runtime_imports(&python, || {
                self.status().session_id.as_deref() == Some(expected_session)
            }) {
                RuntimeProbeResult::Ready => return Ok(python),
                RuntimeProbeResult::Canceled => {
                    return Err("Meeting setup was canceled".into());
                }
                RuntimeProbeResult::Failed => {}
            }
        }
        if self.status().session_id.as_deref() != Some(expected_session) {
            return Err("Meeting setup was canceled".into());
        }
        let _ = fs::remove_file(runtime_dir.join(".kuku-meeting-ready"));
        fs::create_dir_all(&app_data)
            .map_err(|error| format!("Could not create the app data folder: {error}"))?;
        let bootstrap = find_asr_resource(&resource_dir, "bootstrap.sh")?;
        self.set_state(
            "preparing",
            None,
            Some("Preparing the Apple Silicon MLX runtime"),
            None,
        );
        let mut command = Command::new("/bin/zsh");
        command.arg(bootstrap).arg(&runtime_dir);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = Arc::new(Mutex::new(command.spawn().map_err(|e| e.to_string())?));
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Could not lock meeting state")?;
            let Some(active) = inner.active.as_mut().filter(|a| a.id == expected_session) else {
                if let Ok(mut child) = child.lock() {
                    kill_worker(&mut child);
                }
                return Err("Meeting setup was canceled".into());
            };
            active.worker_child = Some(child.clone());
        }
        let status = loop {
            if self.status().session_id.as_deref() != Some(expected_session) {
                if let Ok(mut child) = child.lock() {
                    kill_worker(&mut child);
                }
                return Err("Meeting setup was canceled".into());
            }
            if let Some(status) = child
                .lock()
                .map_err(|_| "Runtime process lock failed")?
                .try_wait()
                .map_err(|e| e.to_string())?
            {
                break status;
            }
            thread::sleep(Duration::from_millis(100));
        };
        if !status.success() || !resources::installed_runtime_ready(&runtime_dir) {
            let _ = fs::remove_file(runtime_dir.join(".kuku-meeting-ready"));
            return Err("MLX runtime installation failed. Check your network connection".into());
        }
        match probe_runtime_imports(&python, || {
            self.status().session_id.as_deref() == Some(expected_session)
        }) {
            RuntimeProbeResult::Ready => Ok(python),
            RuntimeProbeResult::Canceled => Err("Meeting setup was canceled".into()),
            RuntimeProbeResult::Failed => {
                let _ = fs::remove_file(runtime_dir.join(".kuku-meeting-ready"));
                Err("MLX runtime installation failed. Check your network connection".into())
            }
        }
    }

    fn read_worker(&self, stdout: impl std::io::Read, session_id: String) {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if self.status().session_id.as_deref() != Some(&session_id) {
                return;
            }
            self.handle_worker_event(value, &session_id);
        }
        if self.status().session_id.as_deref() != Some(&session_id) {
            return;
        }
        let phase = self.status().phase;
        if matches!(phase.as_str(), "recording" | "finalizing") && self.restart_worker_after_exit()
        {
            return;
        }
        if !matches!(phase.as_str(), "idle" | "error" | "saving") {
            self.fail(
                "worker_exit",
                "The local transcription engine closed unexpectedly".into(),
            );
        }
    }

    fn handle_worker_event(&self, value: Value, expected_session: &str) {
        if self.status().session_id.as_deref() != Some(expected_session) {
            return;
        }
        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "download" => {
                let progress = value
                    .get("progress")
                    .and_then(Value::as_f64)
                    .map(|v| v as f32);
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Downloading local models")
                    .to_string();
                if self.worker_is_recovering() {
                    self.set_message(Some(&format!(
                        "Recovering transcription engine · {message}"
                    )));
                } else {
                    self.set_state("downloading", progress, Some(&message), None);
                }
            }
            "loading" => {
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Loading models into memory");
                if self.worker_is_recovering() {
                    self.set_message(Some(&format!(
                        "Recovering transcription engine · {message}"
                    )));
                } else {
                    self.set_state("preparing", None, Some(message), None);
                }
            }
            "ready" => {
                if let Err(error) = self.activate_worker_input() {
                    self.fail("worker_input", error);
                    return;
                }
                let capture_started = self
                    .inner
                    .lock()
                    .ok()
                    .and_then(|inner| {
                        inner
                            .active
                            .as_ref()
                            .map(|active| active.audio_stop.is_some())
                    })
                    .unwrap_or(false);
                if capture_started {
                    if self.status().phase == "recording" {
                        #[cfg(debug_assertions)]
                        eprintln!("[meeting-recovery] worker ready; capture remained active");
                        self.set_message(Some("The transcription engine recovered automatically"));
                    }
                } else if let Err(error) = self.begin_capture() {
                    self.fail("capture_start", error);
                }
            }
            "transcript" => {
                let session_id = expected_session.to_string();
                let payload = TranscriptPayload {
                    session_id,
                    kind: "update".into(),
                    stable_text: value
                        .get("stableText")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                    unstable_text: value
                        .get("unstableText")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                    speaker_id: value
                        .get("speakerId")
                        .and_then(Value::as_u64)
                        .map(|v| v as u8),
                    segments: Vec::new(),
                    speaker_limit_warning: false,
                };
                if let Err(error) = self.journal.transcript(&payload) {
                    self.fail("journal_write", error);
                    return;
                }
                let _ = self.app.emit("meeting-notes://transcript", payload.clone());
            }
            "finalizing" => {
                let progress = value
                    .get("progress")
                    .and_then(Value::as_f64)
                    .map(|v| v as f32);
                self.set_state(
                    "finalizing",
                    progress,
                    Some(
                        value
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Organizing speakers"),
                    ),
                    None,
                );
            }
            "final" => {
                let segments = serde_json::from_value::<Vec<TranscriptSegment>>(
                    value.get("segments").cloned().unwrap_or_else(|| json!([])),
                )
                .unwrap_or_default();
                let (session_id, final_received) = {
                    let inner = match self.inner.lock() {
                        Ok(inner) => inner,
                        Err(_) => return,
                    };
                    let Some(active) = inner
                        .active
                        .as_ref()
                        .filter(|active| active.id == expected_session)
                    else {
                        return;
                    };
                    (active.id.clone(), active.worker_final_received.clone())
                };
                final_received.store(true, Ordering::Release);
                let payload = TranscriptPayload {
                    session_id,
                    kind: "final".into(),
                    stable_text: value
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                    unstable_text: String::new(),
                    speaker_id: None,
                    speaker_limit_warning: uses_all_speaker_slots(&segments),
                    segments,
                };

                if let Err(error) = self.journal.transcript(&payload) {
                    self.fail("journal_write", error);
                    return;
                }
                self.finish_session(expected_session);
                let _ = self.app.emit("meeting-notes://transcript", payload);
            }
            "error" => {
                self.fail(
                    value
                        .get("code")
                        .and_then(Value::as_str)
                        .unwrap_or("worker_error"),
                    value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("A transcription engine error occurred")
                        .into(),
                );
            }
            _ => {}
        }
    }

    fn begin_capture(&self) -> Result<(), String> {
        let (
            session_id,
            microphone_only,
            system_only,
            stdin,
            worker_generation,
            worker_shutdown,
            worker_final_received,
            audio_path,
            pcm_path,
            capture_bundle_id,
            capture_window_id,
        ) = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| "Could not lock meeting state")?;
            let active = inner
                .active
                .as_ref()
                .ok_or("The meeting session was canceled")?;
            (
                active.id.clone(),
                inner.state.microphone_only,
                inner.state.system_only,
                active.worker_stdin.clone(),
                active.worker_generation.clone(),
                active.worker_shutdown.clone(),
                active.worker_final_received.clone(),
                active.audio_path.clone(),
                active.pcm_path.clone(),
                active.capture_bundle_id.clone(),
                active.capture_window_id,
            )
        };
        let (capture_tx, capture_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Could not lock meeting state")?;
            if let Some(active) = inner.active.as_mut() {
                active.audio_stop = Some(stop_tx);
                active.audio_done = Some(done_rx);
            }
            inner.state.phase = "permission".into();
            inner.state.message = Some("Checking microphone and system audio permissions".into());
            inner.state.progress = None;
        }
        self.emit_state();
        let capture_sender_generation =
            if std::env::var("KUKU_MEETING_AUDIO_MOCK").ok().as_deref() == Some("1") {
                spawn_mock_capture(capture_tx, system_only);
                None
            } else {
                Some(audio_capture::start(
                    capture_tx,
                    microphone_only,
                    system_only,
                    capture_bundle_id.as_deref(),
                    capture_window_id,
                )?)
            };
        if let Some(generation) = capture_sender_generation {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Could not lock meeting state")?;
            let Some(active) = inner
                .active
                .as_mut()
                .filter(|active| active.id == session_id)
            else {
                if audio_capture::clear_sender_if(generation) {
                    audio_capture::stop();
                }
                return Err("The meeting session was canceled".into());
            };
            active.capture_sender_generation = Some(generation);
        }
        let controller = self.clone();
        thread::spawn(move || {
            controller.audio_loop(AudioLoopContext {
                session_id,
                capture_rx,
                stop_rx,
                stdin,
                worker_generation,
                worker_shutdown,
                worker_final_received,
                capture_sender_generation,
                audio_path,
                pcm_path,
                microphone_only,
                system_only,
                done_tx,
            })
        });
        Ok(())
    }

    fn audio_loop(&self, context: AudioLoopContext) {
        let AudioLoopContext {
            session_id,
            capture_rx,
            stop_rx,
            stdin,
            worker_generation,
            worker_shutdown,
            worker_final_received,
            capture_sender_generation,
            audio_path,
            pcm_path,
            microphone_only,
            system_only,
            done_tx,
        } = context;
        let _completion = AudioLoopCompletion(Some(done_tx));
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = match hound::WavWriter::create(&audio_path, spec) {
            Ok(writer) => writer,
            Err(error) => {
                self.fail_session(
                    &session_id,
                    "audio_file",
                    format!("Could not create recovery audio: {error}"),
                );
                return;
            }
        };
        let mut pcm_writer = match File::create(&pcm_path) {
            Ok(writer) => writer,
            Err(error) => {
                self.fail_session(
                    &session_id,
                    "audio_file",
                    format!("Could not create the live transcription PCM file: {error}"),
                );
                let _ = writer.finalize();
                return;
            }
        };
        let (worker_queue_tx, worker_queue_rx) = mpsc::channel();
        let (worker_done_tx, worker_done_rx) = mpsc::channel();
        let feeder_stdin = stdin.clone();
        let feeder_generation = worker_generation.clone();
        let feeder_shutdown = worker_shutdown.clone();
        let feeder_pcm_path = pcm_path.clone();
        thread::spawn(move || {
            let result = worker_feeder_loop(
                feeder_stdin,
                feeder_generation,
                feeder_shutdown,
                worker_final_received,
                feeder_pcm_path,
                worker_queue_rx,
            );
            let _ = worker_done_tx.send(result);
        });
        let mut timeline = TimestampMixer::default();
        let mut system_resampler = StreamingResampler::new(SAMPLE_RATE as f64);
        let mut microphone_resampler = StreamingResampler::new(SAMPLE_RATE as f64);
        let mut last_system = Instant::now();
        let mut last_microphone = Instant::now();
        let mut _system_samples_received = 0usize;
        let mut microphone_samples_received = 0usize;
        let mut _samples_forwarded = 0usize;
        let mut capture_ready_at: Option<Instant> = None;
        let mut pcm_offset = 0u64;
        let mut last_diagnostic = Instant::now();
        let mut cancelled = false;
        let mut reached_duration_limit = false;

        loop {
            if worker_shutdown.load(Ordering::Acquire) {
                cancelled = true;
                break;
            }
            if let Ok(command) = stop_rx.try_recv() {
                cancelled = command == AudioLoopCommand::Cancel;
                break;
            }
            match capture_rx.recv_timeout(Duration::from_millis(25)) {
                Ok(CaptureEvent::Audio {
                    samples,
                    sample_rate,
                    presentation_seconds,
                    source,
                }) => {
                    let converted = match source {
                        AudioSource::System => system_resampler.process(&samples, sample_rate),
                        AudioSource::Microphone => {
                            microphone_resampler.process(&samples, sample_rate)
                        }
                    };
                    match source {
                        AudioSource::System => {
                            last_system = Instant::now();
                            _system_samples_received += converted.len();
                        }
                        AudioSource::Microphone => {
                            last_microphone = Instant::now();
                            microphone_samples_received += converted.len();
                        }
                    }
                    timeline.push(source, presentation_seconds, &converted);
                }
                Ok(CaptureEvent::State { code: 2, message }) => {
                    capture_ready_at = Some(Instant::now());
                    self.mark_recording(&session_id, message);
                }
                Ok(CaptureEvent::State { code, message }) if code < 0 => {
                    self.fail_session(
                        &session_id,
                        if code == -2 {
                            "microphone_permission"
                        } else if code == -4 {
                            "microphone_unavailable"
                        } else {
                            "permission_or_capture"
                        },
                        if message.is_empty() {
                            "Audio permission was denied or capture could not start".into()
                        } else {
                            message
                        },
                    );
                    worker_shutdown.store(true, Ordering::Release);
                    let _ = worker_queue_tx.send(WorkerQueueMessage::Cancel);
                    let _ = writer.finalize();
                    let _ = pcm_writer.flush();
                    return;
                }
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }

            let microphone_stalled =
                required_microphone_stalled(system_only, capture_ready_at, last_microphone);
            if microphone_stalled {
                audio_capture::stop();
                worker_shutdown.store(true, Ordering::Release);
                let _ = worker_queue_tx.send(WorkerQueueMessage::Cancel);
                let _ = writer.finalize();
                let _ = pcm_writer.flush();
                let message = if microphone_samples_received == 0 {
                    "No microphone input was detected. Connect a microphone or use system audio only."
                } else {
                    "The microphone disconnected while recording. Check the device and try again."
                };
                self.fail_session(&session_id, "microphone_unavailable", message.into());
                if let Some(generation) = capture_sender_generation {
                    audio_capture::clear_sender_if(generation);
                }
                return;
            }

            loop {
                let microphone_available = timeline.microphone_available();
                let system_available = timeline.system_available();
                let ready = if system_only && system_available >= AUDIO_FRAME_SAMPLES {
                    AUDIO_FRAME_SAMPLES
                } else if system_only {
                    0
                } else if microphone_only && microphone_available >= AUDIO_FRAME_SAMPLES {
                    AUDIO_FRAME_SAMPLES
                } else if microphone_only {
                    0
                } else if microphone_available >= AUDIO_FRAME_SAMPLES
                    && system_available >= AUDIO_FRAME_SAMPLES
                {
                    AUDIO_FRAME_SAMPLES
                } else if system_available >= AUDIO_FRAME_SAMPLES
                    && last_microphone.elapsed() > Duration::from_millis(250)
                {
                    system_available
                } else if microphone_available >= AUDIO_FRAME_SAMPLES
                    && last_system.elapsed() > Duration::from_millis(250)
                {
                    microphone_available
                } else if timeline.remaining() >= AUDIO_FRAME_SAMPLES / 2
                    && last_system.elapsed() > Duration::from_millis(250)
                    && last_microphone.elapsed() > Duration::from_millis(250)
                {
                    timeline.remaining()
                } else {
                    0
                };
                let remaining_limit = MAX_MEETING_SAMPLES.saturating_sub(_samples_forwarded);
                let take = bounded_audio_take(ready, _samples_forwarded);
                if take == 0 {
                    if remaining_limit == 0 {
                        reached_duration_limit = true;
                    }
                    break;
                }
                let mixed = timeline.take(take, microphone_only, system_only);
                if let Err(error) = append_wav_samples(&mut writer, &mixed) {
                    self.fail_session(&session_id, "audio_write", error);
                    cancelled = true;
                    break;
                }
                let bytes = f32_bytes(&mixed);
                if let Err(error) =
                    append_worker_pcm(&mut pcm_writer, &worker_queue_tx, &mut pcm_offset, &bytes)
                {
                    self.fail_session(&session_id, "worker_spool", error);
                    cancelled = true;
                    break;
                }
                _samples_forwarded += mixed.len();
                if _samples_forwarded >= MAX_MEETING_SAMPLES {
                    reached_duration_limit = true;
                    break;
                }
            }

            if cancelled {
                break;
            }
            if reached_duration_limit {
                self.set_message(Some(
                    "The 6-hour limit was reached. Finishing the transcript",
                ));
                break;
            }

            if diagnostics_enabled() && last_diagnostic.elapsed() >= Duration::from_secs(2) {
                eprintln!(
                    "[meeting-capture] system={} mic={} queued_system={} queued_mic={} forwarded={}",
                    _system_samples_received,
                    microphone_samples_received,
                    timeline.system_available(),
                    timeline.microphone_available(),
                    _samples_forwarded,
                );
                last_diagnostic = Instant::now();
            }
        }

        // Includes automatic duration-limit completion and disconnected captures.
        if self.status().session_id.as_deref() == Some(&session_id) {
            audio_capture::stop();
        }
        while !reached_duration_limit && timeline.remaining() > 0 {
            let take = bounded_audio_take(timeline.remaining(), _samples_forwarded);
            if take == 0 {
                break;
            }
            let mixed = timeline.take(take, microphone_only, system_only);
            if let Err(error) = append_wav_samples(&mut writer, &mixed) {
                self.fail_session(&session_id, "audio_write", error);
                cancelled = true;
                break;
            }
            if !cancelled {
                let bytes = f32_bytes(&mixed);
                if let Err(error) =
                    append_worker_pcm(&mut pcm_writer, &worker_queue_tx, &mut pcm_offset, &bytes)
                {
                    self.fail_session(&session_id, "worker_spool", error);
                    cancelled = true;
                }
            }
            _samples_forwarded += mixed.len();
        }
        if let Err(error) = writer.finalize()
            && !cancelled
        {
            self.fail_session(
                &session_id,
                "audio_finalize",
                format!("Could not finalize meeting audio: {error}"),
            );
            cancelled = true;
        }
        if let Err(error) = pcm_writer.flush()
            && !cancelled
        {
            self.fail_session(
                &session_id,
                "worker_spool",
                format!("Could not flush meeting audio: {error}"),
            );
            cancelled = true;
        }
        if cancelled {
            worker_shutdown.store(true, Ordering::Release);
            let _ = worker_queue_tx.send(WorkerQueueMessage::Cancel);
            let _ = worker_done_rx.recv_timeout(Duration::from_secs(3));
            if let Some(generation) = capture_sender_generation {
                audio_capture::clear_sender_if(generation);
            }
            return;
        }
        let _ = worker_queue_tx.send(WorkerQueueMessage::Finish {
            end_offset: pcm_offset,
        });
        let feed_result = worker_done_rx.recv_timeout(worker_finish_timeout(pcm_offset));
        if !matches!(feed_result, Ok(Ok(()))) && self.status().phase != "error" {
            self.fail_session(
                &session_id,
                "worker_recovery_timeout",
                "The transcription engine did not recover".into(),
            );
        }
        if let Some(generation) = capture_sender_generation {
            audio_capture::clear_sender_if(generation);
        }
    }

    fn mark_recording(&self, session_id: &str, message: String) {
        if diagnostics_enabled() {
            eprintln!("[meeting-state] phase=recording message={message:?}");
        }
        if let Ok(mut inner) = self.inner.lock() {
            if inner.state.session_id.as_deref() != Some(session_id)
                || inner.state.phase != "permission"
            {
                return;
            }
            inner.state.phase = "recording".into();
            inner.state.message = Some(message);
            inner.state.started_at_ms = Some(Utc::now().timestamp_millis());
            inner.state.progress = None;
        }
        self.emit_state();
    }

    fn finish_session(&self, session_id: &str) {
        if diagnostics_enabled() {
            eprintln!("[meeting-state] phase=saving");
        }
        let sender_generation = if let Ok(mut inner) = self.inner.lock() {
            if inner.state.session_id.as_deref() != Some(session_id) {
                return;
            }
            let sender_generation = inner
                .active
                .as_ref()
                .and_then(|active| active.capture_sender_generation);
            if let Some(child) = inner
                .active
                .as_ref()
                .and_then(|active| active.worker_child.clone())
            {
                thread::spawn(move || {
                    if let Ok(mut child) = child.lock() {
                        let _ = child.wait();
                    }
                });
            }
            // Do not expose an intermediate idle state: exit/restart must keep
            // waiting for the document's disk acknowledgement.
            inner.state.phase = "saving".into();
            inner.state.progress = None;
            inner.state.message = Some("Waiting for the document to be saved".into());
            inner.active = None;
            sender_generation
        } else {
            None
        };
        if let Some(generation) = sender_generation {
            audio_capture::clear_sender_if(generation);
        }
        self.emit_state();
    }

    fn set_idle(&self, message: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.state = MeetingStateSnapshot::default();
            inner.state.message = Some(message.into());
        }
        self.emit_state();
    }

    fn worker_is_recovering(&self) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| {
                inner
                    .active
                    .as_ref()
                    .map(|active| active.worker_restarts > 0 && active.audio_stop.is_some())
            })
            .unwrap_or(false)
    }

    fn activate_worker_input(&self) -> Result<(), String> {
        let (worker_stdin, worker_generation, pending) = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Could not lock meeting state")?;
            let active = inner
                .active
                .as_mut()
                .ok_or("The meeting session was canceled")?;
            (
                active.worker_stdin.clone(),
                active.worker_generation.clone(),
                active
                    .pending_worker_stdin
                    .take()
                    .ok_or("Worker input is not ready")?,
            )
        };
        *worker_stdin
            .lock()
            .map_err(|_| "Could not lock transcription engine input")? = Some(pending);
        worker_generation.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }

    fn restart_worker_after_exit(&self) -> bool {
        let should_restart = {
            let mut inner = match self.inner.lock() {
                Ok(inner) => inner,
                Err(_) => return false,
            };
            let Some(active) = inner.active.as_mut() else {
                return false;
            };
            if active.worker_restarts >= 1 {
                false
            } else {
                active.worker_restarts += 1;
                if let Ok(mut stdin) = active.worker_stdin.lock() {
                    *stdin = None;
                }
                active.pending_worker_stdin = None;
                active.worker_child = None;
                inner.state.message = Some(
                    "The transcription engine stopped and is recovering automatically while preserving recorded audio".into(),
                );
                true
            }
        };
        if !should_restart {
            return false;
        }
        #[cfg(debug_assertions)]
        eprintln!("[meeting-recovery] restarting worker once while preserving audio capture");
        self.emit_state();
        let controller = self.clone();
        let Some(session_id) = self.status().session_id else {
            return false;
        };
        thread::spawn(move || {
            if let Err(error) = controller.prepare_worker(&session_id) {
                controller.fail_session(&session_id, "worker_recovery", error);
            }
        });
        true
    }

    fn set_message(&self, message: Option<&str>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.state.message = message.map(str::to_string);
        }
        self.emit_state();
    }

    fn set_state(
        &self,
        phase: &str,
        progress: Option<f32>,
        message: Option<&str>,
        error_code: Option<&str>,
    ) {
        if diagnostics_enabled() {
            eprintln!(
                "[meeting-state] phase={phase} progress={progress:?} message={message:?} error={error_code:?}"
            );
        }
        if let Ok(mut inner) = self.inner.lock() {
            inner.state.phase = phase.into();
            inner.state.progress = progress;
            inner.state.message = message.map(str::to_string);
            inner.state.error_code = error_code.map(str::to_string);
        }
        self.emit_state();
    }

    fn fail(&self, code: &str, message: String) {
        if diagnostics_enabled() {
            eprintln!("[meeting-error] code={code:?} message={message:?}");
        }
        let (should_fail, stop, shutdown) = self
            .inner
            .lock()
            .map(|inner| {
                (
                    inner.active.is_some() || inner.state.phase != "idle",
                    inner
                        .active
                        .as_ref()
                        .and_then(|active| active.audio_stop.clone()),
                    inner
                        .active
                        .as_ref()
                        .map(|active| active.worker_shutdown.clone()),
                )
            })
            .unwrap_or((false, None, None));
        if !should_fail {
            return;
        }
        audio_capture::stop();
        if let Some(shutdown) = shutdown {
            shutdown.store(true, Ordering::Release);
        }
        if let Some(stop) = stop {
            let _ = stop.send(AudioLoopCommand::Cancel);
        }
        self.set_state("error", None, Some(&message), Some(code));
        let child = self
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.active.as_ref().and_then(|a| a.worker_child.clone()));
        if let Some(child) = child
            && let Ok(mut child) = child.lock()
        {
            kill_worker(&mut child);
        }
    }

    fn fail_session(&self, session_id: &str, code: &str, message: String) {
        if self.status().session_id.as_deref() == Some(session_id) {
            self.fail(code, message);
        }
    }

    pub fn acknowledge(&self, session_id: &str) -> Result<(), String> {
        self.journal.remove(session_id)?;
        if self.status().session_id.as_deref() == Some(session_id) {
            self.set_idle("Saved");
        }
        Ok(())
    }

    fn emit_state(&self) {
        let _ = self.app.emit("meeting-notes://state", self.status());
    }
}

fn kill_worker(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn spawn_mock_capture(sender: Sender<CaptureEvent>, system_only: bool) {
    thread::spawn(move || {
        if sender
            .send(CaptureEvent::State {
                code: 2,
                message: "Transcribing test audio".into(),
            })
            .is_err()
        {
            return;
        }
        let mut presentation_seconds = 0.0;
        let stall_after_chunks = std::env::var("KUKU_MEETING_AUDIO_MOCK_STALL_AFTER_CHUNKS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let mut chunks_sent = 0usize;
        let max_chunks = std::env::var("KUKU_MEETING_AUDIO_MOCK_MAX_CHUNKS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let interval_ms = std::env::var("KUKU_MEETING_AUDIO_MOCK_INTERVAL_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(200);
        loop {
            if max_chunks > 0 && chunks_sent >= max_chunks {
                break;
            }
            if stall_after_chunks > 0 && chunks_sent >= stall_after_chunks {
                thread::sleep(Duration::from_millis(200));
                continue;
            }
            let samples = vec![0.0; 3_200];
            if sender
                .send(CaptureEvent::Audio {
                    samples,
                    sample_rate: SAMPLE_RATE as f64,
                    presentation_seconds,
                    source: if system_only {
                        AudioSource::System
                    } else {
                        AudioSource::Microphone
                    },
                })
                .is_err()
            {
                break;
            }
            chunks_sent += 1;
            presentation_seconds += 0.2;
            if interval_ms > 0 {
                thread::sleep(Duration::from_millis(interval_ms));
            }
        }
    });
}

fn find_worker_script(resource_dir: &Path) -> Result<PathBuf, String> {
    find_asr_resource(resource_dir, "asr_worker.py")
}

fn find_asr_resource(resource_dir: &Path, name: &str) -> Result<PathBuf, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for candidate in [
        resource_dir.join("meeting_notes/asr").join(name),
        resource_dir.join("resources/meeting_notes/asr").join(name),
        manifest.join("resources/meeting_notes/asr").join(name),
    ] {
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!("Could not find ASR resource {name}"))
}

fn uses_all_speaker_slots(segments: &[TranscriptSegment]) -> bool {
    let mut seen = [false; 4];
    for speaker in segments.iter().filter_map(|segment| segment.speaker) {
        if (1..=4).contains(&speaker) {
            seen[(speaker - 1) as usize] = true;
        }
    }
    seen.into_iter().all(|value| value)
}

#[tauri::command]
pub fn meeting_notes_status(
    controller: tauri::State<'_, MeetingController>,
) -> MeetingStateSnapshot {
    controller.status()
}

#[tauri::command]
pub fn meeting_notes_resources(
    controller: tauri::State<'_, MeetingController>,
) -> Result<MeetingResourceStatus, String> {
    controller.resources()
}

#[tauri::command]
pub fn meeting_notes_remove_local_data(
    controller: tauri::State<'_, MeetingController>,
) -> Result<MeetingResourceRemoval, String> {
    controller.remove_local_data()
}

#[tauri::command]
pub fn meeting_notes_open_settings(error_code: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = match error_code.as_deref() {
            Some("microphone_permission") => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            Some("microphone_unavailable") => {
                "x-apple.systempreferences:com.apple.Sound-Settings.extension"
            }
            _ => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        };
        let status = Command::new("/usr/bin/open")
            .arg(url)
            .status()
            .map_err(|error| format!("Could not open System Settings: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err("Could not open System Settings".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    Err("This feature is available only on macOS".into())
}

#[tauri::command]
pub fn meeting_notes_microphone_permission_status() -> String {
    if !audio_capture::is_available() {
        return "unavailable".into();
    }
    audio_capture::microphone_permission_status().into()
}

#[tauri::command]
pub async fn meeting_notes_request_microphone_permission() -> Result<String, String> {
    super::ensure_enabled()?;
    if !audio_capture::is_available() {
        return Err("unsupported_platform".into());
    }
    audio_capture::request_microphone_permission()
        .await
        .map(str::to_owned)
}

#[tauri::command]
pub fn meeting_notes_open_microphone_settings() -> Result<(), String> {
    meeting_notes_open_settings(Some("microphone_permission".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Error, Result as IoResult, SeekFrom};

    struct FailingWriter {
        inner: Cursor<Vec<u8>>,
        remaining: usize,
    }

    impl Write for FailingWriter {
        fn write(&mut self, bytes: &[u8]) -> IoResult<usize> {
            if self.remaining == 0 {
                return Err(Error::other("disk full"));
            }
            let length = bytes.len().min(self.remaining);
            let written = self.inner.write(&bytes[..length])?;
            self.remaining -= written;
            Ok(written)
        }

        fn flush(&mut self) -> IoResult<()> {
            self.inner.flush()
        }
    }

    impl Seek for FailingWriter {
        fn seek(&mut self, position: SeekFrom) -> IoResult<u64> {
            self.inner.seek(position)
        }
    }

    #[test]
    fn worker_finish_timeout_scales_for_full_disk_replay() {
        let podcast_bytes = 28_u64 * 60 * SAMPLE_RATE as u64 * std::mem::size_of::<f32>() as u64;
        assert_eq!(worker_finish_timeout(0), Duration::from_secs(120));
        assert_eq!(
            worker_finish_timeout(podcast_bytes),
            Duration::from_secs(16 * 60)
        );
    }

    #[cfg(unix)]
    #[test]
    fn runtime_import_probe_requires_success_and_honors_cancellation() {
        assert_eq!(
            probe_runtime_imports(Path::new("/usr/bin/true"), || true),
            RuntimeProbeResult::Ready
        );
        assert_eq!(
            probe_runtime_imports(Path::new("/usr/bin/false"), || true),
            RuntimeProbeResult::Failed
        );
        assert_eq!(
            probe_runtime_imports(Path::new("/missing/python"), || true),
            RuntimeProbeResult::Failed
        );
        assert_eq!(
            probe_runtime_imports(Path::new("/usr/bin/true"), || false),
            RuntimeProbeResult::Canceled
        );
    }

    #[test]
    fn reports_wav_disk_write_failures_instead_of_silently_truncating() {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let sink = FailingWriter {
            inner: Cursor::new(Vec::new()),
            remaining: 44,
        };
        let mut writer = hound::WavWriter::new(sink, spec).expect("write WAV header");

        let error = append_wav_samples(&mut writer, &[0.5]).expect_err("reject audio sample");

        assert!(error.contains("disk full"));
    }

    #[test]
    fn warns_when_all_four_anonymous_speaker_slots_are_used() {
        let segments = (1..=4)
            .map(|speaker| TranscriptSegment {
                speaker: Some(speaker),
                text: format!("Speaker {speaker}"),
                start: None,
                end: None,
            })
            .collect::<Vec<_>>();
        assert!(uses_all_speaker_slots(&segments));
    }
}
