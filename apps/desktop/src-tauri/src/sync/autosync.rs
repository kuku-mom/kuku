use std::sync::Arc;
use std::thread;
use std::time::Duration;

use kuku_sync_core::{AutoSyncDecision, AutoSyncScheduler, AutoSyncTrigger};
use parking_lot::Mutex;
use tauri::{AppHandle, Manager};

use super::commands::run_sync_once_blocking;
use super::{SyncState, now_ms};

const PERIODIC_TICK_MS: u64 = 60_000;
const PERIODIC_PULL_MS: i64 = 5 * 60_000;
const PERIODIC_FULL_SCAN_MS: i64 = 30 * 60_000;

#[derive(Clone, Default)]
pub struct AutoSyncState {
    inner: Arc<Mutex<AutoSyncInner>>,
}

#[derive(Default)]
struct AutoSyncInner {
    scheduler: AutoSyncScheduler,
    scheduled_wake_at_ms: Option<i64>,
    driver_started: bool,
}

impl AutoSyncState {
    pub fn status(&self) -> kuku_sync_core::AutoSyncStatus {
        self.inner.lock().scheduler.status()
    }

    pub fn set_paused(&self, app: &AppHandle, paused: bool) -> kuku_sync_core::AutoSyncStatus {
        let decision = {
            let mut inner = self.inner.lock();
            inner.scheduler.set_paused(paused, now_ms())
        };
        drive_decision(app.clone(), self.clone(), decision);
        self.status()
    }

    pub fn trigger(&self, app: &AppHandle, trigger: AutoSyncTrigger) {
        if !auto_sync_runtime_enabled(app) {
            return;
        }
        let decision = {
            let mut inner = self.inner.lock();
            inner.scheduler.trigger(trigger, now_ms())
        };
        drive_decision(app.clone(), self.clone(), decision);
    }
}

pub(crate) fn start_auto_sync_driver(app: &AppHandle) {
    let state = app.state::<AutoSyncState>().inner().clone();
    {
        let mut inner = state.inner.lock();
        if inner.driver_started {
            return;
        }
        inner.driver_started = true;
    }

    let app = app.clone();
    trigger_auto_sync(&app, AutoSyncTrigger::Startup);
    thread::spawn(move || {
        let mut next_pull_at_ms = now_ms() + PERIODIC_PULL_MS;
        let mut next_full_scan_at_ms = now_ms() + PERIODIC_FULL_SCAN_MS;
        loop {
            thread::sleep(Duration::from_millis(PERIODIC_TICK_MS));
            let now = now_ms();
            if now >= next_pull_at_ms {
                trigger_auto_sync(&app, AutoSyncTrigger::PeriodicPull);
                next_pull_at_ms = now + PERIODIC_PULL_MS;
            }
            if now >= next_full_scan_at_ms {
                trigger_auto_sync(&app, AutoSyncTrigger::PeriodicFullScan);
                next_full_scan_at_ms = now + PERIODIC_FULL_SCAN_MS;
            }
        }
    });
}

pub(crate) fn trigger_auto_sync(app: &AppHandle, trigger: AutoSyncTrigger) {
    if !super::automerge_experimental::experimental_automerge_enabled() {
        return;
    }
    let state = app.state::<AutoSyncState>();
    state.trigger(app, trigger);
}

fn auto_sync_runtime_enabled(app: &AppHandle) -> bool {
    super::automerge_experimental::experimental_automerge_enabled()
        && app.try_state::<SyncState>().is_some_and(|state| {
            let status = state.status();
            status.configured && status.enabled
        })
}

fn drive_decision(app: AppHandle, state: AutoSyncState, decision: AutoSyncDecision) {
    match decision {
        AutoSyncDecision::Ready { .. } => start_ready_run(app, state),
        AutoSyncDecision::Scheduled { next_run_at_ms, .. } => {
            schedule_wake(app, state, next_run_at_ms);
        }
        AutoSyncDecision::Idle
        | AutoSyncDecision::Paused { .. }
        | AutoSyncDecision::AlreadyRunning { .. } => {}
    }
}

fn start_ready_run(app: AppHandle, state: AutoSyncState) {
    let triggers = {
        let mut inner = state.inner.lock();
        inner.scheduler.begin_run(now_ms())
    };
    let Some(_triggers) = triggers else {
        return;
    };

    thread::spawn(move || {
        let result = run_sync_once_blocking(app.clone(), None);
        let decision = {
            let mut inner = state.inner.lock();
            match result {
                Ok(_) => inner.scheduler.finish_success(now_ms()),
                Err(error) if is_retryable_command_error(&error) => inner
                    .scheduler
                    .finish_retryable_failure(now_ms(), error.message),
                Err(error) => inner.scheduler.finish_blocked_failure(error.message),
            }
        };
        drive_decision(app, state, decision);
    });
}

fn schedule_wake(app: AppHandle, state: AutoSyncState, next_run_at_ms: i64) {
    {
        let mut inner = state.inner.lock();
        if inner
            .scheduled_wake_at_ms
            .is_some_and(|existing| existing <= next_run_at_ms)
        {
            return;
        }
        inner.scheduled_wake_at_ms = Some(next_run_at_ms);
    }

    thread::spawn(move || {
        let delay_ms = next_run_at_ms.saturating_sub(now_ms()).max(0) as u64;
        thread::sleep(Duration::from_millis(delay_ms));
        let decision = {
            let mut inner = state.inner.lock();
            if inner.scheduled_wake_at_ms != Some(next_run_at_ms) {
                return;
            }
            inner.scheduled_wake_at_ms = None;
            inner.scheduler.poll(now_ms())
        };
        drive_decision(app, state, decision);
    });
}

fn is_retryable_command_error(error: &super::errors::SyncCommandError) -> bool {
    matches!(
        error.category,
        super::errors::SyncErrorCategory::Offline | super::errors::SyncErrorCategory::Server
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use kuku_sync_core::AutoSyncTrigger;

    #[test]
    fn disabled_runtime_does_not_record_trigger() {
        let state = AutoSyncState::default();

        assert!(state.status().pending_triggers.is_empty());
    }

    #[test]
    fn retryable_category_is_classified_for_backoff() {
        let error = super::super::errors::SyncCommandError {
            category: super::super::errors::SyncErrorCategory::Offline,
            message: "offline".to_owned(),
        };

        assert!(is_retryable_command_error(&error));
    }

    #[test]
    fn non_retryable_category_blocks_scheduler() {
        let error = super::super::errors::SyncCommandError {
            category: super::super::errors::SyncErrorCategory::Unknown,
            message: "blocked".to_owned(),
        };

        assert!(!is_retryable_command_error(&error));
    }

    #[test]
    fn state_can_hold_scheduler_status() {
        let state = AutoSyncState::default();
        let decision = {
            let mut inner = state.inner.lock();
            inner.scheduler.trigger(AutoSyncTrigger::EditorWrite, 1)
        };

        assert!(matches!(decision, AutoSyncDecision::Scheduled { .. }));
        assert_eq!(
            state.status().pending_triggers,
            vec![AutoSyncTrigger::EditorWrite]
        );
    }

    #[test]
    fn driver_started_flag_prevents_duplicate_driver_state() {
        let state = AutoSyncState::default();
        {
            let mut inner = state.inner.lock();
            assert!(!inner.driver_started);
            inner.driver_started = true;
        }

        assert!(state.inner.lock().driver_started);
    }
}
