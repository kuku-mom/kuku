use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use parking_lot::RwLock;

use crate::{AgentId, AiError, PersistedAgentSession, PersistedChatSessionSnapshot};

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

    pub(crate) fn from_data_root(data_root: PathBuf) -> Self {
        Self::new(data_root.join("ai").join("sessions.json"))
    }

    pub(crate) fn list(&self) -> Vec<PersistedAgentSession> {
        sort_sessions(self.sessions.read().clone())
    }

    pub(crate) fn list_for_working_directory(
        &self,
        working_directory: Option<&str>,
    ) -> Vec<PersistedAgentSession> {
        let working_directory = normalize_working_directory(working_directory);
        sort_sessions(
            self.sessions
                .read()
                .iter()
                .filter(|session| {
                    normalize_working_directory(session.working_directory.as_deref())
                        == working_directory
                })
                .cloned()
                .collect(),
        )
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
        working_directory: Option<String>,
    ) -> Result<(), AiError> {
        self.upsert(PersistedAgentSession {
            local_session_id,
            external_session_id,
            agent_id,
            title: String::new(),
            updated_at_ms: now_ms(),
            supports_load,
            supports_resume,
            working_directory: normalize_working_directory(working_directory.as_deref()),
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

#[derive(Clone)]
pub(crate) struct ChatSessionSnapshotStore {
    path: PathBuf,
    sessions: Arc<RwLock<Vec<PersistedChatSessionSnapshot>>>,
    load_error: Arc<RwLock<Option<String>>>,
}

impl Default for ChatSessionSnapshotStore {
    fn default() -> Self {
        Self::new(default_chat_snapshot_store_path())
    }
}

impl ChatSessionSnapshotStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        let (sessions, load_error) = match read_chat_session_snapshots(&path) {
            Ok(sessions) => (sessions, None),
            Err(error) => (Vec::new(), Some(error.to_string())),
        };
        Self {
            path,
            sessions: Arc::new(RwLock::new(sessions)),
            load_error: Arc::new(RwLock::new(load_error)),
        }
    }

    pub(crate) fn from_data_root(data_root: PathBuf) -> Self {
        Self::new(data_root.join("ai").join("chat_sessions.json"))
    }

    pub(crate) fn list_for_working_directory(
        &self,
        working_directory: Option<&str>,
    ) -> Vec<PersistedChatSessionSnapshot> {
        let working_directory = normalize_working_directory(working_directory);
        sort_chat_session_snapshots(
            self.sessions
                .read()
                .iter()
                .filter(|session| {
                    normalize_working_directory(session.working_directory.as_deref())
                        == working_directory
                })
                .cloned()
                .collect(),
        )
    }

    pub(crate) fn replace_for_working_directory(
        &self,
        working_directory: Option<&str>,
        mut snapshots: Vec<PersistedChatSessionSnapshot>,
    ) -> Result<(), AiError> {
        let working_directory = normalize_working_directory(working_directory);
        {
            let mut sessions = self.sessions.write();
            sessions.retain(|session| {
                normalize_working_directory(session.working_directory.as_deref()).as_deref()
                    != working_directory.as_deref()
            });
            for snapshot in &mut snapshots {
                snapshot.working_directory = working_directory.clone();
            }
            sessions.extend(snapshots);
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
                "Failed to delete AI chat session store: {error}"
            ))),
        }
    }

    fn flush(&self) -> Result<(), AiError> {
        if let Some(error) = self.load_error.read().as_ref() {
            return Err(AiError::State(format!(
                "Refusing to overwrite unreadable AI chat session store: {error}"
            )));
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                AiError::State(format!(
                    "Failed to create AI chat session store directory: {error}"
                ))
            })?;
        }
        let json = serde_json::to_string_pretty(&*self.sessions.read()).map_err(|error| {
            AiError::State(format!("Failed to serialize AI chat sessions: {error}"))
        })?;
        fs::write(&self.path, json)
            .map_err(|error| AiError::State(format!("Failed to write AI chat sessions: {error}")))
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

fn read_chat_session_snapshots(path: &Path) -> Result<Vec<PersistedChatSessionSnapshot>, AiError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| AiError::State(format!("Failed to read AI chat sessions: {error}")))?;
    serde_json::from_str(&content)
        .map_err(|error| AiError::State(format!("Failed to parse AI chat sessions: {error}")))
}

