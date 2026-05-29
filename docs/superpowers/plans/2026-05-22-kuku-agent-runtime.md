# Kuku Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Kuku users choose between the built-in Kuku Agent and external ACP-compatible agents such as Codex CLI, Claude Agent, Gemini CLI, and custom agents from the same AI chat panel.

**Architecture:** Keep the existing Kuku agent runtime and tools intact, then add a unified agent runtime layer above it. The built-in Kuku Agent remains backed by the current `kuku-ai` session/tool/provider loop, while external agents run as ACP subprocesses and stream their updates into the same chat UI event model.

**Tech Stack:** Rust 2024, Tauri 2, SolidJS, `agent-client-protocol`, `agent-client-protocol-tokio`, existing `kuku-ai` native/proxy tool registry, existing Kuku plugin settings storage.

---

## Product Shape

Kuku should behave like the Zed agent selector shown by the user:

- `Kuku Agent` is the first-party built-in agent.
- `External Agents` includes managed entries such as `Claude Agent`, `Codex CLI`, `Gemini CLI`, and later `Pi`.
- `Add More Agents` opens settings for registry or custom command configuration.
- Each chat thread is owned by exactly one agent runtime. Switching the selector starts a new thread unless the selected agent already has an active thread.

Kuku is not exposing itself as an ACP agent server for other clients in this plan. It is acting as an ACP client/host for external agents while preserving the current native Kuku Agent.

## Current Code Context

The existing AI system is already close to the needed shape:

- `crates/kuku-ai/src/session.rs` owns in-memory Kuku sessions and turn execution.
- `crates/kuku-ai/src/state.rs` stores sessions, config, provider, tools, proxy broker, and host bindings.
- `crates/kuku-ai/src/provider/mod.rs` abstracts completion backends.
- `crates/kuku-ai/src/commands.rs` exposes Tauri commands such as `ai_new_session`, `ai_send_message`, and `ai_cancel`.
- `apps/desktop/src/plugins/builtin/ai_chat/chat_store.ts` owns the frontend chat state.
- `apps/desktop/src/plugins/builtin/ai_chat/event_bridge.ts` maps Rust events into chat state.
- `apps/desktop/src/plugins/builtin/ai_chat/proxy_tool_bridge.ts` registers frontend proxy tools with `kuku-ai`.
- `apps/desktop/src-tauri/src/ai_tools/mod.rs` registers native file/search/document tools.

## Long-Term Roadmap

### Phase 1: Runtime Identity and Agent Selector

Add first-class agent identity before adding ACP transport. This keeps UI and session semantics stable while the backend is still native-only.

Deliverables:

- Agent catalog containing `kuku-native` and disabled external entries.
- Chat session state includes `agentId`.
- Header selector shows Kuku Agent and external agent entries.
- Creating a session stores the selected agent.

Success criteria:

- Existing Kuku Agent behavior is unchanged.
- User can select Kuku Agent explicitly.
- External entries are visible but marked unavailable until ACP runtime lands.

### Phase 2: Unified Runtime Boundary

Introduce a backend-side runtime abstraction above the current session loop.

Deliverables:

- New Rust module `crates/kuku-ai/src/agent_runtime/`.
- `AgentRuntime` trait with `new_session`, `send_message`, `cancel`, and `close_session`.
- `NativeAgentRuntime` wraps existing `AiState::create_session` and `session::run_turn`.
- Existing Tauri commands route through runtime selection instead of directly calling session functions.

Success criteria:

- Existing tests pass.
- No user-visible behavior change for Kuku Agent.
- The code has a clear place to add ACP without touching native tool execution.

### Phase 3: ACP External Agent Runtime

Add ACP subprocess support for one external agent first, preferably Codex CLI via the ACP adapter, then generalize.

Deliverables:

- Add `agent-client-protocol` and `agent-client-protocol-tokio` to `crates/kuku-ai`.
- New `AcpAgentRuntime` launches and manages external ACP agent processes.
- Map ACP `session/new`, `session/prompt`, `session/cancel`, and `session/close` to Kuku commands.
- Map ACP `session/update` notifications into existing Kuku events.

Success criteria:

- Codex CLI can be selected and used in the Kuku chat panel.
- Streaming assistant text appears in the same transcript UI.
- Cancellation works.
- Authentication remains owned by the external agent or its environment.

### Phase 4: Agent Configuration and Managed Installs

Move from hardcoded agents to configurable agents.

Deliverables:

