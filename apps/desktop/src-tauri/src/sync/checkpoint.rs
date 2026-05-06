#![allow(dead_code)]

use super::errors::SyncResult;
use super::planner::{PlannerConfig, SyncPlan, plan_checkpoint};
use super::scanner::ScannedFile;

pub const CHECKPOINT_COMMIT_INTERVAL: i64 = 100;
pub const CHECKPOINT_INCREMENTAL_BYTES_INTERVAL: i64 = 64 * 1024 * 1024;
pub const CHECKPOINT_WALL_CLOCK_INTERVAL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckpointTriggerInput {
    pub commits_since_checkpoint: i64,
    pub incremental_encrypted_bytes_since_checkpoint: i64,
    pub now_ms: i64,
    pub last_checkpoint_at_ms: Option<i64>,
    pub force: bool,
}

pub fn should_create_checkpoint(input: CheckpointTriggerInput) -> bool {
    if input.force {
        return true;
    }
    if input.commits_since_checkpoint >= CHECKPOINT_COMMIT_INTERVAL {
        return true;
    }
    if input.incremental_encrypted_bytes_since_checkpoint >= CHECKPOINT_INCREMENTAL_BYTES_INTERVAL {
        return true;
    }
    input
        .last_checkpoint_at_ms
        .is_some_and(|last| input.now_ms.saturating_sub(last) >= CHECKPOINT_WALL_CLOCK_INTERVAL_MS)
}

pub fn plan_initial_checkpoint(
    scanned_files: &[ScannedFile],
    config: &PlannerConfig,
) -> SyncResult<SyncPlan> {
    plan_checkpoint(scanned_files, config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_trigger_uses_count_bytes_time_or_force() {
        assert!(should_create_checkpoint(CheckpointTriggerInput {
            commits_since_checkpoint: CHECKPOINT_COMMIT_INTERVAL,
            incremental_encrypted_bytes_since_checkpoint: 0,
            now_ms: 0,
            last_checkpoint_at_ms: None,
            force: false,
        }));
        assert!(should_create_checkpoint(CheckpointTriggerInput {
            commits_since_checkpoint: 0,
            incremental_encrypted_bytes_since_checkpoint: CHECKPOINT_INCREMENTAL_BYTES_INTERVAL,
            now_ms: 0,
            last_checkpoint_at_ms: None,
            force: false,
        }));
        assert!(should_create_checkpoint(CheckpointTriggerInput {
            commits_since_checkpoint: 0,
            incremental_encrypted_bytes_since_checkpoint: 0,
            now_ms: CHECKPOINT_WALL_CLOCK_INTERVAL_MS,
            last_checkpoint_at_ms: Some(0),
            force: false,
        }));
        assert!(should_create_checkpoint(CheckpointTriggerInput {
            commits_since_checkpoint: 0,
            incremental_encrypted_bytes_since_checkpoint: 0,
            now_ms: 0,
            last_checkpoint_at_ms: None,
            force: true,
        }));
    }
}