fn sort_sessions(mut sessions: Vec<PersistedAgentSession>) -> Vec<PersistedAgentSession> {
    sessions.sort_by(|left, right| right.updated_at_ms.cmp(&left.updated_at_ms));
    sessions
}

fn sort_chat_session_snapshots(
    mut sessions: Vec<PersistedChatSessionSnapshot>,
) -> Vec<PersistedChatSessionSnapshot> {
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions
}

fn normalize_working_directory(value: Option<&str>) -> Option<String> {
    value.and_then(|directory| {
        let normalized = normalize_working_directory_path(directory);
        if normalized.is_empty() {
            None
        } else {
            Some(normalized)
        }
    })
}

fn normalize_working_directory_path(directory: &str) -> String {
    let normalized = directory.trim().replace('\\', "/");
    if normalized.is_empty() {
        return String::new();
    }

    let trimmed = trim_trailing_path_separators(&normalized);
    let path = Path::new(&trimmed);
    path.canonicalize()
        .ok()
        .and_then(|canonical| canonical.to_str().map(str::to_string))
        .unwrap_or(trimmed)
}

fn trim_trailing_path_separators(path: &str) -> String {
    if path == "/" || is_windows_drive_root(path) {
        return path.to_string();
    }
    path.trim_end_matches('/').to_string()
}

fn is_windows_drive_root(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() == 3 && bytes[1] == b':' && bytes[2] == b'/' && bytes[0].is_ascii_alphabetic()
}

fn default_store_path() -> PathBuf {
    let root = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    root.join(".kuku").join("ai").join("sessions.json")
}

