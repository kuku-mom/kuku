use std::{collections::HashMap, sync::Arc};

use parking_lot::RwLock;

use crate::{
    AiConfig, AiError, AiHostBindings, AiNativeTool,
    provider::{CompletionBackend, gemini::GeminiBackend, remote::RemoteBackend},
    session::SessionRuntime,
    tools::{ProxyBroker, ProxyToolDescriptor, ToolDescriptor, ToolRegistry},
    types::{ChatMode, ProviderKind},
};

struct AiStateInner {
    config: RwLock<AiConfig>,
    provider: RwLock<Option<Arc<dyn CompletionBackend>>>,
    sessions: RwLock<HashMap<String, Arc<SessionRuntime>>>,
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
                tools: ToolRegistry::default(),
                proxy_broker: ProxyBroker::default(),
                host: RwLock::new(None),
            }),
        }
    }
}

impl AiState {
    pub fn config(&self) -> AiConfig {
        self.inner.config.read().clone()
    }

    pub fn set_config(&self, config: AiConfig) -> Result<(), AiError> {
        *self.inner.config.write() = config.clone();
        *self.inner.provider.write() = build_backend(&config)?;
        Ok(())
    }

    pub fn reset_state(&self) -> Result<(), AiError> {
        for (_, session) in self.inner.sessions.write().drain() {
            session.cancel();
        }

        let config = AiConfig::default();
        *self.inner.config.write() = config;
        *self.inner.provider.write() = None;
        Ok(())
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

    pub fn get_session(&self, session_id: &str) -> Result<Arc<SessionRuntime>, AiError> {
        self.inner
            .sessions
            .read()
            .get(session_id)
            .cloned()
            .ok_or(AiError::SessionNotFound)
    }

    pub fn register_tool(&self, tool: Arc<dyn AiNativeTool>) {
        self.inner.tools.register_native(tool);
    }

    pub fn register_proxy_tool(&self, descriptor: ProxyToolDescriptor) {
        self.inner.tools.register_proxy(descriptor);
    }

    pub fn remember_path_snapshot(
        &self,
        session_id: &str,
        path: String,
        checksum: String,
        is_dir: bool,
    ) -> Result<(), AiError> {
        let session = self.get_session(session_id)?;
        session.remember_path_snapshot(path, checksum, is_dir);
        Ok(())
    }

    pub fn path_snapshot(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Option<(String, bool)>, AiError> {
        let session = self.get_session(session_id)?;
        Ok(session.path_snapshot(path))
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
            Ok(Some(
                Arc::new(RemoteBackend::new(base_url, &config.model)) as Arc<dyn CompletionBackend>
            ))
        }
    }
}
