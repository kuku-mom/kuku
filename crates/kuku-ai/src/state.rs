use std::{collections::HashMap, sync::Arc};

use parking_lot::RwLock;
use tokio::sync::oneshot;

use crate::{
    AiConfig, AiError, AiHostBindings, AiNativeTool,
    agent_runtime::{
        AgentRuntime,
        acp::{AcpAgentRuntime, AcpSessionHandle},
        native::NativeAgentRuntime,
        store::{AgentSessionStore, ChatSessionSnapshotStore},
    },
    provider::{CompletionBackend, gemini::GeminiBackend, remote::RemoteBackend},
    session::{ApprovalDecision, SessionRuntime},
    tools::{ProxyBroker, ProxyToolDescriptor, ToolDescriptor, ToolRegistry},
    types::{
        AgentDescriptor, AgentId, AgentKind, ChatMessage, ChatMode, ExternalAgentConfig,
        PersistedChatSessionSnapshot, ProviderKind,
    },
};

struct AiStateInner {
    config: RwLock<AiConfig>,
    provider: RwLock<Option<Arc<dyn CompletionBackend>>>,
    sessions: RwLock<HashMap<String, Arc<SessionRuntime>>>,
    acp_sessions: RwLock<HashMap<String, AcpSessionHandle>>,
    acp_approvals: RwLock<HashMap<(String, String), oneshot::Sender<ApprovalDecision>>>,
    session_store: AgentSessionStore,
    chat_session_store: ChatSessionSnapshotStore,
    tools: ToolRegistry,
    proxy_broker: ProxyBroker,
    host: RwLock<Option<Arc<dyn AiHostBindings>>>,
}

#[derive(Clone)]
pub struct AiState {
    inner: Arc<AiStateInner>,
}

impl Default for AiState {
    fn default() -> Self {
        let config = AiConfig::default();
        Self {
            inner: Arc::new(AiStateInner {
                config: RwLock::new(config),
                provider: RwLock::new(None),
                sessions: RwLock::new(HashMap::new()),
                acp_sessions: RwLock::new(HashMap::new()),
                acp_approvals: RwLock::new(HashMap::new()),
                session_store: AgentSessionStore::default(),
                chat_session_store: ChatSessionSnapshotStore::default(),
                tools: ToolRegistry::default(),
                proxy_broker: ProxyBroker::default(),
                host: RwLock::new(None),
            }),
        }
    }
}

impl AiState {
    pub(crate) fn with_data_root(data_root: std::path::PathBuf) -> Self {
        let config = AiConfig::default();
        Self {
            inner: Arc::new(AiStateInner {
                config: RwLock::new(config),
                provider: RwLock::new(None),
                sessions: RwLock::new(HashMap::new()),
                acp_sessions: RwLock::new(HashMap::new()),
                acp_approvals: RwLock::new(HashMap::new()),
                session_store: AgentSessionStore::from_data_root(data_root.clone()),
                chat_session_store: ChatSessionSnapshotStore::from_data_root(data_root),
                tools: ToolRegistry::default(),
                proxy_broker: ProxyBroker::default(),
                host: RwLock::new(None),
            }),
        }
    }

    pub fn config(&self) -> AiConfig {
        self.inner.config.read().clone()
    }

    pub fn set_config(&self, config: AiConfig) -> Result<(), AiError> {
        let backend = build_backend(&config)?;
        *self.inner.config.write() = config;
        *self.inner.provider.write() = backend;
        Ok(())
    }

    pub fn reset_state(&self) -> Result<(), AiError> {
        for (_, session) in self.inner.sessions.write().drain() {
            session.cancel();
        }
        for (_, session) in self.inner.acp_sessions.write().drain() {
            session.request_shutdown();
        }
        self.inner.acp_approvals.write().clear();
        self.inner.session_store.clear()?;
        self.inner.chat_session_store.clear()?;

        let config = AiConfig::default();
        *self.inner.config.write() = config;
        *self.inner.provider.write() = None;
        Ok(())
    }

    pub fn persisted_sessions(&self) -> Vec<crate::PersistedAgentSession> {
        self.inner.session_store.list()
    }

