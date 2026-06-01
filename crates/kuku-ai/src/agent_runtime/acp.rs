use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
};

use agent_client_protocol::{
    ActiveSession, Agent, Client, ConnectionTo,
    schema::{
        CancelNotification, ContentBlock, ContentChunk, InitializeRequest, InitializeResponse,
        NewSessionResponse, ProtocolVersion, ResumeSessionRequest, ResumeSessionResponse,
        SessionId, SessionNotification, SessionUpdate, StopReason, ToolCall, ToolCallContent,
        ToolCallStatus,
    },
    util::MatchDispatch,
};
use agent_client_protocol_tokio::{AcpAgent, Stdio};
use async_trait::async_trait;
use serde_json::Value;
use tauri::{AppHandle, Wry};
use tokio::{
    sync::{Mutex, oneshot, watch},
    time::{Duration, timeout},
};
use uuid::Uuid;

use crate::{
    AiError, AiState, ChatMode, NewSessionPayload,
    agent_runtime::{
        AgentRestoreSessionRequest, AgentRuntime, AgentSendMessageRequest,
        events::{emit_done, emit_error, emit_stream_chunk, emit_tool_end, emit_tool_start},
    },
    mcp_bridge::{SharedEditorContext, read_only_mcp_server},
    types::{EditorContext, ExternalAgentConfig, FinishReason, ModelToolCall},
};

const ACP_SESSION_READY_TIMEOUT: Duration = Duration::from_secs(30);
const CODEX_ACP_AGENT_ID: &str = "codex-acp";
const CODEX_ACP_COMMAND: &str = "npx";
const CODEX_ACP_PACKAGE: &str = "@zed-industries/codex-acp@latest";