- Settings schema for agent entries: id, label, kind, command, args, env, cwd behavior, install status, capabilities.
- Built-in managed definitions for Codex, Claude Agent, Gemini CLI, and Pi when an ACP entrypoint is available.
- Custom agent form for command/args/env.
- Debug view for ACP logs.

Success criteria:

- Users can add a custom ACP agent command without code changes.
- Built-in external agent entries can be enabled/disabled.
- Logs make protocol failures diagnosable.

### Phase 5: Session Persistence and Capability-Aware UI

Persist enough metadata to make external agent sessions usable across app restarts when the agent supports it.

Deliverables:

- Persist Kuku chat sessions locally.
- Store agent capabilities from ACP `initialize`.
- Support `session/load` and `session/resume` only when advertised by the agent.
- Hide or disable unsupported features such as editing past messages, checkpointing, or replay when the selected agent cannot support them.

Success criteria:

- Restarting Kuku shows prior threads.
- Kuku Agent sessions retain today’s behavior.
- External agents degrade cleanly when they do not support load/resume.

### Phase 6: Kuku Tool Bridge for External Agents

Expose Kuku context and tools to external ACP agents through MCP, after the base ACP client is reliable.

Deliverables:

- Local MCP server backed by Kuku vault read/search/edit/proposal tools.
- ACP `session/new` passes the Kuku MCP server in `mcpServers`.
- Tool calls that mutate files continue through Kuku approval/diff UI where possible.
- Read-only tools work without approval.

Success criteria:

- External agents can read Kuku vault context without bypassing Kuku’s path restrictions.
- Mutating operations do not silently edit protected paths.
- The user sees a consistent approval flow for Kuku-managed tools.

### Phase 7: Hardening, Packaging, and Policy

Make the feature reliable enough for default availability.

Deliverables:

- Process lifecycle cleanup.
- Environment variable redaction in logs.
- Per-agent timeout and kill policy.
- Per-agent permissions summary.
- Smoke tests for native agent plus at least one ACP agent fixture.

Success criteria:

- Closing a thread does not leave orphan subprocesses.
- Failed agents produce actionable UI errors.
- Sensitive env values are never shown in logs.

## Proposed File Structure

Create:

- `crates/kuku-ai/src/agent_runtime/mod.rs`: public runtime trait, shared request/event types.
- `crates/kuku-ai/src/agent_runtime/native.rs`: adapter around current Kuku session loop.
- `crates/kuku-ai/src/agent_runtime/acp.rs`: ACP subprocess runtime and protocol mapping.
- `crates/kuku-ai/src/agent_runtime/catalog.rs`: built-in and user-configured agent definitions.
- `crates/kuku-ai/src/agent_runtime/events.rs`: shared event emission helpers for native and ACP runtimes.
- `crates/kuku-ai/src/agent_runtime/store.rs`: persisted session/agent metadata after Phase 5.
- `apps/desktop/src/plugins/builtin/ai_chat/agent_catalog.ts`: frontend catalog types and selectors.
- `apps/desktop/src/plugins/builtin/ai_chat/components/agent_selector.tsx`: Zed-style selector UI.
- `apps/desktop/src/plugins/builtin/ai_chat/components/agent_settings.tsx`: external agent settings.
- `apps/desktop/src/plugins/builtin/ai_chat/acp_event_mapping.test.ts`: frontend event mapping tests.

Modify:

- `crates/kuku-ai/src/lib.rs`: export runtime types and register new commands.
- `crates/kuku-ai/src/state.rs`: store runtime registry and agent metadata.
- `crates/kuku-ai/src/session.rs`: move reusable event emission into `agent_runtime/events.rs`.
- `crates/kuku-ai/src/commands.rs`: route commands through selected runtime.
- `crates/kuku-ai/src/types.rs`: add `AgentId`, `AgentKind`, `AgentDescriptor`, session agent metadata.
- `crates/kuku-ai/Cargo.toml`: add ACP dependencies.
- `apps/desktop/src/plugins/builtin/ai_chat/types.ts`: add agent fields to session/config state.
- `apps/desktop/src/plugins/builtin/ai_chat/chat_store.ts`: select agent, create sessions for selected agent, handle capability state.
- `apps/desktop/src/plugins/builtin/ai_chat/components/chat_header.tsx`: add selector entry point.
- `apps/desktop/src/plugins/builtin/ai_chat/components/ai_settings.tsx`: link to agent settings.
- `apps/desktop/src/i18n/keys.ts` and locale files: add agent selector/settings labels.