    pub fn persisted_sessions_for_working_directory(
        &self,
        working_directory: Option<&str>,
    ) -> Vec<crate::PersistedAgentSession> {
        self.inner
            .session_store
            .list_for_working_directory(working_directory)
    }

    pub fn persisted_chat_sessions_for_working_directory(
        &self,
        working_directory: Option<&str>,
    ) -> Vec<PersistedChatSessionSnapshot> {
        self.inner
            .chat_session_store
            .list_for_working_directory(working_directory)
    }

    pub fn replace_persisted_chat_sessions_for_working_directory(
        &self,
        working_directory: Option<&str>,
        sessions: Vec<PersistedChatSessionSnapshot>,
    ) -> Result<(), AiError> {
        self.inner
            .chat_session_store
            .replace_for_working_directory(working_directory, sessions)
    }

    pub fn record_agent_session(
        &self,
        local_session_id: String,
        agent_id: AgentId,
        working_directory: Option<String>,
    ) -> Result<(), AiError> {
        let (external_session_id, supports_load, supports_resume) =
            match self.get_acp_session(&local_session_id) {
                Ok(handle) => {
                    let capabilities = handle.capabilities();
                    (
                        handle.external_session_id(),
                        capabilities.supports_load,
                        capabilities.supports_resume,
                    )
                }
                Err(_) => (None, false, false),
            };
        self.inner.session_store.record_new_session(
            local_session_id,
            external_session_id,
            agent_id,
            supports_load,
            supports_resume,
            working_directory,
        )
    }

    pub fn touch_agent_session(&self, session_id: &str, title: String) -> Result<(), AiError> {
        self.inner.session_store.touch_session(session_id, title)
    }

    pub fn remove_agent_session(&self, session_id: &str) -> Result<(), AiError> {
        self.inner.session_store.remove_session(session_id)
    }

    pub fn resolve_approval(
        &self,
        session_id: &str,
        call_id: &str,
        approved: bool,
    ) -> Result<(), AiError> {
        if let Ok(session) = self.get_session(session_id) {
            return session.resolve_approval(call_id, approved);
        }

        self.get_acp_session(session_id)?;
        let sender = self
            .inner
            .acp_approvals
            .write()
            .remove(&(session_id.to_string(), call_id.to_string()))
            .ok_or(AiError::ApprovalNotFound)?;
        sender
            .send(if approved {
                ApprovalDecision::Approve
            } else {
                ApprovalDecision::Reject
            })
            .map_err(|_| AiError::ApprovalNotFound)
    }

    pub(crate) fn begin_acp_approval(
        &self,
        session_id: &str,
        call_id: String,
    ) -> Result<oneshot::Receiver<ApprovalDecision>, AiError> {
        self.get_acp_session(session_id)?;
        let (sender, receiver) = oneshot::channel();
        self.inner
            .acp_approvals
            .write()
            .insert((session_id.to_string(), call_id), sender);
        Ok(receiver)
    }

    pub(crate) fn clear_acp_approval(&self, session_id: &str, call_id: &str) {
        self.inner
            .acp_approvals
            .write()
            .remove(&(session_id.to_string(), call_id.to_string()));
    }

    pub fn backend(&self) -> Result<Arc<dyn CompletionBackend>, AiError> {
        if let Some(provider) = self.inner.provider.read().clone() {
            return Ok(provider);
        }

        let config = self.config();
        let provider = build_backend(&config)?.ok_or(AiError::NotConfigured)?;
        *self.inner.provider.write() = Some(provider.clone());
        Ok(provider)
    }

    pub fn create_session(&self, mode: ChatMode) -> Arc<SessionRuntime> {
        let session = Arc::new(SessionRuntime::new(mode));
        self.inner
            .sessions
            .write()
            .insert(session.id.clone(), session.clone());
        session
    }

    pub fn restore_session(
        &self,
        session_id: String,
        mode: ChatMode,
        messages: Vec<ChatMessage>,
    ) -> Result<(), AiError> {
        if self.inner.acp_sessions.read().contains_key(&session_id)
            || self.inner.sessions.read().contains_key(&session_id)
        {
            return Ok(());
        }
        let session = Arc::new(SessionRuntime::with_id_and_messages(
            session_id.clone(),
            mode,
            messages,
        ));
        self.inner.sessions.write().insert(session_id, session);
        Ok(())
    }

