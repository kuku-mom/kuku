use crate::search::SearchState;
use crate::vault::watcher::{ExpectedMutationLedger, ExpectedMutationToken};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AppMutation {
    Write {
        path: String,
        is_dir: bool,
    },
    Delete {
        path: String,
        is_dir: bool,
    },
    Rename {
        old_path: String,
        new_path: String,
        is_dir: bool,
    },
}

pub struct AppMutationSync<'a> {
    ledger: &'a ExpectedMutationLedger,
    search: &'a SearchState,
}

#[derive(Debug)]
pub struct RecordedAppMutation {
    mutation: AppMutation,
    token: Option<ExpectedMutationToken>,
}

impl<'a> AppMutationSync<'a> {
    pub fn new(ledger: &'a ExpectedMutationLedger, search: &'a SearchState) -> Self {
        Self { ledger, search }
    }

    pub fn record(&self, mutation: AppMutation) -> RecordedAppMutation {
        let token = match &mutation {
            AppMutation::Write { path, is_dir } => Some(self.ledger.record_write(path, *is_dir)),
            AppMutation::Delete { path, is_dir } => Some(self.ledger.record_delete(path, *is_dir)),
            AppMutation::Rename {
                old_path,
                new_path,
                is_dir,
            } => Some(self.ledger.record_rename(old_path, new_path, *is_dir)),
        };

        RecordedAppMutation { mutation, token }
    }

    pub fn cancel(&self, recorded: &RecordedAppMutation) {
        if let Some(token) = recorded.token {
            self.ledger.cancel(token);
        }
    }

    pub fn notify_applied(&self, recorded: &RecordedAppMutation) -> Result<(), String> {
        match &recorded.mutation {
            AppMutation::Write { path, is_dir } => {
                if *is_dir {
                    Ok(())
                } else {
                    self.search.notify_written(path)
                }
            }
            AppMutation::Delete { path, is_dir } => self.search.notify_removed(path, *is_dir),
            AppMutation::Rename {
                old_path,
                new_path,
                is_dir,
            } => self.search.notify_renamed(old_path, new_path, *is_dir),
        }
    }
}
