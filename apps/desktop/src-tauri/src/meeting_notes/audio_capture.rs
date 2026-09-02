use std::{
    ffi::{CStr, CString, c_char, c_double, c_float, c_int},
    sync::{Mutex, OnceLock, mpsc::Sender},
    time::Duration,
};

#[derive(Debug)]
pub enum CaptureEvent {
    Audio {
        samples: Vec<f32>,
        sample_rate: f64,
        presentation_seconds: f64,
        source: AudioSource,
    },
    State {
        code: i32,
        message: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AudioSource {
    System,
    Microphone,
}

#[derive(Default)]
struct EventSenderSlot {
    generation: u64,
    sender: Option<Sender<CaptureEvent>>,
}

static EVENT_SENDER: OnceLock<Mutex<EventSenderSlot>> = OnceLock::new();
static MICROPHONE_PERMISSION_SENDER: OnceLock<Mutex<Option<Sender<c_int>>>> = OnceLock::new();

fn sender_slot() -> &'static Mutex<EventSenderSlot> {
    EVENT_SENDER.get_or_init(|| Mutex::new(EventSenderSlot::default()))
}

fn microphone_permission_sender_slot() -> &'static Mutex<Option<Sender<c_int>>> {
    MICROPHONE_PERMISSION_SENDER.get_or_init(|| Mutex::new(None))
}

fn register_sender(sender: Sender<CaptureEvent>) -> Result<u64, String> {
    let mut slot = sender_slot()
        .lock()
        .map_err(|_| "Could not initialize audio capture state")?;
    slot.generation = slot.generation.wrapping_add(1).max(1);
    slot.sender = Some(sender);
    Ok(slot.generation)
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn kuku_meeting_audio_capture_available() -> c_int;
    fn kuku_meeting_audio_capture_start(
        audio_callback: extern "C" fn(*const c_float, usize, c_double, c_double, c_int),
        state_callback: extern "C" fn(c_int, *const c_char),
        microphone_only: c_int,
        capture_bundle_id: *const c_char,
        capture_window_id: u32,
    );
    fn kuku_meeting_audio_capture_stop();
    fn kuku_meeting_microphone_authorization_status() -> c_int;
    fn kuku_meeting_microphone_request_permission(callback: extern "C" fn(c_int));
}

#[cfg(target_os = "macos")]
extern "C" fn receive_microphone_permission(status: c_int) {
    if let Ok(mut slot) = microphone_permission_sender_slot().lock()
        && let Some(sender) = slot.take()
    {
        let _ = sender.send(status);
    }
}

fn microphone_permission_name(status: c_int) -> &'static str {
    match status {
        1 => "authorized",
        2 => "denied",
        3 => "restricted",
        _ => "not-determined",
    }
}

pub fn microphone_permission_status() -> &'static str {
    #[cfg(target_os = "macos")]
    unsafe {
        microphone_permission_name(kuku_meeting_microphone_authorization_status())
    }
    #[cfg(not(target_os = "macos"))]
    "unavailable"
}

pub async fn request_microphone_permission() -> Result<&'static str, String> {
    #[cfg(target_os = "macos")]
    {
        let current = microphone_permission_status();
        if current != "not-determined" {
            return Ok(current);
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        {
            let mut slot = microphone_permission_sender_slot()
                .lock()
                .map_err(|_| "Could not initialize microphone permission state")?;
            if slot.is_some() {
                return Err("A microphone permission request is already in progress".into());
            }
            *slot = Some(sender);
        }
        unsafe { kuku_meeting_microphone_request_permission(receive_microphone_permission) };
        let received = tauri::async_runtime::spawn_blocking(move || {
            receiver.recv_timeout(Duration::from_secs(120))
        })
        .await
        .map_err(|error| format!("Microphone permission request failed: {error}"))?;
        let status = match received {
            Ok(status) => status,
            Err(_) => {
                if let Ok(mut slot) = microphone_permission_sender_slot().lock() {
                    *slot = None;
                }
                return Err("Microphone permission request timed out".into());
            }
        };
        Ok(microphone_permission_name(status))
    }
    #[cfg(not(target_os = "macos"))]
    Err("This feature is available only on macOS".into())
}

#[cfg(target_os = "macos")]
extern "C" fn receive_audio(
    samples: *const c_float,
    sample_count: usize,
    sample_rate: c_double,
    presentation_seconds: c_double,
    source: c_int,
) {
    if samples.is_null() || sample_count == 0 {
        return;
    }
    let copied = unsafe { std::slice::from_raw_parts(samples, sample_count) }.to_vec();
    let event = CaptureEvent::Audio {
        samples: copied,
        sample_rate,
        presentation_seconds,
        source: if source == 1 {
            AudioSource::Microphone
        } else {
            AudioSource::System
        },
    };
    if let Ok(slot) = sender_slot().lock()
        && let Some(sender) = slot.sender.as_ref()
    {
        let _ = sender.send(event);
    }
}

#[cfg(target_os = "macos")]
extern "C" fn receive_state(code: c_int, message: *const c_char) {
    let message = if message.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(message) }
            .to_string_lossy()
            .into_owned()
    };
    if let Ok(slot) = sender_slot().lock()
        && let Some(sender) = slot.sender.as_ref()
    {
        let _ = sender.send(CaptureEvent::State { code, message });
    }
}

pub fn is_available() -> bool {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    unsafe {
        kuku_meeting_audio_capture_available() == 1
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    false
}

pub fn start(
    sender: Sender<CaptureEvent>,
    microphone_only: bool,
    system_only: bool,
    capture_bundle_id: Option<&str>,
    capture_window_id: Option<u32>,
) -> Result<u64, String> {
    if !is_available() {
        return Err(
            "Meeting transcription requires an Apple Silicon Mac running macOS 15 or later".into(),
        );
    }
    let capture_bundle_id = capture_bundle_id
        .filter(|value| !value.trim().is_empty())
        .map(CString::new)
        .transpose()
        .map_err(|_| "The capture application identifier is invalid")?;
    let capture_window_id = if capture_bundle_id.is_some() {
        capture_window_id.filter(|value| *value != 0).unwrap_or(0)
    } else {
        0
    };
    let sender_generation = register_sender(sender)?;
    #[cfg(target_os = "macos")]
    unsafe {
        kuku_meeting_audio_capture_start(
            receive_audio,
            receive_state,
            if microphone_only {
                1
            } else if system_only {
                2
            } else {
                0
            },
            capture_bundle_id
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr()),
            capture_window_id,
        );
    }
    Ok(sender_generation)
}

pub fn stop() {
    #[cfg(target_os = "macos")]
    unsafe {
        kuku_meeting_audio_capture_stop();
    }
}

pub fn clear_sender_if(generation: u64) -> bool {
    if let Ok(mut slot) = sender_slot().lock()
        && slot.generation == generation
    {
        slot.sender = None;
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn stale_capture_cleanup_does_not_clear_a_new_sender() {
        let (first_sender, _first_receiver) = mpsc::channel();
        let first_generation = register_sender(first_sender).expect("register first sender");
        let (second_sender, _second_receiver) = mpsc::channel();
        let second_generation = register_sender(second_sender).expect("register second sender");

        assert!(!clear_sender_if(first_generation));
        let slot = sender_slot().lock().expect("inspect sender slot");
        assert_eq!(slot.generation, second_generation);
        assert!(slot.sender.is_some());
        drop(slot);

        assert!(clear_sender_if(second_generation));
        assert!(
            sender_slot()
                .lock()
                .expect("inspect cleared sender slot")
                .sender
                .is_none()
        );
    }
}
