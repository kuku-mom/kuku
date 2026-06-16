use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoSyncTrigger {
    Startup,
    VaultOpen,
    EditorWrite,
    AiWrite,
    FilesystemCreateOrModify,
    FilesystemDelete,
    NetworkReconnect,
    PeriodicPull,
    PeriodicFullScan,
    RemotePoke,
    BackgroundFlush,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoSyncPolicy {
    pub debounce_ms: i64,
    pub delete_grace_ms: i64,
    pub initial_backoff_ms: i64,
    pub max_backoff_ms: i64,
}

impl Default for AutoSyncPolicy {
    fn default() -> Self {
        Self {
            debounce_ms: 1_000,
            delete_grace_ms: 30_000,
            initial_backoff_ms: 1_000,
            max_backoff_ms: 60_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoSyncStatus {
    pub paused: bool,
    pub active: bool,
    pub run_requested: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at_ms: Option<i64>,
    #[serde(default)]
    pub pending_triggers: Vec<AutoSyncTrigger>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_success_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub backoff_attempt: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AutoSyncDecision {
    Idle,
    Paused {
        pending_triggers: Vec<AutoSyncTrigger>,
    },
    AlreadyRunning {
        run_requested: bool,
        pending_triggers: Vec<AutoSyncTrigger>,
    },
    Scheduled {
        next_run_at_ms: i64,
        pending_triggers: Vec<AutoSyncTrigger>,
    },
    Ready {
        triggers: Vec<AutoSyncTrigger>,
    },
}

#[derive(Debug, Clone)]
pub struct AutoSyncScheduler {
    policy: AutoSyncPolicy,
    paused: bool,
    active: bool,
    pending: BTreeSet<AutoSyncTrigger>,
    running: BTreeSet<AutoSyncTrigger>,
    next_run_at_ms: Option<i64>,
    last_success_at_ms: Option<i64>,
    last_error: Option<String>,
    backoff_attempt: u32,
}

impl AutoSyncScheduler {
    pub fn new(policy: AutoSyncPolicy) -> Self {
        Self {
            policy,
            paused: false,
            active: false,
            pending: BTreeSet::new(),
            running: BTreeSet::new(),
            next_run_at_ms: None,
            last_success_at_ms: None,
            last_error: None,
            backoff_attempt: 0,
        }
    }

    pub fn status(&self) -> AutoSyncStatus {
        AutoSyncStatus {
            paused: self.paused,
            active: self.active,
            run_requested: self.active && !self.pending.is_empty(),
            next_run_at_ms: self.next_run_at_ms,
            pending_triggers: self.pending.iter().copied().collect(),
            last_success_at_ms: self.last_success_at_ms,
            last_error: self.last_error.clone(),
            backoff_attempt: self.backoff_attempt,
        }
    }

    pub fn set_paused(&mut self, paused: bool, now_ms: i64) -> AutoSyncDecision {
        self.paused = paused;
        if paused {
            return AutoSyncDecision::Paused {
                pending_triggers: self.pending.iter().copied().collect(),
            };
        }
        if !self.pending.is_empty() && self.next_run_at_ms.is_none() {
            self.next_run_at_ms = Some(now_ms);
        }
        self.poll(now_ms)
    }

    pub fn trigger(&mut self, trigger: AutoSyncTrigger, now_ms: i64) -> AutoSyncDecision {
        self.pending.insert(trigger);
        let candidate = now_ms + trigger_delay_ms(trigger, &self.policy);
        self.next_run_at_ms = Some(match self.next_run_at_ms {
            Some(existing) => existing.min(candidate),
            None => candidate,
        });
        self.poll(now_ms)
    }

    pub fn poll(&self, now_ms: i64) -> AutoSyncDecision {
        if self.paused {
            return AutoSyncDecision::Paused {
                pending_triggers: self.pending.iter().copied().collect(),
            };
        }
        if self.active {
            return AutoSyncDecision::AlreadyRunning {
                run_requested: !self.pending.is_empty(),
                pending_triggers: self.pending.iter().copied().collect(),
            };
        }
        if self.pending.is_empty() {
            return AutoSyncDecision::Idle;
        }
        let Some(next_run_at_ms) = self.next_run_at_ms else {
            return AutoSyncDecision::Ready {
                triggers: self.pending.iter().copied().collect(),
            };
        };
        if next_run_at_ms <= now_ms {
            AutoSyncDecision::Ready {
                triggers: self.pending.iter().copied().collect(),
            }
        } else {
            AutoSyncDecision::Scheduled {
                next_run_at_ms,
                pending_triggers: self.pending.iter().copied().collect(),
            }
        }
    }

    pub fn begin_run(&mut self, now_ms: i64) -> Option<Vec<AutoSyncTrigger>> {
        if !matches!(self.poll(now_ms), AutoSyncDecision::Ready { .. }) {
            return None;
        }
        self.active = true;
        self.next_run_at_ms = None;
        self.running = std::mem::take(&mut self.pending);
        Some(self.running.iter().copied().collect())
    }

    pub fn finish_success(&mut self, now_ms: i64) -> AutoSyncDecision {
        self.active = false;
        self.running.clear();
        self.last_success_at_ms = Some(now_ms);
        self.last_error = None;
        self.backoff_attempt = 0;
        if !self.pending.is_empty() && self.next_run_at_ms.is_none() {
            self.next_run_at_ms = Some(now_ms);
        }
        self.poll(now_ms)
    }

    pub fn finish_retryable_failure(
        &mut self,
        now_ms: i64,
        message: impl Into<String>,
    ) -> AutoSyncDecision {
        self.active = false;
        self.pending.append(&mut self.running);
        self.last_error = Some(message.into());
        self.backoff_attempt = self.backoff_attempt.saturating_add(1);
        self.next_run_at_ms = Some(now_ms + self.backoff_delay_ms());
        self.poll(now_ms)
    }

    pub fn finish_blocked_failure(&mut self, message: impl Into<String>) -> AutoSyncDecision {
        self.active = false;
        self.pending.append(&mut self.running);
        self.last_error = Some(message.into());
        self.next_run_at_ms = None;
        AutoSyncDecision::Idle
    }

    fn backoff_delay_ms(&self) -> i64 {
        let shift = self.backoff_attempt.saturating_sub(1).min(30);
        let multiplier = 1_i64.checked_shl(shift).unwrap_or(i64::MAX);
        self.policy
            .initial_backoff_ms
            .saturating_mul(multiplier)
            .min(self.policy.max_backoff_ms)
            .max(0)
    }
}

impl Default for AutoSyncScheduler {
    fn default() -> Self {
        Self::new(AutoSyncPolicy::default())
    }
}

fn trigger_delay_ms(trigger: AutoSyncTrigger, policy: &AutoSyncPolicy) -> i64 {
    match trigger {
        AutoSyncTrigger::FilesystemDelete => policy.delete_grace_ms.max(0),
        AutoSyncTrigger::EditorWrite
        | AutoSyncTrigger::AiWrite
        | AutoSyncTrigger::FilesystemCreateOrModify => policy.debounce_ms.max(0),
        AutoSyncTrigger::Startup
        | AutoSyncTrigger::VaultOpen
        | AutoSyncTrigger::NetworkReconnect
        | AutoSyncTrigger::PeriodicPull
        | AutoSyncTrigger::PeriodicFullScan
        | AutoSyncTrigger::RemotePoke
        | AutoSyncTrigger::BackgroundFlush
        | AutoSyncTrigger::Manual => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> AutoSyncPolicy {
        AutoSyncPolicy {
            debounce_ms: 500,
            delete_grace_ms: 5_000,
            initial_backoff_ms: 1_000,
            max_backoff_ms: 8_000,
        }
    }

    #[test]
    fn filesystem_modify_is_debounced_until_ready() {
        let mut scheduler = AutoSyncScheduler::new(policy());

        let decision = scheduler.trigger(AutoSyncTrigger::FilesystemCreateOrModify, 1_000);

        assert_eq!(
            decision,
            AutoSyncDecision::Scheduled {
                next_run_at_ms: 1_500,
                pending_triggers: vec![AutoSyncTrigger::FilesystemCreateOrModify],
            }
        );
        assert_eq!(scheduler.begin_run(1_499), None);
        assert_eq!(
            scheduler.begin_run(1_500),
            Some(vec![AutoSyncTrigger::FilesystemCreateOrModify])
        );
    }

    #[test]
    fn filesystem_delete_uses_longer_grace_period() {
        let mut scheduler = AutoSyncScheduler::new(policy());

        let decision = scheduler.trigger(AutoSyncTrigger::FilesystemDelete, 10);

        assert_eq!(
            decision,
            AutoSyncDecision::Scheduled {
                next_run_at_ms: 5_010,
                pending_triggers: vec![AutoSyncTrigger::FilesystemDelete],
            }
        );
    }

    #[test]
    fn trigger_while_active_requests_follow_up_run() {
        let mut scheduler = AutoSyncScheduler::new(policy());
        scheduler.trigger(AutoSyncTrigger::Manual, 0);
        assert_eq!(scheduler.begin_run(0), Some(vec![AutoSyncTrigger::Manual]));

        let decision = scheduler.trigger(AutoSyncTrigger::RemotePoke, 1);

        assert_eq!(
            decision,
            AutoSyncDecision::AlreadyRunning {
                run_requested: true,
                pending_triggers: vec![AutoSyncTrigger::RemotePoke],
            }
        );
        assert_eq!(
            scheduler.finish_success(2),
            AutoSyncDecision::Ready {
                triggers: vec![AutoSyncTrigger::RemotePoke],
            }
        );
    }

    #[test]
    fn retryable_failure_schedules_exponential_backoff() {
        let mut scheduler = AutoSyncScheduler::new(policy());
        scheduler.trigger(AutoSyncTrigger::PeriodicPull, 0);
        assert_eq!(
            scheduler.begin_run(0),
            Some(vec![AutoSyncTrigger::PeriodicPull])
        );

        let first = scheduler.finish_retryable_failure(10, "offline");

        assert_eq!(
            first,
            AutoSyncDecision::Scheduled {
                next_run_at_ms: 1_010,
                pending_triggers: vec![AutoSyncTrigger::PeriodicPull],
            }
        );
        assert_eq!(scheduler.status().last_error.as_deref(), Some("offline"));
        assert_eq!(
            scheduler.begin_run(1_010),
            Some(vec![AutoSyncTrigger::PeriodicPull])
        );
        let second = scheduler.finish_retryable_failure(2_000, "still offline");
        assert_eq!(
            second,
            AutoSyncDecision::Scheduled {
                next_run_at_ms: 4_000,
                pending_triggers: vec![AutoSyncTrigger::PeriodicPull],
            }
        );
    }

    #[test]
    fn paused_scheduler_keeps_pending_without_running() {
        let mut scheduler = AutoSyncScheduler::new(policy());
        scheduler.set_paused(true, 0);

        let paused = scheduler.trigger(AutoSyncTrigger::RemotePoke, 10);

        assert_eq!(
            paused,
            AutoSyncDecision::Paused {
                pending_triggers: vec![AutoSyncTrigger::RemotePoke],
            }
        );
        assert_eq!(scheduler.begin_run(10), None);
        assert_eq!(
            scheduler.set_paused(false, 20),
            AutoSyncDecision::Ready {
                triggers: vec![AutoSyncTrigger::RemotePoke],
            }
        );
    }

    #[test]
    fn operational_triggers_are_ready_immediately() {
        for trigger in [
            AutoSyncTrigger::Startup,
            AutoSyncTrigger::VaultOpen,
            AutoSyncTrigger::NetworkReconnect,
            AutoSyncTrigger::PeriodicPull,
            AutoSyncTrigger::PeriodicFullScan,
            AutoSyncTrigger::RemotePoke,
            AutoSyncTrigger::BackgroundFlush,
            AutoSyncTrigger::Manual,
        ] {
            let mut scheduler = AutoSyncScheduler::new(policy());

            assert_eq!(
                scheduler.trigger(trigger, 42),
                AutoSyncDecision::Ready {
                    triggers: vec![trigger],
                }
            );
        }
    }

    #[test]
    fn blocked_failure_retains_pending_without_auto_retry() {
        let mut scheduler = AutoSyncScheduler::new(policy());
        scheduler.trigger(AutoSyncTrigger::BackgroundFlush, 0);
        assert_eq!(
            scheduler.begin_run(0),
            Some(vec![AutoSyncTrigger::BackgroundFlush])
        );

        assert_eq!(
            scheduler.finish_blocked_failure("projection blocked"),
            AutoSyncDecision::Idle
        );
        assert_eq!(
            scheduler.status().pending_triggers,
            vec![AutoSyncTrigger::BackgroundFlush]
        );
        assert_eq!(scheduler.status().next_run_at_ms, None);
        assert_eq!(
            scheduler.trigger(AutoSyncTrigger::NetworkReconnect, 10),
            AutoSyncDecision::Ready {
                triggers: vec![
                    AutoSyncTrigger::NetworkReconnect,
                    AutoSyncTrigger::BackgroundFlush,
                ],
            }
        );
    }
}