## Implementation Tasks

### Task 1: Add Agent Identity to Shared Types

**Files:**

- Modify: `crates/kuku-ai/src/types.rs`
- Modify: `apps/desktop/src/plugins/builtin/ai_chat/types.ts`
- Test: `apps/desktop/src/plugins/builtin/ai_chat/chat_store.test.ts`

- [x] **Step 1: Add Rust agent types**

Add these definitions to `crates/kuku-ai/src/types.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct AgentId(pub String);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentKind {
    Native,
    Acp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDescriptor {
    pub id: AgentId,
    pub label: String,
    pub kind: AgentKind,
    pub enabled: bool,
    pub managed: bool,
}

impl AgentId {
    pub fn kuku_native() -> Self {
        Self("kuku-native".to_string())
    }
}
```

- [x] **Step 2: Add TypeScript agent types**

Add these definitions to `apps/desktop/src/plugins/builtin/ai_chat/types.ts`:

```ts
type AgentKind = "native" | "acp";
type AgentId = string;

interface AgentDescriptor {
  id: AgentId;
  label: string;
  kind: AgentKind;
  enabled: boolean;
  managed: boolean;
}
```

Extend `ChatSessionState`:

```ts
interface ChatSessionState {
  id: string;
  agentId: AgentId;
  mode: ChatMode;
  createdAt: number;
  updatedAt: number;
  draft: string;
  fileAttachments: ChatFileAttachmentDraft[];
  messages: ChatMessage[];
  inflightAssistantId: string | null;
  autoApprove: boolean;
  status: ChatSessionStatus;
  error: string | null;
  finishReason: FinishReason | null;
}
```

- [x] **Step 3: Update session factory**

Change `createSessionState` in `apps/desktop/src/plugins/builtin/ai_chat/chat_store.ts` to accept `agentId`:

```ts
const DEFAULT_AGENT_ID = "kuku-native";

function createSessionState(
  id: string,
  mode: ChatMode,
  agentId: AgentId = DEFAULT_AGENT_ID,
): ChatSessionState {
  const now = nextSessionTimestamp();
  return {
    id,
    agentId,
    mode,
    createdAt: now,
    updatedAt: now,
    draft: "",
    fileAttachments: [],
    messages: [],
    inflightAssistantId: null,
    autoApprove: false,
    status: "idle",
    error: null,
    finishReason: null,
  };
}
```

- [x] **Step 4: Run focused tests**

Run:

```bash
pnpm --filter desktop test -- chat_store
```

Expected: existing chat store tests pass after updating any fixture session objects with `agentId: "kuku-native"`.

### Task 2: Add Frontend Agent Catalog and Selector

**Files:**

- Create: `apps/desktop/src/plugins/builtin/ai_chat/agent_catalog.ts`
- Create: `apps/desktop/src/plugins/builtin/ai_chat/components/agent_selector.tsx`
- Modify: `apps/desktop/src/plugins/builtin/ai_chat/chat_store.ts`
- Modify: `apps/desktop/src/plugins/builtin/ai_chat/components/chat_header.tsx`
- Modify: `apps/desktop/src/i18n/keys.ts`
- Modify: `apps/desktop/src/i18n/locales/en.ts`
- Modify: `apps/desktop/src/i18n/locales/ko.ts`
- Modify: `apps/desktop/src/i18n/locales/ja.ts`

- [x] **Step 1: Define initial catalog**

Create `apps/desktop/src/plugins/builtin/ai_chat/agent_catalog.ts`:

```ts
import type { AgentDescriptor } from "./types";

const KUKU_NATIVE_AGENT_ID = "kuku-native";

const BUILTIN_AGENT_CATALOG: AgentDescriptor[] = [
  {
    id: KUKU_NATIVE_AGENT_ID,
    label: "Kuku Agent",
    kind: "native",
    enabled: true,
    managed: true,
  },
  {
    id: "claude-acp",
    label: "Claude Agent",
    kind: "acp",
    enabled: false,
    managed: true,
  },
  {
    id: "codex-acp",
    label: "Codex CLI",
    kind: "acp",
    enabled: false,
    managed: true,
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    kind: "acp",
    enabled: false,
    managed: true,
  },
];

export { BUILTIN_AGENT_CATALOG, KUKU_NATIVE_AGENT_ID };
```

- [x] **Step 2: Add selected agent state**

Extend `ChatStoreState` in `types.ts`:

```ts
interface ChatStoreState {
  selectedAgentId: AgentId;
  agents: AgentDescriptor[];
  selectedMode: ChatMode;
  permissionPreset: ChatPermissionPresetId;
  activeSessionId: string | null;
  sessions: Record<string, ChatSessionState>;
  isCreatingSession: boolean;
  isSendingMessage: boolean;
  config: ChatConfigState;
}
```

Initialize in `chat_store.ts`:

```ts
selectedAgentId: KUKU_NATIVE_AGENT_ID,
agents: BUILTIN_AGENT_CATALOG,
```

- [x] **Step 3: Implement selector component**

Create `apps/desktop/src/plugins/builtin/ai_chat/components/agent_selector.tsx`:

```tsx
import { For } from "solid-js";
import { chatState, setSelectedAgent } from "../chat_store";
import { KUKU_NATIVE_AGENT_ID } from "../agent_catalog";

function AgentSelector() {
  const selected = () =>
    chatState.agents.find((agent) => agent.id === chatState.selectedAgentId) ??
    chatState.agents.find((agent) => agent.id === KUKU_NATIVE_AGENT_ID);

  return (
    <div class="relative">
      <select
        class="h-8 rounded-sm border border-border bg-bg-primary px-2 text-sm text-text-primary"
        value={chatState.selectedAgentId}
        onChange={(event) => setSelectedAgent(event.currentTarget.value)}
        aria-label="Select AI agent"
      >
        <For each={chatState.agents}>
          {(agent) => (
            <option value={agent.id} disabled={!agent.enabled}>
              {agent.label}
              {!agent.enabled ? " (Not configured)" : ""}
            </option>
          )}
        </For>
      </select>
      <span class="sr-only">{selected()?.label ?? "Kuku Agent"}</span>
    </div>
  );
}

export { AgentSelector };
```

- [x] **Step 4: Wire selector into header**

Import and render `AgentSelector` in `chat_header.tsx` near the current title. Keep the current chat mode controls unchanged.

- [x] **Step 5: Run UI tests**

Run:

```bash
pnpm --filter desktop test -- ai_chat
```

Expected: existing AI chat tests pass after snapshots or text queries are adjusted for the selector.

### Task 3: Add Backend Runtime Abstraction

**Files:**

- Create: `crates/kuku-ai/src/agent_runtime/mod.rs`
- Create: `crates/kuku-ai/src/agent_runtime/native.rs`
- Modify: `crates/kuku-ai/src/lib.rs`
- Modify: `crates/kuku-ai/src/state.rs`
- Modify: `crates/kuku-ai/src/commands.rs`

- [x] **Step 1: Add runtime trait**

Create `crates/kuku-ai/src/agent_runtime/mod.rs`:

```rust
pub mod native;

use async_trait::async_trait;
use tauri::{AppHandle, Wry};

use crate::{AiError, ChatMode, EditorContext, NewSessionPayload, state::AiState};

#[derive(Debug, Clone)]
pub struct AgentSendMessageRequest {
    pub session_id: String,
    pub mode: ChatMode,
    pub content: String,
    pub editor_context: EditorContext,
}

#[async_trait]
pub trait AgentRuntime: Send + Sync {
    async fn new_session(
        &self,
        state: &AiState,
        mode: ChatMode,
    ) -> Result<NewSessionPayload, AiError>;

    async fn send_message(
        &self,
        app: AppHandle<Wry>,
        state: AiState,
        request: AgentSendMessageRequest,
    ) -> Result<(), AiError>;

    async fn cancel(&self, state: &AiState, session_id: String) -> Result<(), AiError>;

    async fn close_session(&self, state: &AiState, session_id: String) -> Result<(), AiError>;
}
```

- [x] **Step 2: Wrap native runtime**

Add this helper to `crates/kuku-ai/src/state.rs`:

```rust
pub fn remove_session(&self, session_id: &str) {
    self.inner.sessions.write().remove(session_id);
}
```

Create `crates/kuku-ai/src/agent_runtime/native.rs`:

