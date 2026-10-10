use serde::Serialize;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const REQUIRED_MATCHES: u8 = 3;
const REQUIRED_MISSES_TO_REARM: u8 = 15;
// A user has to bring Kuku to the foreground to start notes manually, so a
// synchronous environment read would see Kuku rather than the meeting app.
// Retain only a very recent, already-debounced candidate across that focus
// handoff. Longer gaps safely fall back to ordinary main-display capture.
const CAPTURE_TARGET_FRESHNESS: Duration = Duration::from_secs(8);
const CAPTURE_TARGET_SAMPLE_GAP: Duration = Duration::from_secs(4);

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct MeetingEnvironment {
    microphone_active: bool,
    bundle_id: String,
    app_name: String,
    window_title: String,
    window_id: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MeetingCandidate {
    bundle_id: String,
    app_name: String,
    window_id: Option<u32>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDetectionSnapshot {
    available: bool,
    detected: bool,
    app_name: Option<String>,
    bundle_id: Option<String>,
    window_id: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCaptureTarget {
    bundle_id: String,
    window_id: Option<u32>,
}

#[derive(Debug, Default)]
struct DetectionDebouncer {
    candidate: Option<MeetingCandidate>,
    matches: u8,
    misses: u8,
    announced: bool,
}

#[derive(Debug, Default)]
struct RecentCandidate {
    candidate: Option<MeetingCandidate>,
    observed_at: Option<Instant>,
    matches: u8,
}

impl RecentCandidate {
    fn observe(&mut self, candidate: &MeetingCandidate, observed_at: Instant) {
        let continues_streak = self.candidate.as_ref() == Some(candidate)
            && self.observed_at.is_some_and(|previous| {
                observed_at.saturating_duration_since(previous) <= CAPTURE_TARGET_SAMPLE_GAP
            });
        self.matches = if continues_streak {
            self.matches.saturating_add(1)
        } else {
            1
        };
        self.candidate = Some(candidate.clone());
        self.observed_at = Some(observed_at);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum DetectionTransition {
    Detected(MeetingCandidate),
    Cleared,
}

impl DetectionDebouncer {
    fn observe(&mut self, next: Option<MeetingCandidate>) -> Option<DetectionTransition> {
        if let Some(next) = next {
            self.misses = 0;
            if self.announced {
                return None;
            }

            if self.candidate.as_ref() == Some(&next) {
                self.matches = self.matches.saturating_add(1);
            } else {
                self.candidate = Some(next.clone());
                self.matches = 1;
            }

            if self.matches >= REQUIRED_MATCHES {
                self.announced = true;
                return Some(DetectionTransition::Detected(next));
            }
            return None;
        }

        self.candidate = None;
        self.matches = 0;
        if !self.announced {
            return None;
        }

        self.misses = self.misses.saturating_add(1);
        if self.misses >= REQUIRED_MISSES_TO_REARM {
            self.misses = 0;
            self.announced = false;
            return Some(DetectionTransition::Cleared);
        }
        None
    }
}

#[derive(Clone)]
pub struct MeetingDetectionController {
    app: AppHandle,
    generation: Arc<AtomicU64>,
    state: Arc<Mutex<MeetingDetectionSnapshot>>,
    recent_candidate: Arc<Mutex<RecentCandidate>>,
}

impl MeetingDetectionController {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            generation: Arc::new(AtomicU64::new(0)),
            state: Arc::new(Mutex::new(MeetingDetectionSnapshot {
                available: super::audio_capture::is_available(),
                ..MeetingDetectionSnapshot::default()
            })),
            recent_candidate: Arc::new(Mutex::new(RecentCandidate::default())),
        }
    }

    pub fn status(&self) -> MeetingDetectionSnapshot {
        self.state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default()
    }

    /// Returns a capture hint only while the previously debounced meeting was
    /// observed recently enough to survive the focus handoff into Kuku. The
    /// debounced snapshot deliberately remains set across longer signal gaps so
    /// the detection prompt does not rearm, making the snapshot alone too stale
    /// for manual capture targeting.
    pub fn capture_target(&self) -> Option<MeetingCaptureTarget> {
        let snapshot = self.status();
        let recent = self.recent_candidate.lock().ok()?;
        let age = recent.observed_at?.elapsed();
        confirmed_capture_target(&snapshot, recent.candidate.clone(), recent.matches, age)
    }

    pub fn set_enabled(&self, enabled: bool) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if !enabled || !super::audio_capture::is_available() {
            self.apply(DetectionTransition::Cleared);
            return;
        }
        let this = self.clone();
        #[cfg(target_os = "macos")]
        std::thread::spawn(move || {
            let mut debouncer = DetectionDebouncer::default();
            while this.generation.load(Ordering::SeqCst) == generation {
                let candidate = classify_environment(&read_environment());
                this.remember_candidate(candidate.as_ref());
                if let Some(transition) = debouncer.observe(candidate) {
                    this.apply(transition);
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        });
    }

    fn remember_candidate(&self, candidate: Option<&MeetingCandidate>) {
        let Some(candidate) = candidate else {
            return;
        };
        if let Ok(mut recent) = self.recent_candidate.lock() {
            recent.observe(candidate, Instant::now());
        }
    }

    fn apply(&self, transition: DetectionTransition) {
        let snapshot = match transition {
            DetectionTransition::Detected(candidate) => MeetingDetectionSnapshot {
                available: true,
                detected: true,
                app_name: Some(candidate.app_name),
                bundle_id: Some(candidate.bundle_id),
                window_id: candidate.window_id,
            },
            DetectionTransition::Cleared => MeetingDetectionSnapshot {
                available: true,
                ..MeetingDetectionSnapshot::default()
            },
        };
        if let Ok(mut state) = self.state.lock() {
            *state = snapshot.clone();
        }
        if !snapshot.detected
            && let Ok(mut recent) = self.recent_candidate.lock()
        {
            *recent = RecentCandidate::default();
        }
        let _ = self.app.emit("meeting-notes://detection", snapshot);
    }
}

fn classify_environment(environment: &MeetingEnvironment) -> Option<MeetingCandidate> {
    if !environment.microphone_active || environment.bundle_id.is_empty() {
        return None;
    }

    let bundle = environment.bundle_id.to_ascii_lowercase();
    let desktop_name = match bundle.as_str() {
        "us.zoom.xos" => Some("Zoom"),
        "com.microsoft.teams" | "com.microsoft.teams2" => Some("Microsoft Teams"),
        "com.cisco.webexmeetingsapp" | "cisco-systems.spark" => Some("Webex"),
        "com.apple.facetime" => Some("FaceTime"),
        "com.skype.skype" => Some("Skype"),
        _ => None,
    };
    if let Some(name) = desktop_name {
        return Some(MeetingCandidate {
            bundle_id: environment.bundle_id.clone(),
            app_name: name.into(),
            window_id: environment.window_id,
        });
    }

    if !is_supported_browser(&bundle) {
        return None;
    }
    let title = environment.window_title.to_ascii_lowercase();
    let service = if is_google_meet_title(&title) {
        Some("Google Meet")
    } else if title.contains("microsoft teams") || title.contains("teams.microsoft.com") {
        Some("Microsoft Teams")
    } else if title.contains("zoom meeting") || title.contains("zoom workplace") {
        Some("Zoom")
    } else if title.contains("webex") {
        Some("Webex")
    } else {
        None
    }?;

    // Browser bundle identifiers are shared by every browser window. Keep the
    // exact window that supplied the meeting title so a larger unrelated
    // browser window on another display cannot be selected at capture time.
    let window_id = environment.window_id?;

    Some(MeetingCandidate {
        bundle_id: environment.bundle_id.clone(),
        app_name: service.into(),
        window_id: Some(window_id),
    })
}

fn is_google_meet_title(title: &str) -> bool {
    title.contains("google meet")
        || title.contains("meet.google.com")
        || title
            .strip_prefix("meet - ")
            .is_some_and(|meeting_code| !meeting_code.trim().is_empty())
}

fn confirmed_capture_target(
    snapshot: &MeetingDetectionSnapshot,
    current: Option<MeetingCandidate>,
    matches: u8,
    age: Duration,
) -> Option<MeetingCaptureTarget> {
    if !snapshot.available
        || !snapshot.detected
        || matches < REQUIRED_MATCHES
        || age > CAPTURE_TARGET_FRESHNESS
    {
        return None;
    }
    let confirmed_bundle = snapshot.bundle_id.as_deref()?.trim();
    if confirmed_bundle.is_empty() {
        return None;
    }
    let current = current?;
    if !current.bundle_id.eq_ignore_ascii_case(confirmed_bundle)
        || current.window_id != snapshot.window_id
    {
        return None;
    }
    Some(MeetingCaptureTarget {
        bundle_id: confirmed_bundle.to_string(),
        window_id: snapshot.window_id,
    })
}

fn is_supported_browser(bundle_id: &str) -> bool {
    matches!(
        bundle_id,
        "com.apple.safari"
            | "com.google.chrome"
            | "com.google.chrome.canary"
            | "com.microsoft.edgemac"
            | "org.mozilla.firefox"
            | "company.thebrowser.browser"
            | "com.brave.browser"
    )
}

#[cfg(target_os = "macos")]
fn read_environment() -> MeetingEnvironment {
    // End-to-end UI tests run on Macs that may not have an input device. Keep
    // the override debug-only so release builds always use the native signal.
    #[cfg(debug_assertions)]
    match std::env::var("KUKU_MEETING_TEST_MEETING_ENVIRONMENT")
        .ok()
        .as_deref()
    {
        Some("google-meet") => {
            return MeetingEnvironment {
                microphone_active: true,
                bundle_id: "com.google.Chrome".into(),
                app_name: "Google Chrome".into(),
                window_title: "Meet - kuku-meeting-e2e".into(),
                window_id: Some(42),
            };
        }
        Some("zoom") => {
            return MeetingEnvironment {
                microphone_active: true,
                bundle_id: "us.zoom.xos".into(),
                app_name: "zoom.us".into(),
                window_title: "Zoom Meeting".into(),
                window_id: Some(43),
            };
        }
        _ => {}
    }

    use std::ffi::CStr;
    use std::os::raw::{c_char, c_int};

    unsafe extern "C" {
        fn kuku_meeting_meeting_environment(
            bundle_id: *mut c_char,
            bundle_id_length: usize,
            app_name: *mut c_char,
            app_name_length: usize,
            window_title: *mut c_char,
            window_title_length: usize,
            window_id: *mut u32,
        ) -> c_int;
    }

    fn buffer_string(buffer: &[c_char]) -> String {
        unsafe { CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    }

    let mut bundle_id = [0 as c_char; 256];
    let mut app_name = [0 as c_char; 256];
    let mut window_title = [0 as c_char; 1024];
    let mut window_id = 0_u32;
    let microphone_active = unsafe {
        kuku_meeting_meeting_environment(
            bundle_id.as_mut_ptr(),
            bundle_id.len(),
            app_name.as_mut_ptr(),
            app_name.len(),
            window_title.as_mut_ptr(),
            window_title.len(),
            &mut window_id,
        ) == 1
    };
    MeetingEnvironment {
        microphone_active,
        bundle_id: buffer_string(&bundle_id),
        app_name: buffer_string(&app_name),
        window_title: buffer_string(&window_title),
        window_id: (window_id != 0).then_some(window_id),
    }
}

#[tauri::command]
pub fn meeting_notes_detection_status(
    controller: tauri::State<'_, MeetingDetectionController>,
) -> MeetingDetectionSnapshot {
    controller.status()
}

#[tauri::command]
pub fn meeting_notes_detection_capture_target(
    controller: tauri::State<'_, MeetingDetectionController>,
) -> Option<MeetingCaptureTarget> {
    controller.capture_target()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment(bundle_id: &str, title: &str, microphone_active: bool) -> MeetingEnvironment {
        MeetingEnvironment {
            microphone_active,
            bundle_id: bundle_id.into(),
            app_name: "App".into(),
            window_title: title.into(),
            window_id: Some(42),
        }
    }

    fn zoom() -> MeetingCandidate {
        MeetingCandidate {
            bundle_id: "us.zoom.xos".into(),
            app_name: "Zoom".into(),
            window_id: Some(42),
        }
    }

    #[test]
    fn requires_a_live_microphone_for_desktop_meeting_apps() {
        assert_eq!(
            classify_environment(&environment("us.zoom.xos", "", false)),
            None
        );
        assert_eq!(
            classify_environment(&environment("us.zoom.xos", "", true)),
            Some(zoom())
        );
    }

    #[test]
    fn recognizes_supported_browser_meetings_but_not_ordinary_tabs() {
        let meet = classify_environment(&environment(
            "com.google.Chrome",
            "Weekly sync - Google Meet",
            true,
        ));
        assert_eq!(
            meet.map(|candidate| candidate.app_name),
            Some("Google Meet".into())
        );
        assert_eq!(
            classify_environment(&environment(
                "com.google.Chrome",
                "Inbox (12) - Example Mail",
                true,
            )),
            None
        );

        let mut missing_window =
            environment("com.google.Chrome", "Weekly sync - Google Meet", true);
        missing_window.window_id = None;
        assert_eq!(classify_environment(&missing_window), None);
    }

    #[test]
    fn recognizes_the_live_google_meet_window_title() {
        let meet = classify_environment(&environment(
            "com.google.Chrome",
            "Meet - abc-defg-hij",
            true,
        ));
        assert_eq!(
            meet.map(|candidate| (candidate.app_name, candidate.window_id)),
            Some(("Google Meet".into(), Some(42)))
        );
        assert_eq!(
            classify_environment(&environment("com.google.Chrome", "Meet the team", true)),
            None
        );
    }

    #[test]
    fn ignores_unsupported_apps_even_when_the_microphone_is_running() {
        assert_eq!(
            classify_environment(&environment("com.apple.VoiceMemos", "Recording", true)),
            None
        );
    }

    #[test]
    fn waits_for_three_stable_samples_before_announcing() {
        let mut debouncer = DetectionDebouncer::default();
        assert_eq!(debouncer.observe(Some(zoom())), None);
        assert_eq!(debouncer.observe(Some(zoom())), None);
        assert_eq!(
            debouncer.observe(Some(zoom())),
            Some(DetectionTransition::Detected(zoom()))
        );
    }

    #[test]
    fn changing_candidate_resets_the_confirmation_count() {
        let mut debouncer = DetectionDebouncer::default();
        let teams = MeetingCandidate {
            bundle_id: "com.microsoft.teams2".into(),
            app_name: "Microsoft Teams".into(),
            window_id: Some(73),
        };
        assert_eq!(debouncer.observe(Some(zoom())), None);
        assert_eq!(debouncer.observe(Some(zoom())), None);
        assert_eq!(debouncer.observe(Some(teams.clone())), None);
        assert_eq!(debouncer.observe(Some(teams.clone())), None);
        assert_eq!(
            debouncer.observe(Some(teams.clone())),
            Some(DetectionTransition::Detected(teams))
        );
    }

    #[test]
    fn does_not_announce_twice_during_the_same_meeting() {
        let mut debouncer = DetectionDebouncer::default();
        for _ in 0..REQUIRED_MATCHES - 1 {
            assert_eq!(debouncer.observe(Some(zoom())), None);
        }
        assert!(matches!(
            debouncer.observe(Some(zoom())),
            Some(DetectionTransition::Detected(_))
        ));
        for _ in 0..100 {
            assert_eq!(debouncer.observe(Some(zoom())), None);
        }
    }

    #[test]
    fn short_signal_gaps_do_not_rearm_the_prompt() {
        let mut debouncer = DetectionDebouncer::default();
        for _ in 0..REQUIRED_MATCHES {
            debouncer.observe(Some(zoom()));
        }
        for _ in 0..REQUIRED_MISSES_TO_REARM - 1 {
            assert_eq!(debouncer.observe(None), None);
        }
        assert_eq!(debouncer.observe(Some(zoom())), None);
    }

    #[test]
    fn sustained_absence_clears_and_allows_a_later_meeting() {
        let mut debouncer = DetectionDebouncer::default();
        for _ in 0..REQUIRED_MATCHES {
            debouncer.observe(Some(zoom()));
        }
        for _ in 0..REQUIRED_MISSES_TO_REARM - 1 {
            assert_eq!(debouncer.observe(None), None);
        }
        assert_eq!(debouncer.observe(None), Some(DetectionTransition::Cleared));
        for _ in 0..REQUIRED_MATCHES - 1 {
            assert_eq!(debouncer.observe(Some(zoom())), None);
        }
        assert!(matches!(
            debouncer.observe(Some(zoom())),
            Some(DetectionTransition::Detected(_))
        ));
    }

    #[test]
    fn capture_target_requires_a_confirmed_matching_live_candidate() {
        let confirmed = MeetingDetectionSnapshot {
            available: true,
            detected: true,
            app_name: Some("Zoom".into()),
            bundle_id: Some("us.zoom.xos".into()),
            window_id: Some(42),
        };

        assert_eq!(
            confirmed_capture_target(
                &confirmed,
                Some(zoom()),
                REQUIRED_MATCHES,
                Duration::from_secs(1),
            ),
            Some(MeetingCaptureTarget {
                bundle_id: "us.zoom.xos".into(),
                window_id: Some(42),
            })
        );
        assert_eq!(
            confirmed_capture_target(&confirmed, None, REQUIRED_MATCHES, Duration::from_secs(1),),
            None
        );
        let mut different_window = zoom();
        different_window.window_id = Some(73);
        assert_eq!(
            confirmed_capture_target(
                &confirmed,
                Some(different_window),
                REQUIRED_MATCHES,
                Duration::from_secs(1),
            ),
            None
        );
        assert_eq!(
            confirmed_capture_target(
                &confirmed,
                Some(MeetingCandidate {
                    bundle_id: "com.microsoft.teams2".into(),
                    app_name: "Microsoft Teams".into(),
                    window_id: Some(73),
                }),
                REQUIRED_MATCHES,
                Duration::from_secs(1),
            ),
            None
        );
        assert_eq!(
            confirmed_capture_target(
                &confirmed,
                Some(zoom()),
                REQUIRED_MATCHES,
                CAPTURE_TARGET_FRESHNESS + Duration::from_millis(1),
            ),
            None
        );
        assert_eq!(
            confirmed_capture_target(
                &confirmed,
                Some(zoom()),
                REQUIRED_MATCHES - 1,
                Duration::from_secs(1),
            ),
            None
        );
    }

    #[test]
    fn capture_target_streak_requires_recent_consecutive_observations() {
        let started = Instant::now();
        let mut recent = RecentCandidate::default();
        recent.observe(&zoom(), started);
        recent.observe(&zoom(), started + POLL_INTERVAL);
        recent.observe(&zoom(), started + POLL_INTERVAL + POLL_INTERVAL);
        assert_eq!(recent.matches, REQUIRED_MATCHES);

        recent.observe(
            &zoom(),
            started
                + POLL_INTERVAL
                + POLL_INTERVAL
                + CAPTURE_TARGET_SAMPLE_GAP
                + Duration::from_millis(1),
        );
        assert_eq!(recent.matches, 1);

        recent.observe(
            &MeetingCandidate {
                bundle_id: "com.microsoft.teams2".into(),
                app_name: "Microsoft Teams".into(),
                window_id: Some(73),
            },
            started + Duration::from_secs(20),
        );
        assert_eq!(recent.matches, 1);
    }

    #[test]
    fn capture_target_rejects_stale_or_incomplete_snapshots() {
        let cleared = MeetingDetectionSnapshot {
            available: true,
            detected: false,
            app_name: None,
            bundle_id: None,
            window_id: None,
        };
        assert_eq!(
            confirmed_capture_target(&cleared, Some(zoom()), REQUIRED_MATCHES, Duration::ZERO,),
            None
        );

        let missing_bundle = MeetingDetectionSnapshot {
            available: true,
            detected: true,
            app_name: Some("Zoom".into()),
            bundle_id: None,
            window_id: Some(42),
        };
        assert_eq!(
            confirmed_capture_target(
                &missing_bundle,
                Some(zoom()),
                REQUIRED_MATCHES,
                Duration::ZERO,
            ),
            None
        );
    }

    #[test]
    fn capture_target_serializes_window_id_as_a_separate_camel_case_number() {
        let value = serde_json::to_value(MeetingCaptureTarget {
            bundle_id: "com.google.Chrome".into(),
            window_id: Some(u32::MAX),
        })
        .expect("serialize capture target");
        assert_eq!(value["bundleId"], "com.google.Chrome");
        assert_eq!(value["windowId"], u64::from(u32::MAX));
    }
}