fn default_chat_snapshot_store_path() -> PathBuf {
    let root = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    root.join(".kuku").join("ai").join("chat_sessions.json")
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
                None,
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
                None,
            )
            .unwrap();
        store
            .record_new_session(
                "local-2".to_string(),
                None,
                AgentId("codex-acp".to_string()),
                true,
                false,
                None,
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
    fn persisted_agent_sessions_can_be_listed_by_working_directory() {
        let path = test_store_path("working-directory");
        let store = AgentSessionStore::new(path);

        store
            .record_new_session(
                "vault-a".to_string(),
                None,
                AgentId::kuku_native(),
                false,
                false,
                Some("/Users/me/Vault A".to_string()),
            )
            .unwrap();
        store
            .record_new_session(
                "vault-b".to_string(),
                None,
                AgentId::kuku_native(),
                false,
                false,
                Some("/Users/me/Vault B".to_string()),
            )
            .unwrap();
        store
            .record_new_session(
                "no-vault".to_string(),
                None,
                AgentId::kuku_native(),
                false,
                false,
                None,
            )
            .unwrap();

        let vault_a_sessions = store.list_for_working_directory(Some("/Users/me/Vault A"));
        assert_eq!(vault_a_sessions.len(), 1);
        assert_eq!(vault_a_sessions[0].local_session_id, "vault-a");

        let no_vault_sessions = store.list_for_working_directory(None);
        assert_eq!(no_vault_sessions.len(), 1);
        assert_eq!(no_vault_sessions[0].local_session_id, "no-vault");
    }

    #[test]
    fn persisted_agent_sessions_match_equivalent_working_directory_paths() {
        let path = test_store_path("working-directory-equivalent");
        let store = AgentSessionStore::new(path);

        store
            .record_new_session(
                "vault-a".to_string(),
                None,
                AgentId::kuku_native(),
                false,
                false,
                Some("/Users/me/Vault A/".to_string()),
            )
            .unwrap();

        let vault_a_sessions = store.list_for_working_directory(Some("/Users/me/Vault A"));
        assert_eq!(vault_a_sessions.len(), 1);
        assert_eq!(vault_a_sessions[0].local_session_id, "vault-a");
        assert_eq!(
            vault_a_sessions[0].working_directory.as_deref(),
            Some("/Users/me/Vault A")
        );
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
                None,
            )
            .unwrap();
        store
            .record_new_session(
                "local-2".to_string(),
                Some("external-2".to_string()),
                AgentId("codex-acp".to_string()),
                true,
                true,
                None,
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
                None,
            )
            .unwrap_err();

        assert!(error.to_string().contains("Refusing to overwrite"));
        assert_eq!(fs::read_to_string(path).unwrap(), "{not json");
    }

    #[test]
    fn chat_session_snapshots_replace_only_the_requested_working_directory() {
        let path = test_store_path("chat-snapshots");
        let store = ChatSessionSnapshotStore::new(path.clone());

        store
            .replace_for_working_directory(
                Some("/Users/me/Vault A"),
                vec![PersistedChatSessionSnapshot {
                    id: "vault-a-1".to_string(),
                    external_session_id: None,
                    agent_id: AgentId::kuku_native(),
                    mode: crate::ChatMode::Ask,
                    created_at: 1,
                    updated_at: 1,
                    persisted_title: None,
                    supports_load: None,
                    supports_resume: None,
                    working_directory: None,
                    draft: String::new(),
                    auto_approve: false,
                    messages: vec![serde_json::json!({
                        "id": "message-1",
                        "kind": "text",
                        "role": "user",
                        "content": "vault a"
                    })],
                }],
            )
            .unwrap();
        store
            .replace_for_working_directory(
                Some("/Users/me/Vault B"),
                vec![PersistedChatSessionSnapshot {
                    id: "vault-b-1".to_string(),
                    external_session_id: None,
                    agent_id: AgentId::kuku_native(),
                    mode: crate::ChatMode::Ask,
                    created_at: 2,
                    updated_at: 2,
                    persisted_title: None,
                    supports_load: None,
                    supports_resume: None,
                    working_directory: None,
                    draft: String::new(),
                    auto_approve: false,
                    messages: Vec::new(),
                }],
            )
            .unwrap();
        store
            .replace_for_working_directory(
                Some("/Users/me/Vault A"),
                vec![PersistedChatSessionSnapshot {
                    id: "vault-a-2".to_string(),
                    external_session_id: None,
                    agent_id: AgentId::kuku_native(),
                    mode: crate::ChatMode::Agent,
                    created_at: 3,
                    updated_at: 3,
                    persisted_title: Some("new a".to_string()),
                    supports_load: Some(true),
                    supports_resume: Some(false),
                    working_directory: Some("/wrong/root".to_string()),
                    draft: "draft".to_string(),
                    auto_approve: true,
                    messages: Vec::new(),
                }],
            )
            .unwrap();

        let loaded = ChatSessionSnapshotStore::new(path);
        let vault_a = loaded.list_for_working_directory(Some("/Users/me/Vault A"));
        let vault_b = loaded.list_for_working_directory(Some("/Users/me/Vault B"));

        assert_eq!(vault_a.len(), 1);
        assert_eq!(vault_a[0].id, "vault-a-2");
        assert_eq!(
            vault_a[0].working_directory.as_deref(),
            Some("/Users/me/Vault A")
        );
        assert_eq!(vault_b.len(), 1);
        assert_eq!(vault_b[0].id, "vault-b-1");
    }

    #[test]
    fn chat_session_snapshots_match_equivalent_working_directory_paths() {
        let path = test_store_path("chat-snapshots-equivalent");
        let store = ChatSessionSnapshotStore::new(path);

        store
            .replace_for_working_directory(
                Some("/Users/me/Vault A/"),
                vec![PersistedChatSessionSnapshot {
                    id: "vault-a-1".to_string(),
                    external_session_id: None,
                    agent_id: AgentId::kuku_native(),
                    mode: crate::ChatMode::Ask,
                    created_at: 1,
                    updated_at: 1,
                    persisted_title: None,
                    supports_load: None,
                    supports_resume: None,
                    working_directory: None,
                    draft: String::new(),
                    auto_approve: false,
                    messages: Vec::new(),
                }],
            )
            .unwrap();

        let vault_a = store.list_for_working_directory(Some("/Users/me/Vault A"));
        assert_eq!(vault_a.len(), 1);
        assert_eq!(vault_a[0].id, "vault-a-1");
        assert_eq!(
            vault_a[0].working_directory.as_deref(),
            Some("/Users/me/Vault A")
        );
    }
}