```rust
use async_trait::async_trait;
use tauri::{AppHandle, Wry};

use crate::{
    AiError, ChatMode, NewSessionPayload,
    agent_runtime::{AgentRuntime, AgentSendMessageRequest},
    session,
    state::AiState,
};

#[derive(Debug, Default)]
pub struct NativeAgentRuntime;

#[async_trait]
impl AgentRuntime for NativeAgentRuntime {
    async fn new_session(
        &self,
        state: &AiState,
        mode: ChatMode,
    ) -> Result<NewSessionPayload, AiError> {
        let session = state.create_session(mode);
        Ok(NewSessionPayload {
            session_id: session.id.clone(),
        })
    }

    async fn send_message(
        &self,
        app: AppHandle<Wry>,
        state: AiState,
        request: AgentSendMessageRequest,
    ) -> Result<(), AiError> {
        let session = state.get_session(&request.session_id)?;
        tauri::async_runtime::spawn(async move {
            session::run_turn(
                app,
                state,
                session,
                request.mode,
                request.content,
                request.editor_context,
            )
            .await;
        });
        Ok(())
    }

    async fn cancel(&self, state: &AiState, session_id: String) -> Result<(), AiError> {
        let session = state.get_session(&session_id)?;
        session.cancel();
        Ok(())
    }

    async fn close_session(&self, state: &AiState, session_id: String) -> Result<(), AiError> {
        let session = state.get_session(&session_id)?;
        session.cancel();
        state.remove_session(&session_id);
        Ok(())
    }
}
```

- [x] **Step 3: Export module**

Add to `crates/kuku-ai/src/lib.rs`:

```rust
mod agent_runtime;
```

- [x] **Step 4: Route commands through native runtime**

Update `commands.rs` so current commands use `NativeAgentRuntime` first. This is an interim step before runtime registry selection.

- [x] **Step 5: Run Rust tests**

Run:

```bash
cargo test -p kuku-ai
```

Expected: all existing `kuku-ai` tests pass with no behavior change.

### Task 4: Add Runtime Registry and Agent-Aware Commands

**Files:**

- Modify: `crates/kuku-ai/src/state.rs`
- Modify: `crates/kuku-ai/src/commands.rs`
- Modify: `crates/kuku-ai/src/types.rs`
- Modify: `apps/desktop/src/plugins/builtin/ai_chat/chat_store.ts`

- [x] **Step 1: Add agent id to command payloads**

Add a payload type to `types.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAgentSessionRequest {
    pub agent_id: AgentId,
    pub mode: ChatMode,
}
```

- [x] **Step 2: Add runtime lookup**

In `AiState`, add a method:

```rust
pub fn runtime_for_agent(
    &self,
    agent_id: &crate::types::AgentId,
) -> Arc<dyn crate::agent_runtime::AgentRuntime> {
    match agent_id.0.as_str() {
        "kuku-native" => Arc::new(crate::agent_runtime::native::NativeAgentRuntime),
        _ => Arc::new(crate::agent_runtime::native::NativeAgentRuntime),
    }
}
```

This fallback keeps unsupported external entries from breaking native behavior while the frontend still disables them.

- [x] **Step 3: Pass selected agent from frontend**

Change `createSession` in `chat_store.ts` to send `agentId: chatState.selectedAgentId` to `ai_new_session`.

```ts
const payload = await invoke<NewSessionPayload>("plugin:kuku-ai|ai_new_session", {
  agentId: chatState.selectedAgentId,
  mode,
});
resetToSession(payload.sessionId, mode, chatState.selectedAgentId);
```

- [x] **Step 4: Preserve agent identity on send**

Change `ai_send_message` invocation:

```ts
await invoke<void>("plugin:kuku-ai|ai_send_message", {
  agentId: session.agentId,
  sessionId,
  mode: chatState.selectedMode,
  content: trimmed,
  editorContext: {
    ...editorContext,
    selectedText: preparedSelection.selectedText,
    embeddedFiles: preparedFiles.embeddedFiles,
  },
});
```

- [x] **Step 5: Run mixed tests**

Run:

```bash
cargo test -p kuku-ai
pnpm --filter desktop test -- chat_store
```

Expected: native Kuku Agent still creates sessions and sends messages.

### Task 5: Implement ACP Runtime Prototype

**Files:**

- Modify: `crates/kuku-ai/Cargo.toml`
- Create: `crates/kuku-ai/src/agent_runtime/acp.rs`
- Modify: `crates/kuku-ai/src/agent_runtime/mod.rs`
- Modify: `crates/kuku-ai/src/state.rs`

- [x] **Step 1: Add dependencies**

Run:

```bash
cargo add agent-client-protocol --package kuku-ai
cargo add agent-client-protocol-tokio --package kuku-ai
```

Expected: `crates/kuku-ai/Cargo.toml` and `Cargo.lock` include ACP SDK dependencies.