    pub fn runtime_for_agent(&self, agent_id: &AgentId) -> Result<Arc<dyn AgentRuntime>, AiError> {
        match agent_id.0.as_str() {
            "kuku-native" => Ok(Arc::new(NativeAgentRuntime)),
            id => {
                if let Some(config) = self.external_agent_config(id) {
                    if !AcpAgentRuntime::config_available(&config) {
                        return Err(AiError::AgentUnavailable(id.to_string()));
                    }
                    return Ok(Arc::new(AcpAgentRuntime::configured(&config)?));
                }

                AcpAgentRuntime::managed(id)
                    .map(|runtime| Arc::new(runtime) as Arc<dyn AgentRuntime>)
                    .ok_or_else(|| {
                        if AcpAgentRuntime::is_known_managed(id) {
                            AiError::AgentUnavailable(id.to_string())
                        } else {
                            AiError::UnknownAgent(id.to_string())
                        }
                    })
            }
        }
    }

    pub fn agent_descriptors(&self) -> Vec<AgentDescriptor> {
        let configured_agents = self.config().external_agents;
        let mut descriptors = vec![
            AgentDescriptor {
                id: AgentId::kuku_native(),
                label: "Kuku Agent".to_string(),
                kind: AgentKind::Native,
                enabled: true,
                managed: true,
            },
            AgentDescriptor {
                id: AgentId("codex-acp".to_string()),
                label: "Codex CLI".to_string(),
                kind: AgentKind::Acp,
                enabled: AcpAgentRuntime::is_available("codex-acp"),
                managed: true,
            },
        ];

        for config in configured_agents
            .into_iter()
            .filter(|config| AcpAgentRuntime::is_known_managed(&config.id))
        {
            let descriptor = AgentDescriptor {
                id: AgentId(config.id.clone()),
                label: if config.label.trim().is_empty() {
                    config.id.clone()
                } else {
                    config.label.clone()
                },
                kind: AgentKind::Acp,
                enabled: AcpAgentRuntime::config_available(&config),
                managed: AcpAgentRuntime::is_known_managed(&config.id),
            };

            if let Some(existing) = descriptors
                .iter_mut()
                .find(|agent| agent.id.0 == descriptor.id.0)
            {
                *existing = descriptor;
            } else {
                descriptors.push(descriptor);
            }
        }

        descriptors
    }

    fn external_agent_config(&self, agent_id: &str) -> Option<ExternalAgentConfig> {
        self.config()
            .external_agents
            .into_iter()
            .find(|config| config.id == agent_id && AcpAgentRuntime::is_known_managed(&config.id))
    }

    pub fn get_session(&self, session_id: &str) -> Result<Arc<SessionRuntime>, AiError> {
        self.inner
            .sessions
            .read()
            .get(session_id)
            .cloned()
            .ok_or(AiError::SessionNotFound)
    }

    pub fn remove_session(&self, session_id: &str) -> Result<Arc<SessionRuntime>, AiError> {
        self.inner
            .sessions
            .write()
            .remove(session_id)
            .ok_or(AiError::SessionNotFound)
    }

    pub(crate) fn insert_acp_session(
        &self,
        session_id: String,
        handle: AcpSessionHandle,
    ) -> Result<(), AiError> {
        if self.inner.sessions.read().contains_key(&session_id)
            || self.inner.acp_sessions.read().contains_key(&session_id)
        {
            return Err(AiError::State(format!(
                "AI session already exists: {session_id}"
            )));
        }
        self.inner.acp_sessions.write().insert(session_id, handle);
        Ok(())
    }

    pub(crate) fn get_acp_session(&self, session_id: &str) -> Result<AcpSessionHandle, AiError> {
        self.inner
            .acp_sessions
            .read()
            .get(session_id)
            .cloned()
            .ok_or(AiError::SessionNotFound)
    }