#[derive(Debug, Clone)]
struct AcpAgentCommand {
    command: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub(crate) struct AcpAgentRuntime {
    command: AcpAgentCommand,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct AcpSessionCapabilities {
    pub(crate) supports_load: bool,
    pub(crate) supports_resume: bool,
    pub(crate) supports_mcp_http: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct AcpSessionHandle {
    session: Option<Arc<Mutex<ActiveSession<'static, Agent>>>>,
    connection: Option<ConnectionTo<Agent>>,
    session_id: Option<SessionId>,
    capabilities: AcpSessionCapabilities,
    editor_context: SharedEditorContext,
    shutdown: watch::Sender<bool>,
}

impl AcpAgentRuntime {
    fn new(command: AcpAgentCommand) -> Self {
        Self { command }
    }

    pub(crate) fn managed(agent_id: &str) -> Option<Self> {
        let command = match agent_id {
            CODEX_ACP_AGENT_ID if command_available(CODEX_ACP_COMMAND) => {
                AcpAgentCommand::codex([])
            }
            _ => return None,
        };
        Some(Self::new(command))
    }

    pub(crate) fn configured(config: &ExternalAgentConfig) -> Result<Self, AiError> {
        if config.id != CODEX_ACP_AGENT_ID {
            return Err(AiError::UnknownAgent(config.id.clone()));
        }
        if !command_available(CODEX_ACP_COMMAND) {
            return Err(AiError::AgentUnavailable(config.id.clone()));
        }
        Ok(Self::new(AcpAgentCommand::from_config(config)))
    }

    pub(crate) fn config_available(config: &ExternalAgentConfig) -> bool {
        config.id == CODEX_ACP_AGENT_ID && command_available(CODEX_ACP_COMMAND)
    }

    pub(crate) fn is_known_managed(agent_id: &str) -> bool {
        agent_id == CODEX_ACP_AGENT_ID
    }

    pub(crate) fn is_available(agent_id: &str) -> bool {
        Self::managed(agent_id).is_some()
    }

    fn acp_agent(&self) -> Result<AcpAgent, AiError> {
        if self.command.env.is_empty()
            && self.command.command == CODEX_ACP_COMMAND
            && self.command.args == ["-y", CODEX_ACP_PACKAGE]
        {
            return Ok(AcpAgent::zed_codex());
        }

        AcpAgent::from_args(self.command_line_args()).map_err(acp_error)
    }

    fn initialize_request(&self) -> InitializeRequest {
        InitializeRequest::new(ProtocolVersion::LATEST)
    }

    fn stdio_transport(&self) -> Stdio {
        Stdio::new()
    }

    fn command_summary(&self) -> String {
        let args = if self.command.args.is_empty() {
            String::new()
        } else {
            format!(" {}", self.command.args.join(" "))
        };
        let env_summary = if self.command.env.is_empty() {
            String::new()
        } else {
            format!(" with {} env vars", self.command.env.len())
        };
        format!("{}{}{}", self.command.command, args, env_summary)
    }

    fn command_line_args(&self) -> Vec<String> {
        self.command
            .env
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .chain(std::iter::once(self.command.command.clone()))
            .chain(self.command.args.clone())
            .collect()
    }

    fn prepare_send_message(
        &self,
        state: &AiState,
        request: &AgentSendMessageRequest,
    ) -> Result<AcpSessionHandle, AiError> {
        state.get_acp_session(&request.session_id)
    }
}

impl AcpSessionCapabilities {
    pub(crate) fn from_initialize_response(response: &InitializeResponse) -> Self {
        Self {
            supports_load: response.agent_capabilities.load_session,
            supports_mcp_http: response.agent_capabilities.mcp_capabilities.http,
            supports_resume: response
                .agent_capabilities
                .session_capabilities
                .resume
                .is_some(),
        }
    }
}

impl AcpSessionHandle {
    fn live(
        session: ActiveSession<'static, Agent>,
        capabilities: AcpSessionCapabilities,
        editor_context: SharedEditorContext,
        shutdown: watch::Sender<bool>,
    ) -> Self {
        let connection = session.connection();
        let session_id = session.session_id().clone();
        Self {
            session: Some(Arc::new(Mutex::new(session))),
            connection: Some(connection),
            session_id: Some(session_id),
            capabilities,
            editor_context,
            shutdown,
        }
    }

    #[cfg(test)]
    fn disconnected_for_test(session_id: &str) -> Self {
        Self::with_capabilities_for_test(session_id, AcpSessionCapabilities::default())
    }

    #[cfg(test)]
    pub(crate) fn with_capabilities_for_test(
        session_id: &str,
        capabilities: AcpSessionCapabilities,
    ) -> Self {
        let (shutdown, _rx) = watch::channel(false);
        Self {
            session: None,
            connection: None,
            session_id: Some(SessionId::new(session_id)),
            capabilities,
            editor_context: Arc::new(parking_lot::RwLock::new(EditorContext::default())),
            shutdown,
        }
    }

    pub(crate) fn request_shutdown(&self) {
        let _ = self.shutdown.send(true);
    }

    async fn cancel(&self) -> Result<(), AiError> {
        let (Some(connection), Some(session_id)) =
            (self.connection.as_ref(), self.session_id.as_ref())
        else {
            return Ok(());
        };
        connection
            .send_notification(CancelNotification::new(session_id.clone()))
            .map_err(acp_error)
    }

    pub(crate) fn external_session_id(&self) -> Option<String> {
        self.session_id.as_ref().map(ToString::to_string)
    }

    pub(crate) fn capabilities(&self) -> AcpSessionCapabilities {
        self.capabilities
    }

    async fn send_prompt_and_stream(
        &self,
        app: AppHandle<Wry>,
        request: AgentSendMessageRequest,
    ) -> Result<FinishReason, AiError> {
        let Some(session) = self.session.as_ref() else {
            return Err(AiError::ProviderError(format!(
                "ACP session {} is not connected",
                request.session_id
            )));
        };
        *self.editor_context.write() = request.editor_context.clone();
        let mut session = session.lock().await;
        session
            .send_prompt(build_acp_prompt_text(&request))
            .map_err(acp_error)?;

        loop {
            match session.read_update().await.map_err(acp_error)? {
                agent_client_protocol::SessionMessage::SessionMessage(dispatch) => {
                    emit_acp_dispatch_update(&app, &request.session_id, dispatch).await?;
                }
                agent_client_protocol::SessionMessage::StopReason(reason) => {
                    return Ok(acp_stop_reason_to_finish_reason(&reason));
                }
                _ => {}
            }
        }
    }
}

async fn emit_acp_dispatch_update(
    app: &AppHandle<Wry>,
    session_id: &str,
    dispatch: agent_client_protocol::Dispatch,
) -> Result<(), AiError> {
    MatchDispatch::new(dispatch)
        .if_notification(async |notification: SessionNotification| {
            match notification.update {
                SessionUpdate::AgentMessageChunk(chunk)
                | SessionUpdate::AgentThoughtChunk(chunk) => {
                    if let Some(delta) = acp_chunk_text_delta(chunk) {
                        emit_stream_chunk(app, session_id, delta);
                    }
                }
                SessionUpdate::ToolCall(tool_call) => {
                    let (model_call, tool_id) = acp_tool_call_start(&tool_call);
                    emit_tool_start(app, session_id, &model_call, &tool_id);
                    if matches!(
                        tool_call.status,
                        ToolCallStatus::Completed | ToolCallStatus::Failed
                    ) {
                        let output = acp_tool_call_output(
                            tool_call.raw_output.as_ref(),
                            Some(&tool_call.content),
                        );
                        emit_tool_end(
                            app,
                            session_id,
                            &model_call.call_id,
                            &tool_id,
                            &model_call.tool_name,
                            &output,
                            matches!(tool_call.status, ToolCallStatus::Failed),
                        );
                    }
                }
                SessionUpdate::ToolCallUpdate(update) => {
                    if matches!(
                        update.fields.status,
                        Some(ToolCallStatus::Completed | ToolCallStatus::Failed)
                    ) {
                        let call_id = update.tool_call_id.0.to_string();
                        let tool_name = update.fields.title.as_deref().unwrap_or("ACP tool");
                        let tool_id = acp_tool_id(&call_id);
                        let output = acp_tool_call_output(
                            update.fields.raw_output.as_ref(),
                            update.fields.content.as_ref(),
                        );
                        emit_tool_end(
                            app,
                            session_id,
                            &call_id,
                            &tool_id,
                            tool_name,
                            &output,
                            matches!(update.fields.status, Some(ToolCallStatus::Failed)),
                        );
                    }
                }
                SessionUpdate::Plan(plan) => {
                    let summary = plan
                        .entries
                        .iter()
                        .map(|entry| format!("- {:?}: {}", entry.status, entry.content))
                        .collect::<Vec<_>>()
                        .join("\n");
                    if !summary.is_empty() {
                        emit_stream_chunk(app, session_id, format!("\n\nPlan:\n{summary}\n"));
                    }
                }
                SessionUpdate::UserMessageChunk(_)
                | SessionUpdate::AvailableCommandsUpdate(_)
                | SessionUpdate::CurrentModeUpdate(_)
                | SessionUpdate::ConfigOptionUpdate(_)
                | SessionUpdate::SessionInfoUpdate(_) => {}
                _ => {}
            }
            Ok(())
        })
        .await
        .otherwise_ignore()
        .map_err(acp_error)?;
    Ok(())
}

fn acp_chunk_text_delta(chunk: ContentChunk) -> Option<String> {
    match chunk.content {
        ContentBlock::Text(text) => Some(acp_text_delta_to_kuku_delta(text.text)),
        _ => None,
    }
}

fn acp_tool_call_start(tool_call: &ToolCall) -> (ModelToolCall, String) {
    let call_id = tool_call.tool_call_id.0.to_string();
    let tool_id = acp_tool_id(&call_id);
    (
        ModelToolCall {
            call_id,
            tool_call_id: None,
            provider_call_id: None,
            tool_name: tool_call.title.clone(),
            arguments: tool_call.raw_input.clone().unwrap_or(Value::Null),
            signature: None,
        },
        tool_id,
    )
}

fn acp_tool_id(call_id: &str) -> String {
    format!("acp.{call_id}")
}

fn acp_tool_call_output(
    raw_output: Option<&Value>,
    content: Option<&Vec<ToolCallContent>>,
) -> String {
    if let Some(raw_output) = raw_output {
        return raw_output.to_string();
    }
    let Some(content) = content else {
        return String::new();
    };
    content
        .iter()
        .filter_map(|item| match item {
            ToolCallContent::Content(content) => match &content.content {
                ContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            },
            ToolCallContent::Diff(diff) => Some(format!("{diff:?}")),
            ToolCallContent::Terminal(terminal) => Some(format!("{terminal:?}")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn acp_stop_reason_to_finish_reason(reason: &StopReason) -> FinishReason {
    match reason {
        StopReason::Cancelled => FinishReason::Cancelled,
        _ => FinishReason::Stop,
    }
}

fn acp_text_delta_to_kuku_delta(text: impl Into<String>) -> String {
    text.into()
}

async fn initialize_acp_connection(
    connection: &ConnectionTo<Agent>,
) -> Result<AcpSessionCapabilities, agent_client_protocol::Error> {
    let initialize = connection
        .send_request(InitializeRequest::new(ProtocolVersion::LATEST))
        .block_task()
        .await?;
    Ok(AcpSessionCapabilities::from_initialize_response(
        &initialize,
    ))
}

async fn start_new_acp_session(
    connection: &ConnectionTo<Agent>,
    app: AppHandle<Wry>,
    state: AiState,
    local_session_id: String,
    capabilities: AcpSessionCapabilities,
    editor_context: SharedEditorContext,
) -> Result<ActiveSession<'static, Agent>, agent_client_protocol::Error> {
    if capabilities.supports_mcp_http {
        connection
            .build_session_cwd()?
            .with_mcp_server(read_only_mcp_server(
                app,
                state,
                local_session_id,
                editor_context,
            ))?
            .block_task()
            .start_session()
            .await
    } else {
        connection
            .build_session_cwd()?
            .block_task()
            .start_session()
            .await
    }
}

async fn attach_resumed_acp_session(
    connection: &ConnectionTo<Agent>,
    external_session_id: impl Into<SessionId>,
) -> Result<ActiveSession<'static, Agent>, agent_client_protocol::Error> {
    let external_session_id = external_session_id.into();
    let resume = connection
        .send_request(ResumeSessionRequest::new(
            external_session_id.clone(),
            acp_current_dir()?,
        ))
        .block_task()
        .await?;
    let response = new_session_response_from_resume(external_session_id, resume);
    connection.attach_session(response, Vec::new())
}

fn new_session_response_from_resume(
    session_id: impl Into<SessionId>,
    resume: ResumeSessionResponse,
) -> NewSessionResponse {
    NewSessionResponse::new(session_id)
        .modes(resume.modes)
        .config_options(resume.config_options)
        .meta(resume.meta)
}

fn acp_current_dir() -> Result<PathBuf, agent_client_protocol::Error> {
    env::current_dir().map_err(|error| {
        agent_client_protocol::Error::internal_error()
            .data(format!("cannot get current directory: {error}"))
    })
}

async fn wait_for_acp_shutdown(shutdown_rx: &mut watch::Receiver<bool>) {
    while !*shutdown_rx.borrow() {
        if shutdown_rx.changed().await.is_err() {
            break;
        }
    }
}

fn build_acp_prompt_text(request: &AgentSendMessageRequest) -> String {
    let mut prompt = request.content.clone();
    let context = &request.editor_context;
    let has_context = context.active_file.is_some()
        || context.selected_text.is_some()
        || !context.open_tabs.is_empty()
        || context.cursor_line.is_some()
        || !context.embedded_files.is_empty();
    if !has_context {
        return prompt;
    }

    prompt.push_str("\n\n--- Kuku editor context ---");
    if let Some(active_file) = context.active_file.as_deref() {
        prompt.push_str("\nActive file: ");
        prompt.push_str(active_file);
    }
    if let Some(cursor_line) = context.cursor_line {
        prompt.push_str("\nCursor line: ");
        prompt.push_str(&cursor_line.to_string());
    }
    if !context.open_tabs.is_empty() {
        prompt.push_str("\nOpen tabs: ");
        prompt.push_str(&context.open_tabs.join(", "));
    }
    if let Some(selected_text) = context.selected_text.as_deref() {
        prompt.push_str("\n\nSelected text");
        if let Some(active_file) = context.active_file.as_deref() {
            prompt.push_str(" from ");
            prompt.push_str(active_file);
        }
        prompt.push_str(":\n");
        push_context_block(&mut prompt, selected_text);
    }
    for file in &context.embedded_files {
        prompt.push_str("\n\nEmbedded file: ");
        prompt.push_str(&file.path);
        prompt.push_str(" (");
        prompt.push_str(&file.size_bytes.to_string());
        prompt.push_str(" bytes, checksum ");
        prompt.push_str(&file.checksum);
        prompt.push_str(")\n");
        push_context_block(&mut prompt, &file.content);
    }
    prompt
}

fn push_context_block(prompt: &mut String, content: &str) {
    prompt.push_str("JSON string content:\n");
    prompt.push_str(&serde_json::to_string(content).unwrap_or_else(|_| "\"\"".to_string()));
}

fn command_available(command: &str) -> bool {
    find_command_for_spawn(command).is_some()
}

fn find_command_for_spawn(command: &str) -> Option<String> {
    find_command_for_spawn_with(command, env::var_os("PATH"), dirs::home_dir().as_deref())
}

fn find_command_for_spawn_with(
    command: &str,
    path_var: Option<OsString>,
    home_dir: Option<&Path>,
) -> Option<String> {
    let path = Path::new(command);
    if path.components().count() > 1 {
        return path.is_file().then(|| command.to_string());
    }

    if let Some(paths) = path_var {
        if env::split_paths(&paths).any(|dir| dir.join(command).is_file()) {
            return Some(command.to_string());
        }
    }

    common_node_command_path(command, home_dir).map(|path| path.to_string_lossy().into_owned())
}

fn common_node_command_path(command: &str, home_dir: Option<&Path>) -> Option<PathBuf> {
    if command != "npx" {
        return None;
    }

    let mut candidates = Vec::new();

    if let Some(home) = home_dir {
        candidates.extend([
            home.join(".volta").join("bin").join(command),
            home.join(".asdf").join("shims").join(command),
            home.join(".local")
                .join("share")
                .join("mise")
                .join("shims")
                .join(command),
        ]);

        let nvm_versions = home.join(".nvm").join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(nvm_versions) {
            let mut nvm_candidates = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path().join("bin").join(command))
                .collect::<Vec<_>>();
            nvm_candidates.sort();
            nvm_candidates.reverse();
            candidates.extend(nvm_candidates);
        }
    }

    candidates.extend([
        PathBuf::from("/opt/homebrew/bin").join(command),
        PathBuf::from("/usr/local/bin").join(command),
        PathBuf::from("/usr/bin").join(command),
    ]);

    candidates.into_iter().find(|path| path.is_file())
}

impl AcpAgentCommand {
    fn codex(env: impl IntoIterator<Item = (String, String)>) -> Self {
        let mut env = env.into_iter().collect::<Vec<_>>();
        env.sort_by(|left, right| left.0.cmp(&right.0));
        Self {
            command: find_command_for_spawn(CODEX_ACP_COMMAND)
                .unwrap_or_else(|| CODEX_ACP_COMMAND.to_string()),
            args: vec!["-y".to_string(), CODEX_ACP_PACKAGE.to_string()],
            env,
        }
    }

    fn from_config(config: &ExternalAgentConfig) -> Self {
        let env: Vec<(String, String)> = config
            .env
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        Self::codex(env)
    }
}

fn acp_error(error: agent_client_protocol::Error) -> AiError {
    AiError::ProviderError(error.to_string())
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::{
        AgentCapabilities, Content, ContentBlock, InitializeResponse, McpCapabilities,
        ProtocolVersion, ResumeSessionResponse, SessionCapabilities, SessionConfigOption,
        SessionConfigSelectOption, SessionModeState, SessionNotification,
        SessionResumeCapabilities, StopReason, TextContent, ToolCall, ToolCallContent,
        ToolCallStatus,
    };

    use std::time::Duration;

    use tokio::sync::oneshot;

    use crate::{AiError, AiState, ChatMode, EditorContext, EmbeddedFileContext, FinishReason};

    use super::{
        super::{AgentRuntime, AgentSendMessageRequest},
        AcpAgentCommand, AcpAgentRuntime, AcpSessionCapabilities, AcpSessionHandle,
        acp_stop_reason_to_finish_reason, acp_text_delta_to_kuku_delta, acp_tool_call_output,
        acp_tool_call_start, await_ready_session, build_acp_prompt_text,
        new_session_response_from_resume,
    };

    fn command() -> AcpAgentCommand {
        AcpAgentCommand {
            command: "test-acp".to_string(),
            args: vec!["--stdio".to_string()],
            env: vec![("CODEX_HOME".to_string(), "/tmp/codex".to_string())],
        }
    }

    #[test]
    fn acp_agent_runtime_constructor_preserves_command_data() {
        let command = command();

        let runtime = AcpAgentRuntime::new(command.clone());

        assert_eq!(runtime.command.command, command.command);
        assert_eq!(runtime.command.args, command.args);
        assert_eq!(runtime.command.env, command.env);
    }

    #[test]
    fn acp_agent_runtime_compile_checks_acp_initialize_request_and_stdio_transport() {
        let runtime = AcpAgentRuntime::new(command());

        let initialize = runtime.initialize_request();
        let _stdio = runtime.stdio_transport();

        assert_eq!(initialize.protocol_version, ProtocolVersion::LATEST);
    }

    #[test]
    fn managed_external_agent_ids_create_acp_runtimes() {
        let runtime = AcpAgentRuntime::managed("codex-acp").expect("codex should be managed");

        assert_eq!(runtime.command.command, "npx");
        assert_eq!(
            runtime.command.args,
            vec!["-y", "@zed-industries/codex-acp@latest"]
        );
        assert!(AcpAgentRuntime::managed("unknown").is_none());
    }

    #[test]
    fn configured_non_codex_agent_is_rejected() {
        use std::collections::HashMap;

        use crate::types::ExternalAgentConfig;

        let error = AcpAgentRuntime::configured(&ExternalAgentConfig {
            id: "custom-acp".to_string(),
            label: "Custom ACP".to_string(),
            command: "node".to_string(),
            args: vec!["agent.js".to_string(), "--stdio".to_string()],
            env: HashMap::from([("CUSTOM_TOKEN".to_string(), "secret".to_string())]),
            enabled: true,
        })
        .expect_err("non-Codex ACP agents should be rejected");

        assert!(matches!(error, AiError::UnknownAgent(_)));
    }

    #[test]
    fn configured_codex_default_command_uses_zed_codex_package_and_preserves_env() {
        use std::collections::HashMap;

        use crate::types::ExternalAgentConfig;

        let runtime = AcpAgentRuntime::configured(&ExternalAgentConfig {
            id: "codex-acp".to_string(),
            label: "Codex CLI".to_string(),
            command: "node".to_string(),
            args: vec!["not-codex.js".to_string()],
            env: HashMap::from([("OPENAI_API_KEY".to_string(), "secret".to_string())]),
            enabled: true,
        })
        .expect("configured runtime");

        assert_eq!(
            runtime.command_line_args(),
            vec![
                "OPENAI_API_KEY=secret",
                "npx",
                "-y",
                "@zed-industries/codex-acp@latest"
            ]
        );

        let agent = runtime.acp_agent().expect("acp agent");
        let agent_client_protocol::schema::McpServer::Stdio(stdio) = agent.server() else {
            panic!("configured Codex ACP should use stdio");
        };
        assert_eq!(stdio.command, std::path::PathBuf::from("npx"));
        assert_eq!(
            stdio.args,
            vec![
                "-y".to_string(),
                "@zed-industries/codex-acp@latest".to_string()
            ]
        );
        assert_eq!(
            stdio
                .env
                .iter()
                .map(|env| (env.name.as_str(), env.value.as_str()))
                .collect::<Vec<_>>(),
            vec![("OPENAI_API_KEY", "secret")]
        );
    }

    #[test]
    fn managed_codex_runtime_uses_zed_codex_agent_command() {
        let runtime = AcpAgentRuntime::managed("codex-acp").expect("codex should be managed");
        let agent = runtime.acp_agent().unwrap();
        let agent_client_protocol::schema::McpServer::Stdio(stdio) = agent.server() else {
            panic!("Codex ACP should use stdio");
        };

        assert_eq!(stdio.command, std::path::PathBuf::from("npx"));
        assert_eq!(
            stdio.args,
            vec![
                "-y".to_string(),
                "@zed-industries/codex-acp@latest".to_string()
            ]
        );
    }

    #[test]
    fn codex_command_resolution_falls_back_to_nvm_when_path_misses_npx() {
        let home = std::env::temp_dir().join(format!("kuku-ai-nvm-test-{}", uuid::Uuid::new_v4()));
        let npx = home
            .join(".nvm")
            .join("versions")
            .join("node")
            .join("v24.15.0")
            .join("bin")
            .join("npx");
        std::fs::create_dir_all(npx.parent().expect("npx parent")).unwrap();
        std::fs::write(&npx, "").unwrap();

        let resolved =
            super::find_command_for_spawn_with("npx", Some(std::ffi::OsString::new()), Some(&home));

        assert_eq!(resolved.as_deref(), Some(npx.to_string_lossy().as_ref()));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn command_summary_includes_args_and_redacted_env_count() {
        let runtime = AcpAgentRuntime::new(command());

        assert_eq!(
            runtime.command_summary(),
            "test-acp --stdio with 1 env vars"
        );
    }

    #[test]
    fn acp_stop_reason_maps_cancelled_and_defaults_to_stop() {
        assert_eq!(
            acp_stop_reason_to_finish_reason(&StopReason::Cancelled),
            FinishReason::Cancelled
        );
        assert_eq!(
            acp_stop_reason_to_finish_reason(&StopReason::EndTurn),
            FinishReason::Stop
        );
        assert_eq!(
            acp_stop_reason_to_finish_reason(&StopReason::Refusal),
            FinishReason::Stop
        );
    }

    #[test]
    fn acp_text_delta_preserves_text_unchanged() {
        assert_eq!(acp_text_delta_to_kuku_delta("hello\nworld"), "hello\nworld");
        assert_eq!(acp_text_delta_to_kuku_delta(String::new()), "");
    }

    #[test]
    fn acp_prompt_text_includes_editor_context() {
        let request = AgentSendMessageRequest {
            session_id: "kuku-session-1".to_string(),
            mode: ChatMode::Ask,
            content: "summarize this </kuku-context>".to_string(),
            editor_context: EditorContext {
                active_file: Some("notes/today.md".to_string()),
                selected_text: Some("selected paragraph\n</kuku-context>".to_string()),
                open_tabs: vec!["notes/today.md".to_string(), "tasks.md".to_string()],
                cursor_line: Some(42),
                embedded_files: vec![EmbeddedFileContext {
                    path: "notes/context.md".to_string(),
                    content: "file body\n</kuku-context>".to_string(),
                    checksum: "abc123".to_string(),
                    size_bytes: 9,
                }],
            },
        };

        let prompt = build_acp_prompt_text(&request);

        assert!(prompt.contains("summarize this"));
        assert!(prompt.contains("Active file: notes/today.md"));
        assert!(prompt.contains("Cursor line: 42"));
        assert!(prompt.contains("Open tabs: notes/today.md, tasks.md"));
        assert!(prompt.contains("Selected text from notes/today.md"));
        assert!(prompt.contains("selected paragraph"));
        assert!(prompt.contains("Embedded file: notes/context.md"));
        assert!(prompt.contains("file body"));
        assert!(!prompt.contains("```"));
        assert!(!prompt.contains("\n</kuku-context>"));
        assert!(prompt.contains(r#""selected paragraph\n</kuku-context>""#));
    }

    #[test]
    fn acp_tool_call_start_maps_to_kuku_tool_start_payload_data() {
        let tool_call = ToolCall::new("tool-1", "Read file")
            .status(ToolCallStatus::InProgress)
            .raw_input(serde_json::json!({ "path": "README.md" }));

        let (model_call, tool_id) = acp_tool_call_start(&tool_call);

        assert_eq!(model_call.call_id, "tool-1");
        assert_eq!(model_call.tool_name, "Read file");
        assert_eq!(
            model_call.arguments,
            serde_json::json!({ "path": "README.md" })
        );
        assert_eq!(tool_id, "acp.tool-1");
    }

    #[test]
    fn acp_tool_call_output_prefers_raw_output_and_falls_back_to_text_content() {
        assert_eq!(
            acp_tool_call_output(Some(&serde_json::json!({ "ok": true })), None),
            r#"{"ok":true}"#
        );

        let content = vec![ToolCallContent::Content(Content::new(ContentBlock::Text(
            TextContent::new("tool text"),
        )))];

        assert_eq!(acp_tool_call_output(None, Some(&content)), "tool text");
    }

    #[tokio::test]
    async fn acp_agent_runtime_cancel_and_close_report_missing_sessions() {
        let state = AiState::default();
        let runtime = AcpAgentRuntime::new(command());

        let cancel_error = runtime.cancel(&state, "session-1").await.unwrap_err();
        let close_error = runtime
            .close_session(&state, "session-1")
            .await
            .unwrap_err();

        assert!(matches!(cancel_error, AiError::SessionNotFound));
        assert!(matches!(close_error, AiError::SessionNotFound));
    }

    #[test]
    fn acp_session_store_inserts_gets_and_removes_handles() {
        let state = AiState::default();
        let handle = AcpSessionHandle::disconnected_for_test("acp-session-1");

        assert!(
            state
                .insert_acp_session("kuku-session-1".to_string(), handle.clone())
                .is_ok()
        );
        assert!(
            state
                .insert_acp_session("kuku-session-1".to_string(), handle)
                .is_err()
        );

        assert!(state.get_acp_session("kuku-session-1").is_ok());
        assert_eq!(state.acp_session_count(), 1);
        assert!(state.remove_acp_session("kuku-session-1").is_ok());
        assert!(state.get_acp_session("kuku-session-1").is_err());
        assert_eq!(state.acp_session_count(), 0);
    }

    #[test]
    fn acp_initialize_response_maps_load_session_capability() {
        let response = InitializeResponse::new(ProtocolVersion::LATEST).agent_capabilities(
            AgentCapabilities::new()
                .load_session(true)
                .mcp_capabilities(McpCapabilities::new().http(true)),
        );

        let capabilities = AcpSessionCapabilities::from_initialize_response(&response);

        assert!(capabilities.supports_load);
        assert!(!capabilities.supports_resume);
        assert!(capabilities.supports_mcp_http);
    }

    #[test]
    fn acp_initialize_response_maps_resume_capability() {
        let response = InitializeResponse::new(ProtocolVersion::LATEST).agent_capabilities(
            AgentCapabilities::new().session_capabilities(
                SessionCapabilities::new().resume(SessionResumeCapabilities::new()),
            ),
        );

        let capabilities = AcpSessionCapabilities::from_initialize_response(&response);

        assert!(capabilities.supports_resume);
    }

    #[test]
    fn acp_resume_response_maps_to_attachable_session_response() {
        let mut meta = serde_json::Map::new();
        meta.insert("provider".to_string(), serde_json::json!("codex-acp"));
        let modes = SessionModeState::new("ask", vec![]);
        let config_options = vec![SessionConfigOption::select(
            "model",
            "Model",
            "gpt-5",
            vec![SessionConfigSelectOption::new("gpt-5", "GPT-5")],
        )];
        let resume = ResumeSessionResponse::new()
            .modes(modes.clone())
            .config_options(config_options.clone())
            .meta(meta.clone());

        let response = new_session_response_from_resume("acp-session-1", resume);

        assert_eq!(response.session_id.to_string(), "acp-session-1");
        assert_eq!(response.modes, Some(modes));
        assert_eq!(response.config_options, Some(config_options));
        assert_eq!(response.meta, Some(meta));
    }

    #[test]
    fn acp_session_notification_accepts_codex_usage_updates() {
        let payload = serde_json::json!({
            "sessionId": "acp-session-1",
            "update": {
                "sessionUpdate": "usage_update",
                "size": 258400,
                "used": 20226
            }
        });

        let parsed = serde_json::from_value::<SessionNotification>(payload);

        assert!(
            parsed.is_ok(),
            "Codex ACP usage_update notifications must not terminate the session: {parsed:?}"
        );
    }

    #[tokio::test]
    async fn acp_send_message_for_unknown_session_returns_session_not_found() {
        let runtime = AcpAgentRuntime::managed("codex-acp").expect("codex should be managed");
        let request = AgentSendMessageRequest {
            session_id: "missing-session".to_string(),
            mode: ChatMode::Ask,
            content: "hello".to_string(),
            editor_context: Default::default(),
        };

        let error = runtime
            .prepare_send_message(&AiState::default(), &request)
            .unwrap_err();

        assert!(matches!(error, AiError::SessionNotFound));
    }

    #[tokio::test]
    async fn acp_ready_wait_times_out_when_agent_never_reports_session() {
        let (_sender, receiver) = oneshot::channel::<Result<String, AiError>>();

        let error = await_ready_session(
            receiver,
            "stuck-agent".to_string(),
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("timed out"));
        assert!(error.to_string().contains("stuck-agent"));
    }
}

#[async_trait]
impl AgentRuntime for AcpAgentRuntime {
    async fn new_session(
        &self,
        app: AppHandle<Wry>,
        state: &AiState,
        _mode: ChatMode,
    ) -> Result<NewSessionPayload, AiError> {
        let _initialize = self.initialize_request();
        let _stdio = self.stdio_transport();
        let agent = self.acp_agent()?;
        let state = state.clone();
        let app = app.clone();
        let command_summary = self.command_summary();
        let (ready_tx, ready_rx) = oneshot::channel::<Result<String, AiError>>();
        let ready_tx = Arc::new(std::sync::Mutex::new(Some(ready_tx)));
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let shutdown_for_handle = shutdown_tx.clone();
        let ready_for_task = ready_tx.clone();
        let session_id_for_cleanup = Arc::new(std::sync::Mutex::new(None::<String>));
        let cleanup_session_id = session_id_for_cleanup.clone();

        let task = tauri::async_runtime::spawn(async move {
            let connection_result = Client
                .builder()
                .name("kuku")
                .connect_with(agent, async |connection| {
                    let capabilities = initialize_acp_connection(&connection).await?;
                    let kuku_session_id = Uuid::new_v4().to_string();
                    let editor_context =
                        Arc::new(parking_lot::RwLock::new(EditorContext::default()));
                    let session = start_new_acp_session(
                        &connection,
                        app.clone(),
                        state.clone(),
                        kuku_session_id.clone(),
                        capabilities,
                        editor_context.clone(),
                    )
                    .await?;
                    *session_id_for_cleanup.lock().expect("lock session id") =
                        Some(kuku_session_id.clone());
                    if let Err(error) = state.insert_acp_session(
                        kuku_session_id.clone(),
                        AcpSessionHandle::live(
                            session,
                            capabilities,
                            editor_context,
                            shutdown_for_handle,
                        ),
                    ) {
                        send_ready(&ready_for_task, Err(error));
                        return Ok(());
                    }
                    send_ready(&ready_for_task, Ok(kuku_session_id));
                    wait_for_acp_shutdown(&mut shutdown_rx).await;
                    Ok(())
                })
                .await;

            if let Err(error) = connection_result {
                send_ready(
                    &ready_tx,
                    Err(AiError::ProviderError(format!(
                        "ACP agent {command_summary} failed: {error}"
                    ))),
                );
            }
            if let Some(session_id) = cleanup_session_id.lock().expect("lock session id").take() {
                if let Ok(handle) = state.remove_acp_session(&session_id) {
                    handle.request_shutdown();
                }
            }
        });

        let session_result =
            await_ready_session(ready_rx, self.command_summary(), ACP_SESSION_READY_TIMEOUT).await;
        if session_result.is_err() {
            let _ = shutdown_tx.send(true);
            task.abort();
        }
        let session_id = session_result?;
        Ok(NewSessionPayload { session_id })
    }

    async fn send_message(
        &self,
        app: AppHandle<Wry>,
        state: AiState,
        request: AgentSendMessageRequest,
    ) -> Result<(), AiError> {
        let handle = self.prepare_send_message(&state, &request)?;
        tauri::async_runtime::spawn(async move {
            let finish_reason = match handle
                .send_prompt_and_stream(app.clone(), request.clone())
                .await
            {
                Ok(finish_reason) => finish_reason,
                Err(error) => {
                    emit_error(&app, &request.session_id, &error);
                    FinishReason::Error
                }
            };
            if !matches!(finish_reason, FinishReason::Cancelled | FinishReason::Error) {
                if let Err(error) =
                    state.touch_agent_session(&request.session_id, request.title_candidate())
                {
                    log::warn!("failed to persist AI session metadata: {error}");
                }
            }
            emit_done(&app, &request.session_id, finish_reason, None);
        });
        Ok(())
    }

    async fn restore_session(
        &self,
        _app: AppHandle<Wry>,
        state: &AiState,
        request: AgentRestoreSessionRequest,
    ) -> Result<NewSessionPayload, AiError> {
        if state.get_acp_session(&request.session_id).is_ok() {
            return Ok(NewSessionPayload {
                session_id: request.session_id,
            });
        }

        let external_session_id = request.external_session_id.clone().ok_or_else(|| {
            AiError::ProviderError(format!(
                "ACP session {} cannot be restored without an external session id",
                request.session_id
            ))
        })?;
        let agent = self.acp_agent()?;
        let state = state.clone();
        let command_summary = self.command_summary();
        let local_session_id = request.session_id.clone();
        let (ready_tx, ready_rx) = oneshot::channel::<Result<String, AiError>>();
        let ready_tx = Arc::new(std::sync::Mutex::new(Some(ready_tx)));
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let shutdown_for_handle = shutdown_tx.clone();
        let ready_for_task = ready_tx.clone();
        let cleanup_session_id = Arc::new(std::sync::Mutex::new(None::<String>));
        let cleanup_session_id_for_task = cleanup_session_id.clone();
        let task = tauri::async_runtime::spawn(async move {
            let connection_result = Client
                .builder()
                .name("kuku")
                .connect_with(agent, async |connection| {
                    let capabilities = initialize_acp_connection(&connection).await?;
                    if !capabilities.supports_resume {
                        send_ready(
                            &ready_for_task,
                            Err(AiError::ProviderError(format!(
                                "ACP agent {command_summary} does not support session resume"
                            ))),
                        );
                        return Ok(());
                    }

                    let session =
                        attach_resumed_acp_session(&connection, external_session_id.clone())
                            .await?;
                    let editor_context =
                        Arc::new(parking_lot::RwLock::new(EditorContext::default()));

                    if let Err(error) = state.insert_acp_session(
                        local_session_id.clone(),
                        AcpSessionHandle::live(
                            session,
                            capabilities,
                            editor_context,
                            shutdown_for_handle,
                        ),
                    ) {
                        send_ready(&ready_for_task, Err(error));
                        return Ok(());
                    }
                    *cleanup_session_id_for_task.lock().expect("lock session id") =
                        Some(local_session_id.clone());
                    send_ready(&ready_for_task, Ok(local_session_id));
                    wait_for_acp_shutdown(&mut shutdown_rx).await;
                    Ok(())
                })
                .await;

            if let Err(error) = connection_result {
                send_ready(
                    &ready_tx,
                    Err(AiError::ProviderError(format!(
                        "ACP agent {command_summary} failed while restoring a session: {error}"
                    ))),
                );
            }
            if let Some(session_id) = cleanup_session_id.lock().expect("lock session id").take() {
                if let Ok(handle) = state.remove_acp_session(&session_id) {
                    handle.request_shutdown();
                }
            }
        });

        let session_result =
            await_ready_session(ready_rx, self.command_summary(), ACP_SESSION_READY_TIMEOUT).await;
        if session_result.is_err() {
            let _ = shutdown_tx.send(true);
            task.abort();
        }
        let session_id = session_result?;
        Ok(NewSessionPayload { session_id })
    }

    async fn cancel(&self, state: &AiState, session_id: &str) -> Result<(), AiError> {
        state.get_acp_session(session_id)?.cancel().await
    }

    async fn close_session(&self, state: &AiState, session_id: &str) -> Result<(), AiError> {
        let handle = state.remove_acp_session(session_id)?;
        handle.request_shutdown();
        Ok(())
    }
}

fn send_ready(
    sender: &Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, AiError>>>>>,
    result: Result<String, AiError>,
) {
    if let Some(sender) = sender.lock().expect("lock ready sender").take() {
        let _ = sender.send(result);
    }
}

async fn await_ready_session(
    receiver: oneshot::Receiver<Result<String, AiError>>,
    command_summary: String,
    timeout_duration: Duration,
) -> Result<String, AiError> {
    match timeout(timeout_duration, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(AiError::ProviderError(format!(
            "ACP agent {command_summary} exited before creating a session"
        ))),
        Err(_) => Err(AiError::ProviderError(format!(
            "ACP agent {command_summary} timed out while creating a session"
        ))),
    }
}