- [x] **Step 2: Add ACP runtime skeleton**

Create `crates/kuku-ai/src/agent_runtime/acp.rs`:

```rust
use async_trait::async_trait;
use tauri::{AppHandle, Wry};

use crate::{
    AiError, ChatMode, NewSessionPayload,
    agent_runtime::{AgentRuntime, AgentSendMessageRequest},
    state::AiState,
};

#[derive(Debug, Clone)]
pub struct AcpAgentCommand {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct AcpAgentRuntime {
    command: AcpAgentCommand,
}

impl AcpAgentRuntime {
    pub fn new(command: AcpAgentCommand) -> Self {
        Self { command }
    }
}

#[async_trait]
impl AgentRuntime for AcpAgentRuntime {
    async fn new_session(
        &self,
        _state: &AiState,
        _mode: ChatMode,
    ) -> Result<NewSessionPayload, AiError> {
        Err(AiError::ProviderError(format!(
            "ACP agent runtime is not connected yet: {}",
            self.command.command
        )))
    }

    async fn send_message(
        &self,
        _app: AppHandle<Wry>,
        _state: AiState,
        _request: AgentSendMessageRequest,
    ) -> Result<(), AiError> {
        Err(AiError::ProviderError(
            "ACP agent runtime cannot send messages before session creation succeeds".to_string(),
        ))
    }

    async fn cancel(&self, _state: &AiState, _session_id: String) -> Result<(), AiError> {
        Ok(())
    }

    async fn close_session(&self, _state: &AiState, _session_id: String) -> Result<(), AiError> {
        Ok(())
    }
}
```

- [x] **Step 3: Compile the skeleton**

Run:

```bash
cargo check -p kuku-ai
```

Expected: crate compiles. This step proves the runtime boundary can accept ACP dependencies before protocol mapping begins.

### Task 6: Map ACP Events to Kuku Chat Events

**Files:**

- Create: `crates/kuku-ai/src/agent_runtime/events.rs`
- Modify: `crates/kuku-ai/src/session.rs`
- Modify: `crates/kuku-ai/src/agent_runtime/acp.rs`
- Test: `crates/kuku-ai/src/agent_runtime/acp.rs`

- [x] **Step 1: Move event emitters into shared module**

Create `agent_runtime/events.rs` with functions equivalent to the current session emitters:

```rust
use tauri::{AppHandle, Emitter, Wry};

use crate::types::{
    DonePayload, ErrorPayload, FinishReason, StreamChunkPayload, ToolCallEndPayload,
    ToolCallStartPayload,
};

pub fn emit_stream_chunk(app: &AppHandle<Wry>, session_id: &str, delta: String) {
    let _ = app.emit(
        "ai:stream-chunk",
        StreamChunkPayload {
            session_id: session_id.to_string(),
            delta,
        },
    );
}

pub fn emit_done(app: &AppHandle<Wry>, session_id: &str, finish_reason: FinishReason) {
    let _ = app.emit(
        "ai:done",
        DonePayload {
            session_id: session_id.to_string(),
            finish_reason,
            usage: None,
        },
    );
}

pub fn emit_error(app: &AppHandle<Wry>, session_id: &str, message: String) {
    let _ = app.emit(
        "ai:error",
        ErrorPayload {
            session_id: session_id.to_string(),
            message,
        },
    );
}
```

- [x] **Step 2: Reuse shared emitters in native session**

Replace direct local emitter calls in `session.rs` with `crate::agent_runtime::events::*`. Preserve payload shapes so the frontend bridge does not change.

- [x] **Step 3: Define ACP mapping rules**

In `acp.rs`, implement mapping functions:

```rust
fn acp_stop_reason_to_finish_reason(stop_reason: &str) -> crate::types::FinishReason {
    match stop_reason {
        "cancelled" => crate::types::FinishReason::Cancelled,
        _ => crate::types::FinishReason::Stop,
    }
}

fn acp_text_delta_to_kuku_delta(text: String) -> String {
    text
}
```

- [x] **Step 4: Add mapping tests**

Add tests in `acp.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::{acp_stop_reason_to_finish_reason, acp_text_delta_to_kuku_delta};
    use crate::types::FinishReason;

    #[test]
    fn maps_cancelled_stop_reason() {
        assert_eq!(
            acp_stop_reason_to_finish_reason("cancelled"),
            FinishReason::Cancelled
        );
    }

    #[test]
    fn preserves_text_delta() {
        assert_eq!(
            acp_text_delta_to_kuku_delta("hello".to_string()),
            "hello".to_string()
        );
    }
}
```