    pub(crate) fn remove_acp_session(&self, session_id: &str) -> Result<AcpSessionHandle, AiError> {
        let handle = self
            .inner
            .acp_sessions
            .write()
            .remove(session_id)
            .ok_or(AiError::SessionNotFound)?;
        self.inner
            .acp_approvals
            .write()
            .retain(|(approval_session_id, _), _| approval_session_id != session_id);
        Ok(handle)
    }

    #[cfg(test)]
    pub(crate) fn acp_session_count(&self) -> usize {
        self.inner.acp_sessions.read().len()
    }

    #[cfg(test)]
    pub(crate) fn with_session_store_path(path: std::path::PathBuf) -> Self {
        let chat_path = path.with_file_name(format!(
            "{}.chat.json",
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("sessions")
        ));
        Self::with_store_paths(path, chat_path)
    }

    #[cfg(test)]
    pub(crate) fn with_store_paths(
        session_store_path: std::path::PathBuf,
        chat_session_store_path: std::path::PathBuf,
    ) -> Self {
        let config = AiConfig::default();
        Self {
            inner: Arc::new(AiStateInner {
                config: RwLock::new(config),
                provider: RwLock::new(None),
                sessions: RwLock::new(HashMap::new()),
                acp_sessions: RwLock::new(HashMap::new()),
                acp_approvals: RwLock::new(HashMap::new()),
                session_store: AgentSessionStore::new(session_store_path),
                chat_session_store: ChatSessionSnapshotStore::new(chat_session_store_path),
                tools: ToolRegistry::default(),
                proxy_broker: ProxyBroker::default(),
                host: RwLock::new(None),
            }),
        }
    }

    pub fn register_tool(&self, tool: Arc<dyn AiNativeTool>) {
        self.inner.tools.register_native(tool);
    }

    pub fn register_proxy_tool(&self, descriptor: ProxyToolDescriptor) -> Result<(), AiError> {
        self.inner.tools.register_proxy(descriptor)
    }

    pub fn remember_path_snapshot(
        &self,
        session_id: &str,
        path: String,
        checksum: String,
        is_dir: bool,
    ) -> Result<(), AiError> {
        if let Ok(session) = self.get_session(session_id) {
            session.remember_path_snapshot(path, checksum, is_dir);
            return Ok(());
        }
        self.get_acp_session(session_id)?;
        Ok(())
    }

    pub fn path_snapshot(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Option<(String, bool)>, AiError> {
        if let Ok(session) = self.get_session(session_id) {
            return Ok(session.path_snapshot(path));
        }
        self.get_acp_session(session_id)?;
        Ok(None)
    }

    pub fn unregister_proxy_tool(&self, name: &str) {
        self.inner.tools.unregister_proxy(name);
    }

    pub fn tool_descriptors(&self) -> Vec<ToolDescriptor> {
        self.inner.tools.descriptors()
    }

    pub fn tools(&self) -> &ToolRegistry {
        &self.inner.tools
    }

    pub fn proxy_broker(&self) -> &ProxyBroker {
        &self.inner.proxy_broker
    }

    pub fn set_host(&self, host: Arc<dyn AiHostBindings>) {
        *self.inner.host.write() = Some(host);
    }

    pub fn host(&self) -> Option<Arc<dyn AiHostBindings>> {
        self.inner.host.read().clone()
    }
}
fn build_backend(config: &AiConfig) -> Result<Option<Arc<dyn CompletionBackend>>, AiError> {
    match config.provider {
        ProviderKind::Gemini => {
            let Some(api_key) = config.api_key.as_deref() else {
                return Ok(None);
            };
            Ok(Some(
                Arc::new(GeminiBackend::new(api_key, &config.model)?) as Arc<dyn CompletionBackend>
            ))
        }
        ProviderKind::Remote => {
            let base_url = config
                .server_url
                .as_deref()
                .unwrap_or(if cfg!(debug_assertions) {
                    "http://localhost:8080"
                } else {
                    "https://api.kuku.mom"
                });
            Ok(Some(Arc::new(RemoteBackend::new(base_url, &config.model)?)
                as Arc<dyn CompletionBackend>))
        }
    }
}

#[cfg(test)]
mod agent_runtime_tests {
    use std::collections::HashMap;

