use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use parking_lot::RwLock;

use crate::{AgentId, AiError, PersistedAgentSession};

#[derive(Clone)]
pub(crate) struct AgentSessionStore {
    path: PathBuf,
    sessions: Arc<RwLock<Vec<PersistedAgentSession>>>,
    load_error: Arc<RwLock<Option<String>>>,
}

impl Default for AgentSessionStore {
    fn default() -> Self {
        Self::new(default_store_path())
    }
}

impl AgentSessionStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        let (sessions, load_error) = match read_sessions(&path) {
            Ok(sessions) => (sessions, None),
            Err(error) => (Vec::new(), Some(error.to_string())),
        };
        Self {
            path,
            sessions: Arc::new(RwLock::new(sessions)),
            load_error: Arc::new(RwLock::new(load_error)),
        }
    }

    pub(crate) fn from_data_dir(data_dir: PathBuf) -> Self {
        Self::new(data_dir.join("ai").join("sessions.json"))
    }

    pub(crate) fn list(&self) -> Vec<PersistedAgentSession> {
        let mut sessions = self.sessions.read().clone();
        sessions.sort_by(|left, right| right.updated_at_ms.cmp(&left.updated_at_ms));
        sessions
    }

    pub(crate) fn upsert(&self, session: PersistedAgentSession) -> Result<(), AiError> {
        {
            let mut sessions = self.sessions.write();
            if let Some(existing) = sessions
                .iter_mut()
                .find(|existing| existing.local_session_id == session.local_session_id)
            {
                *existing = session;
            } else {
                sessions.push(session);
            }
        }
        self.flush()
    }

    pub(crate) fn record_new_session(
        &self,
        local_session_id: String,
        external_session_id: Option<String>,
        agent_id: AgentId,
        supports_load: bool,
        supports_resume: bool,
    ) -> Result<(), AiError> {
        self.upsert(PersistedAgentSession {
            local_session_id,
            external_session_id,
            agent_id,
            title: String::new(),
            updated_at_ms: now_ms(),
            supports_load,
            supports_resume,
        })
    }

    pub(crate) fn touch_session(&self, session_id: &str, title: String) -> Result<(), AiError> {
        {
            let mut sessions = self.sessions.write();
            let Some(session) = sessions
                .iter_mut()
                .find(|session| session.local_session_id == session_id)
            else {
                return Ok(());
            };
            if session.title.is_empty() && !title.trim().is_empty() {
                session.title = title;
            }
            session.updated_at_ms = now_ms();
        }
        self.flush()
    }

    pub(crate) fn remove_session(&self, session_id: &str) -> Result<(), AiError> {
        {
            let mut sessions = self.sessions.write();
            let original_len = sessions.len();
            sessions.retain(|session| session.local_session_id != session_id);
            if sessions.len() == original_len {
                return Ok(());
            }
        }
        self.flush()
    }

    pub(crate) fn clear(&self) -> Result<(), AiError> {
        {
            self.sessions.write().clear();
            *self.load_error.write() = None;
        }
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AiError::State(format!(
                "Failed to delete AI session store: {error}"
            ))),
        }
    }

    fn flush(&self) -> Result<(), AiError> {
        if let Some(error) = self.load_error.read().as_ref() {
            return Err(AiError::State(format!(
                "Refusing to overwrite unreadable AI session store: {error}"
            )));
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                AiError::State(format!(
                    "Failed to create AI session store directory: {error}"
                ))
            })?;
        }
        let json = serde_json::to_string_pretty(&*self.sessions.read())
            .map_err(|error| AiError::State(format!("Failed to serialize AI sessions: {error}")))?;
        fs::write(&self.path, json)
            .map_err(|error| AiError::State(format!("Failed to write AI sessions: {error}")))
    }
}

fn read_sessions(path: &Path) -> Result<Vec<PersistedAgentSession>, AiError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| AiError::State(format!("Failed to read AI sessions: {error}")))?;
    serde_json::from_str(&content)
        .map_err(|error| AiError::State(format!("Failed to parse AI sessions: {error}")))
}

fn default_store_path() -> PathBuf {
    let root = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    root.join(".kuku").join("ai").join("sessions.json")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("kuku-ai-{name}-{}.json", uuid::Uuid::new_v4()))
    }

    #[test]
    fn persisted_agent_session_round_trips_to_disk() {
        let path = test_store_path("round-trip");
        let store = AgentSessionStore::new(path.clone());

        store
            .record_new_session(
                "local-1".to_string(),
                Some("external-1".to_string()),
                AgentId("codex-acp".to_string()),
                true,
                false,
            )
            .unwrap();

        let loaded = AgentSessionStore::new(path);
        let sessions = loaded.list();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].local_session_id, "local-1");
        assert_eq!(
            sessions[0].external_session_id.as_deref(),
            Some("external-1")
        );
        assert_eq!(sessions[0].agent_id.0, "codex-acp");
        assert!(sessions[0].supports_load);
        assert!(!sessions[0].supports_resume);
    }

    #[test]
    fn persisted_agent_session_touch_sets_title_once_and_sorts_newest_first() {
        let path = test_store_path("touch");
        let store = AgentSessionStore::new(path);

        store
            .record_new_session(
                "local-1".to_string(),
                None,
                AgentId::kuku_native(),
                false,
                false,
            )
            .unwrap();
        store
            .record_new_session(
                "local-2".to_string(),
                None,
                AgentId("codex-acp".to_string()),
                true,
                false,
            )
            .unwrap();
        store
            .touch_session("local-1", "Summarize workspace".to_string())
            .unwrap();

        let sessions = store.list();
        assert_eq!(sessions[0].local_session_id, "local-1");
        assert_eq!(sessions[0].title, "Summarize workspace");
    }

    #[test]
    fn persisted_agent_session_remove_deletes_matching_session_from_disk() {
        let path = test_store_path("remove");
        let store = AgentSessionStore::new(path.clone());

        store
            .record_new_session(
                "local-1".to_string(),
                None,
                AgentId::kuku_native(),
                false,
                false,
            )
            .unwrap();
        store
            .record_new_session(
                "local-2".to_string(),
                Some("external-2".to_string()),
                AgentId("codex-acp".to_string()),
                true,
                true,
            )
            .unwrap();

        store.remove_session("local-2").unwrap();

        let loaded = AgentSessionStore::new(path);
        let sessions = loaded.list();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].local_session_id, "local-1");
    }

    #[test]
    fn persisted_agent_session_store_refuses_to_overwrite_corrupt_file() {
        let path = test_store_path("corrupt");
        fs::write(&path, "{not json").unwrap();
        let store = AgentSessionStore::new(path.clone());

        let error = store
            .record_new_session(
                "local-1".to_string(),
                None,
                AgentId::kuku_native(),
                false,
                false,
            )
            .unwrap_err();

        assert!(error.to_string().contains("Refusing to overwrite"));
        assert_eq!(fs::read_to_string(path).unwrap(), "{not json");
    }
}