- [x] **Step 5: Run tests**

Run:

```bash
cargo test -p kuku-ai agent_runtime
```

Expected: event mapping tests pass and native session tests still pass.

### Task 7: Connect One Managed External Agent

**Files:**

- Modify: `crates/kuku-ai/src/agent_runtime/acp.rs`
- Modify: `crates/kuku-ai/src/agent_runtime/catalog.rs`
- Modify: `apps/desktop/src/plugins/builtin/ai_chat/agent_catalog.ts`
- Modify: `apps/desktop/src/plugins/builtin/ai_chat/chat_store.ts`

- [x] **Step 1: Pick Codex as the first managed agent**

Use `codex-acp` as the first enabled external agent only when a configured command is available. Default development command:

```text
codex-acp
```

- [x] **Step 2: Implement ACP process startup**

In `acp.rs`, use `agent-client-protocol-tokio` to spawn the configured command over stdio. Store the active ACP client handle in the runtime session table.

- [x] **Step 3: Implement ACP session creation**

For `new_session`, call ACP `initialize`, then `session/new` with:

```text
cwd = current vault or workspace directory
mcpServers = empty list for Phase 3
```

Return the ACP session id as the Kuku session id for the first prototype.

- [x] **Step 4: Implement ACP prompt**

For `send_message`, call ACP `session/prompt` with a text content block built from `request.content`. Stream `session/update` notifications to Kuku event emitters.

- [ ] **Step 5: Run a manual smoke test**

Run Kuku desktop, select Codex CLI, send:

```text
Summarize this workspace in one paragraph.
```

Expected:

- Kuku displays streamed assistant text.
- Stop button sends ACP `session/cancel`.
- Kuku Agent still works when selected again.

Attempted on 2026-05-23: `pnpm --filter @kuku/desktop tauri:dev` launched Kuku and Vite successfully, but local Computer Use access to the Kuku window was denied, so this manual UI smoke remains unverified.

### Task 8: Add External Agent Settings

**Files:**

- Create: `apps/desktop/src/plugins/builtin/ai_chat/components/agent_settings.tsx`
- Modify: `apps/desktop/src/plugins/builtin/ai_chat/components/ai_settings.tsx`
- Modify: `apps/desktop/src/plugins/builtin/ai_chat/config.ts`
- Modify: `apps/desktop/src/plugins/builtin/ai_chat/types.ts`

- [x] **Step 1: Add settings data model**

Add:

```ts
interface ExternalAgentConfig {
  id: string;
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}
```

- [x] **Step 2: Add settings UI**

Create a compact settings section that lists agents and allows editing command, args, env, and enabled state. Redact env values whose keys include `KEY`, `TOKEN`, `SECRET`, or `PASSWORD`.

- [x] **Step 3: Persist settings**

Reuse `loadPluginSettings` and `savePluginSettings` with secure keys for sensitive env values.

- [x] **Step 3.5: Route configured external agents through backend runtime**

Deserialize `externalAgents` into `kuku-ai` config, expose configured agents from `ai_list_agents`, and route enabled ACP configs through `AcpAgentRuntime` instead of limiting runtime selection to hardcoded managed entries.

- [x] **Step 4: Run settings tests**

Run:

```bash
pnpm --filter desktop test -- ai_settings
```

Expected: settings load/save tests pass and sensitive values do not render as plain text.

### Task 9: Persist Sessions and Capabilities

**Files:**

- Create: `crates/kuku-ai/src/agent_runtime/store.rs`
- Modify: `crates/kuku-ai/src/state.rs`
- Modify: `apps/desktop/src/plugins/builtin/ai_chat/types.ts`
- Modify: `apps/desktop/src/plugins/builtin/ai_chat/chat_store.ts`

- [x] **Step 1: Define persisted metadata**