    use crate::{
        AiConfig, AiError, AiState, ChatMode,
        agent_runtime::acp::{AcpSessionCapabilities, AcpSessionHandle},
        types::{AgentId, ExternalAgentConfig},
    };

    #[test]
    fn runtime_for_native_agent_creates_retrievable_session() {
        let state = AiState::default();

        let payload =
            crate::agent_runtime::native::NativeAgentRuntime::new_session(&state, ChatMode::Ask);

        assert!(state.get_session(&payload.session_id).is_ok());
    }

    #[test]
    fn runtime_for_managed_external_agent_is_available() {
        let state = AiState::default();
        let result = state
            .runtime_for_agent(&AgentId("codex-acp".to_string()))
            .unwrap();

        drop(result);
    }

    #[test]
    fn runtime_for_unknown_agent_returns_error() {
        let state = AiState::default();

        let result = state.runtime_for_agent(&AgentId("custom-acp".to_string()));
        let Err(error) = result else {
            panic!("unknown agents must not fall back to native runtime");
        };

        assert!(error.to_string().contains("Unknown AI agent"));
    }

    #[test]
    fn configured_non_codex_external_agent_is_ignored() {
        let state = AiState::default();
        state
            .set_config(AiConfig {
                external_agents: vec![ExternalAgentConfig {
                    id: "custom-acp".to_string(),
                    label: "Custom ACP".to_string(),
                    command: "sh".to_string(),
                    args: vec!["-lc".to_string(), "custom-agent".to_string()],
                    env: HashMap::from([("CUSTOM_TOKEN".to_string(), "secret".to_string())]),
                    enabled: true,
                }],
                ..AiConfig::default()
            })
            .unwrap();

        let descriptors = state.agent_descriptors();
        assert!(descriptors.iter().all(|agent| agent.id.0 != "custom-acp"));

        let result = state.runtime_for_agent(&AgentId("custom-acp".to_string()));
        let Err(error) = result else {
            panic!("custom agents must not be routable");
        };
        assert!(matches!(error, AiError::UnknownAgent(_)));
    }

    #[test]
    fn stale_disabled_configured_codex_agent_is_still_routable() {
        let state = AiState::default();
        state
            .set_config(AiConfig {
                external_agents: vec![ExternalAgentConfig {
                    id: "codex-acp".to_string(),
                    label: "Codex CLI".to_string(),
                    command: "npx".to_string(),
                    args: vec![],
                    env: HashMap::new(),
                    enabled: false,
                }],
                ..AiConfig::default()
            })
            .unwrap();

        let result = state.runtime_for_agent(&AgentId("codex-acp".to_string()));

        assert!(result.is_ok());
    }

    #[test]
    fn agent_descriptors_expose_only_kuku_and_codex() {
        let state = AiState::default();

        let descriptors = state.agent_descriptors();

        assert_eq!(
            descriptors
                .iter()
                .map(|agent| agent.id.0.as_str())
                .collect::<Vec<_>>(),
            vec!["kuku-native", "codex-acp"]
        );
    }

    #[test]
    fn persisted_agent_session_metadata_is_recorded_from_state() {
        let path = std::env::temp_dir().join(format!(
            "kuku-ai-state-sessions-{}.json",
            uuid::Uuid::new_v4()
        ));
        let state = AiState::with_session_store_path(path.clone());

        state
            .record_agent_session(
                "local-1".to_string(),
                AgentId::kuku_native(),
                Some("/Users/me/Notes".to_string()),
            )
            .unwrap();
        state
            .touch_agent_session("local-1", "Hello from Kuku".to_string())
            .unwrap();

        let sessions = state.persisted_sessions();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].local_session_id, "local-1");
        assert_eq!(sessions[0].agent_id, AgentId::kuku_native());
        assert_eq!(sessions[0].title, "Hello from Kuku");
        assert_eq!(
            sessions[0].working_directory.as_deref(),
            Some("/Users/me/Notes")
        );