Persist:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAgentSession {
    pub local_session_id: String,
    pub external_session_id: Option<String>,
    pub agent_id: AgentId,
    pub title: String,
    pub updated_at_ms: u64,
    pub supports_load: bool,
    pub supports_resume: bool,
}
```

- [x] **Step 2: Save metadata on session creation and update**

Store metadata after `new_session` succeeds and after each completed prompt turn.

- [x] **Step 3: Load metadata on app startup**

Expose `ai_list_sessions` and let the frontend rebuild thread summaries before a session is opened.

- [x] **Step 4: Respect ACP capabilities**

Only call ACP `session/load` or `session/resume` when `initialize` advertises support.
The current stable `agent-client-protocol` Rust schema exposes `loadSession`; `session/resume` is an unstable schema feature, so Kuku records `supportsResume: false` until the dependency exposes it in the stable API.

- [x] **Step 5: Run persistence tests**

Run:

```bash
cargo test -p kuku-ai persisted_agent_session
pnpm --filter desktop test -- chat_store
```

Expected: persisted metadata round-trips and unsupported capability actions remain disabled.

### Task 10: Add Kuku MCP Tool Bridge for External Agents

**Files:**

- Create: `crates/kuku-ai/src/mcp_bridge/mod.rs`
- Modify: `crates/kuku-ai/src/agent_runtime/acp.rs`
- Modify: `apps/desktop/src-tauri/src/ai_tools/mod.rs`

- [x] **Step 1: Expose read-only tools first**

Bridge these existing tool categories:

```text
read_file
list_files
search_vault
get_outline
get_tags
```

- [x] **Step 2: Pass MCP server to ACP sessions**

During ACP `session/new`, include the local Kuku MCP server command in `mcpServers`.
Implemented as an in-process ACP MCP server via `SessionBuilder::with_mcp_server`, gated on `initialize.agentCapabilities.mcpCapabilities.http` because the ACP crate publishes the in-process server as HTTP.

- [x] **Step 3: Keep mutation tools behind approval**

Only bridge mutation tools after read-only bridge is stable:

```text
create_file
edit_file
delete_file
move_file
```

Each mutation tool must return a proposal result that Kuku can show in the existing approval UI before applying.
ACP MCP mutation tools now reuse the existing native tool implementations, emit the existing pending-approval event, wait for `ai_resolve_approval`, and only call `AiHostBindings::apply_mutation` after user approval.

- [ ] **Step 4: Run manual security test**

Ask an external agent to edit a protected path outside the vault.

Expected: the operation is rejected or converted into a non-applied proposal with a visible error.

Automated coverage now verifies that bridged ACP mutation tools are whitelisted, emit pending approval, reject without applying, apply only after approval, and cannot resolve pending approvals after the ACP session is removed. The live external-agent UI security test still requires interactive Kuku window access.

## Testing Matrix

Run these before marking each phase complete:

```bash
cargo test -p kuku-ai
pnpm --filter desktop test -- ai_chat
pnpm --filter desktop test -- core_tool_registry
```

Manual checks:

- Kuku Agent can answer in ask mode.
- Kuku Agent can use file/search tools.
- Kuku Agent mutation approval still opens diff UI.
- External Codex session streams text.
- External Codex cancellation stops the turn.
- Switching from external agent back to Kuku Agent starts or resumes the correct Kuku thread.
- Misconfigured external command shows a clear error and does not break Kuku Agent.

Automated verification currently completed:

- `cargo test -p kuku-ai`: 70 passed.
- `cargo check -p kuku-app`: passed.
- `pnpm --filter @kuku/desktop exec vitest run src/plugins/builtin/core_tool_registry src/plugins/builtin/ai_chat src/i18n/__tests__/catalog.test.ts`: 80 passed.
- `pnpm --filter @kuku/desktop build`: passed.
- `git diff --check`: passed.

## Security and Product Constraints

- External agent authentication belongs to the external agent provider or CLI. Kuku should pass configured env values but should not reuse Kuku-hosted model credentials automatically.
- ACP logs must redact env values and auth tokens.
- External agents must not inherit broader filesystem permissions than Kuku intends. The initial MVP can pass `cwd`; the MCP bridge phase should enforce Kuku vault restrictions.
- Capability differences must be visible in the UI. Unsupported load/resume/edit/checkpoint features should be disabled rather than failing after click.

## Reference Material

- Zed external agents use ACP for CLI-based agents including Gemini CLI, Claude Agent, Codex CLI, GitHub Copilot, and custom configured agents: https://zed.dev/docs/ai/external-agents
- ACP session setup defines `session/new`, `session/load`, `session/resume`, and `session/close`: https://agentclientprotocol.com/protocol/session-setup
- ACP prompt turns define `session/prompt`, `session/update`, and `session/cancel`: https://agentclientprotocol.com/protocol/prompt-turn
- ACP Rust SDK: https://docs.rs/agent-client-protocol/latest/agent_client_protocol/