        let reloaded = AiState::with_session_store_path(path);
        assert_eq!(reloaded.persisted_sessions()[0].local_session_id, "local-1");
    }

    #[test]
    fn reset_state_clears_persisted_agent_sessions() {
        let path = std::env::temp_dir().join(format!(
            "kuku-ai-state-reset-sessions-{}.json",
            uuid::Uuid::new_v4()
        ));
        let state = AiState::with_session_store_path(path.clone());

        state
            .record_agent_session("local-1".to_string(), AgentId::kuku_native(), None)
            .unwrap();

        state.reset_state().unwrap();

        assert!(state.persisted_sessions().is_empty());
        assert!(!path.exists());
    }

    #[test]
    fn persisted_acp_session_metadata_uses_handle_capabilities() {
        let path = std::env::temp_dir().join(format!(
            "kuku-ai-state-acp-sessions-{}.json",
            uuid::Uuid::new_v4()
        ));
        let state = AiState::with_session_store_path(path);
        let handle = AcpSessionHandle::with_capabilities_for_test(
            "external-acp-session-1",
            AcpSessionCapabilities {
                supports_load: true,
                supports_resume: false,
                supports_mcp_http: true,
            },
        );

        state
            .insert_acp_session("local-1".to_string(), handle)
            .unwrap();
        state
            .record_agent_session(
                "local-1".to_string(),
                AgentId("codex-acp".to_string()),
                Some("/Users/me/Notes".to_string()),
            )
            .unwrap();

        let sessions = state.persisted_sessions();
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0].external_session_id.as_deref(),
            Some("external-acp-session-1")
        );
        assert!(sessions[0].supports_load);
        assert!(!sessions[0].supports_resume);
        assert_eq!(
            sessions[0].working_directory.as_deref(),
            Some("/Users/me/Notes")
        );
    }

    #[test]
    fn acp_sessions_accept_read_only_snapshot_calls_as_noop() {
        let state = AiState::default();
        let handle = AcpSessionHandle::with_capabilities_for_test(
            "external-acp-session-1",
            AcpSessionCapabilities::default(),
        );
        state
            .insert_acp_session("local-1".to_string(), handle)
            .unwrap();

        state
            .remember_path_snapshot(
                "local-1",
                "note.md".to_string(),
                "checksum".to_string(),
                false,
            )
            .unwrap();

        assert_eq!(state.path_snapshot("local-1", "note.md").unwrap(), None);
        assert!(
            state
                .remember_path_snapshot(
                    "missing",
                    "note.md".to_string(),
                    "checksum".to_string(),
                    false,
                )
                .is_err()
        );
    }

    #[tokio::test]
    async fn acp_sessions_can_begin_and_resolve_tool_approval() {
        let state = AiState::default();
        let handle = AcpSessionHandle::with_capabilities_for_test(
            "external-acp-session-1",
            AcpSessionCapabilities::default(),
        );
        state
            .insert_acp_session("local-1".to_string(), handle)
            .unwrap();

        let approval = state
            .begin_acp_approval("local-1", "call-1".to_string())
            .unwrap();
        state.resolve_approval("local-1", "call-1", true).unwrap();

        assert!(matches!(
            approval.await.unwrap(),
            crate::session::ApprovalDecision::Approve
        ));
        assert!(
            state
                .begin_acp_approval("missing", "call-2".to_string())
                .is_err()
        );
    }

    #[test]
    fn removing_acp_session_clears_pending_approvals() {
        let state = AiState::default();
        let handle = AcpSessionHandle::with_capabilities_for_test(
            "external-acp-session-1",
            AcpSessionCapabilities::default(),
        );
        state
            .insert_acp_session("local-1".to_string(), handle)
            .unwrap();
        let _approval = state
            .begin_acp_approval("local-1", "call-1".to_string())
            .unwrap();

        state.remove_acp_session("local-1").unwrap();

        assert!(matches!(
            state.resolve_approval("local-1", "call-1", true),
            Err(AiError::SessionNotFound | AiError::ApprovalNotFound)
        ));
    }

    #[test]
    fn runtime_for_removed_non_codex_managed_agent_is_unknown() {
        let state = AiState::default();

        let result = state.runtime_for_agent(&AgentId("claude-acp".to_string()));
        let Err(error) = result else {
            panic!("removed managed agents must not be routable");
        };

        assert!(matches!(error, AiError::UnknownAgent(_)));
    }
}
