import { createSignal, For, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, openPath } from "@tauri-apps/plugin-opener";
import {
  SettingsBanner,
  SettingsCard,
  SettingsPanel,
  SettingsStatusBadge,
} from "~/components/settings/settings_blocks";
import { openTab } from "~/stores/files";
import { createPluginSettings, type PluginSettingsHandle } from "~/plugins/settings_store";
import { knowledgeSettings, type KnowledgeSettings } from "../settings";
import {
  memoryAdmin,
  rememberInput,
  type MemoryStatus,
  type SharedMemory,
  type MemoryPolicy,
} from "../memory_client";
import "../memory_settings.css";

function connectionLabel(connection: MemoryStatus["connections"][number] | undefined) {
  if (connection?.last_read && connection?.last_write) return "Read and save verified";
  if (connection?.last_read) return "Read verified · save not verified";
  if (connection?.last_write) return "Save verified · read not verified";
  if (connection) return "Installed · awaiting first call";
  return "Disconnected";
}

export default function MemorySettings() {
  const [panelSettings, setPanelSettings] = createSignal<PluginSettingsHandle<KnowledgeSettings>>();
  const [status, setStatus] = createSignal<MemoryStatus>();
  const [desktopBundle, setDesktopBundle] = createSignal<{
    id: string;
    socket: string;
    bundle: string;
    mcpb: string;
  }>();
  const [busy, setBusy] = createSignal(false);
  const [errorMessage, setError] = createSignal("");
  const [message, setMessage] = createSignal("");
  const [scope, setScope] = createSignal("personal");
  const [newScope, setNewScope] = createSignal("personal");
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [editing, setEditing] = createSignal<SharedMemory>();
  const [paths, setPaths] = createSignal("");
  const [candidates, setCandidates] = createSignal<Partial<SharedMemory>[]>([]);
  const [selected, setSelected] = createSignal<Set<number>>(new Set());
  const refresh = async () => {
    const next = await memoryAdmin<MemoryStatus>("status");
    setStatus(next);
    if (!Object.hasOwn(next.policy.scopes, scope())) {
      setScope(Object.keys(next.policy.scopes)[0] ?? "personal");
    }
  };
  async function run(action: () => Promise<unknown>) {
    if (busy()) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      await refresh();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  onMount(() => {
    void run(async () => {
      setPanelSettings(
        await createPluginSettings<KnowledgeSettings>({
          pluginId: "knowledge",
          defaults: { panelEnabled: true },
          schema: knowledgeSettings.schema,
          version: knowledgeSettings.version,
        }),
      );
      await refresh();
    });
  });
  const policy = (): MemoryPolicy =>
    status()?.policy ?? { enabled: false, writes_enabled: false, cloud_enabled: false, scopes: {} };
  const savePolicy = async (next: MemoryPolicy) => {
    await memoryAdmin("policy", next);
  };
  function updateScope(key: "auto_save" | "shared", value: boolean) {
    void run(() =>
      savePolicy({
        ...policy(),
        scopes: { ...policy().scopes, [scope()]: { ...policy().scopes[scope()], [key]: value } },
      }),
    );
  }
  async function saveMemory(input: ReturnType<typeof rememberInput>) {
    const result = await memoryAdmin<{ status: string }>("remember", input);
    if (result.status === "conflict")
      throw new Error(
        "This memory changed elsewhere. Refresh and review its current version before saving.",
      );
    if (result.status === "proposed")
      setMessage("This memory needs review. Open its proposal in Recent changes.");
    return result;
  }
  async function sync() {
    await invoke("auth_set_plugin_authorized", { pluginId: "knowledge", authorized: true });
    const result = await memoryAdmin<{ committed: number; conflicts: number; downloaded: number }>(
      "sync",
    );
    setMessage(
      `Shared ${result.committed}, received ${result.downloaded}, conflicts ${result.conflicts}.`,
    );
  }
  function updateProject(
    key: "goal" | "state" | "decisions" | "open_questions" | "next_actions",
    value: string,
  ) {
    const current = editing();
    if (!current?.record) return;
    setEditing({
      ...current,
      record: {
        ...current.record,
        [key]: key === "goal" || key === "state" ? value : value.split("\n").filter(Boolean),
      },
    });
  }
  const inputId = "memory-scope";
  return (
    <SettingsPanel
      title="Memory for your AI"
      description="Connect your AI tools to the same preferences, decisions, and project context."
    >
      <Show when={errorMessage()}>
        <SettingsBanner tone="error" description={errorMessage()} />
      </Show>
      <Show when={message()}>
        <SettingsBanner tone="info" description={message()} />
      </Show>
      <div class="memory-settings" aria-busy={busy()}>
        <SettingsCard title="Access and automatic saving">
          <label>
            <input
              type="checkbox"
              checked={panelSettings()?.settings.panelEnabled !== false}
              disabled={busy() || !panelSettings()}
              onChange={(event) => {
                const enabled = event.currentTarget.checked;
                void run(async () => {
                  await panelSettings()?.set("panelEnabled", enabled);
                });
              }}
            />{" "}
            Show Second Brain panel
          </label>
          <label>
            <input
              type="checkbox"
              checked={policy().enabled}
              disabled={busy()}
              onChange={(e) => {
                const enabled = e.currentTarget.checked;
                void run(() => savePolicy({ ...policy(), enabled }));
              }}
            />{" "}
            Enable local AI memory connections
          </label>
          <label>
            <input
              type="checkbox"
              checked={policy().writes_enabled}
              disabled={busy()}
              onChange={(e) => {
                const writes_enabled = e.currentTarget.checked;
                void run(() => savePolicy({ ...policy(), writes_enabled }));
              }}
            />{" "}
            Allow local memory writes
          </label>
          <label for={inputId}>Memory scope</label>
          <select id={inputId} value={scope()} onChange={(e) => setScope(e.currentTarget.value)}>
            <For each={Object.keys(policy().scopes)}>
              {(name) => <option value={name}>{name}</option>}
            </For>
          </select>
          <div class="memory-actions">
            <input
              aria-label="New memory scope"
              placeholder="personal or project-kuku"
              value={newScope()}
              onInput={(e) => setNewScope(e.currentTarget.value)}
            />
            <button
              disabled={busy() || !newScope().trim()}
              onClick={() => {
                const name = newScope().trim();
                void run(async () => {
                  await savePolicy({
                    ...policy(),
                    scopes: { ...policy().scopes, [name]: { auto_save: false, shared: false } },
                  });
                  setScope(name);
                  setNewScope("");
                });
              }}
            >
              Add scope
            </button>
          </div>
          <Show when={policy().scopes[scope()]}>
            <label>
              <input
                type="checkbox"
                checked={policy().scopes[scope()]?.auto_save}
                disabled={busy()}
                onChange={(e) => updateScope("auto_save", e.currentTarget.checked)}
              />{" "}
              Automatically save confirmed memories in this scope
            </label>
            <label>
              <input
                type="checkbox"
                checked={policy().scopes[scope()]?.shared}
                disabled={busy()}
                onChange={(e) => updateScope("shared", e.currentTarget.checked)}
              />{" "}
              Share new memories in this scope with web AI
            </label>
          </Show>
          <label>
            <input
              type="checkbox"
              checked={policy().cloud_enabled}
              disabled={busy()}
              onChange={(e) => {
                const cloud_enabled = e.currentTarget.checked;
                void run(() => savePolicy({ ...policy(), cloud_enabled }));
              }}
            />{" "}
            Sync selected shared memories in the background
          </label>
          <p>
            Shared memory text and approved source excerpts are stored on the Kuku server for
            search, including while your Mac is off. Your encrypted vault and other notes are not
            uploaded here.
          </p>
          <div class="memory-actions">
            <button
              disabled={busy()}
              onClick={() => {
                void run(sync);
              }}
            >
              Allow account access and sync
            </button>
            <button
              disabled={busy()}
              onClick={() => {
                void run(refresh);
              }}
            >
              Refresh
            </button>
            <button
              disabled={busy()}
              onClick={() => {
                void run(() => memoryAdmin("rebuild_index"));
              }}
            >
              Rebuild search index
            </button>
          </div>
        </SettingsCard>
        <SettingsCard title="Connect your AI">
          <For
            each={[
              { id: "codex", label: "Codex" },
              { id: "claude-code", label: "Claude Code" },
              { id: "cursor", label: "Cursor" },
              { id: "grok-build", label: "Grok Build" },
              { id: "claude-desktop", label: "Claude Desktop" },
            ]}
          >
            {(client) => {
              const connection = () => status()?.connections.find((c) => c.client === client.id);
              return (
                <div class="memory-connection">
                  <strong>{client.label}</strong>
                  <SettingsStatusBadge tone={connection()?.last_success ? "success" : "neutral"}>
                    {connectionLabel(connection())}
                  </SettingsStatusBadge>
                  <button
                    disabled={busy() || !policy().scopes[scope()]}
                    onClick={() => {
                      void run(async () => {
                        const existing = connection();
                        if (existing) {
                          await memoryAdmin("disconnect", { id: existing.id });
                        } else {
                          const result = await memoryAdmin<{
                            message: string;
                            id: string;
                            socket: string;
                            bundle: string;
                            mcpb: string;
                          }>("connect", { client: client.id, scopes: [scope()] });
                          setMessage(result.message);
                          if (client.id === "claude-desktop") setDesktopBundle(result);
                        }
                      });
                    }}
                  >
                    {connection() ? "Disconnect" : `Connect to ${scope()}`}
                  </button>
                </div>
              );
            }}
          </For>
          <p>
            After restarting the client, ask it to search Kuku memory. Coding clients receive a
            memory skill; Claude Code also recalls memories at session start. Client tool approvals
            still apply.
          </p>
          <Show when={desktopBundle()}>
            {(bundle) => (
              <details>
                <summary>Claude Desktop extension setup</summary>
                <p>
                  For extension installation, copy these pairing settings. The direct configuration
                  above is already installed.
                </p>
                <p>Socket: {bundle().socket}</p>
                <p>Connection: {bundle().id}</p>
                <p>Application: {bundle().bundle}</p>
                <button
                  onClick={() => {
                    void openPath(bundle().mcpb).catch((error: unknown) => setError(String(error)));
                  }}
                >
                  Open MCPB extension
                </button>
              </details>
            )}
          </Show>
          <For each={["ChatGPT", "Claude web", "Grok Bot"]}>
            {(name) => (
              <div class="memory-connection">
                <strong>{name}</strong>
                <button
                  disabled={busy()}
                  onClick={() => {
                    void navigator.clipboard.writeText(status()?.remote_url ?? "").then(
                      () =>
                        setMessage(
                          "MCP URL copied. Add it as a custom connector, then choose scopes on the Kuku consent screen.",
                        ),
                      (error: unknown) => setError(String(error)),
                    );
                  }}
                >
                  Copy MCP URL
                </button>
                <button
                  onClick={() => {
                    void openUrl(status()?.web_url ?? "https://www.kuku.mom/memory/connect").catch(
                      (error: unknown) => setError(String(error)),
                    );
                  }}
                >
                  Connection guide & access
                </button>
              </div>
            )}
          </For>
          <Show when={status()?.outbox.length}>
            <p role="status">
              {status()?.outbox.length} changes queued. Conflicts:{" "}
              {status()?.outbox.filter((v) => v.state === "conflict").length}. Queued changes are
              not yet available to web AI.
            </p>
            <For each={status()?.outbox.filter((v) => v.state === "conflict")}>
              {(entry) => (
                <div class="memory-actions">
                  <span>
                    {entry.id}: keep the server version, then edit it to merge your changes. Your
                    local edits remain in change history.
                  </span>
                  <button
                    disabled={busy()}
                    onClick={() => {
                      void run(() => memoryAdmin("resolve_conflict", { id: entry.id }));
                    }}
                  >
                    Use cloud version
                  </button>
                </div>
              )}
            </For>
          </Show>
        </SettingsCard>
        <SettingsCard title="Continue a project">
          <p>
            Current checkpoints for {scope()}. Independent records may disagree; inspect their
            evidence before continuing.
          </p>
          <For each={status()?.memories.filter((m) => m.scope === scope() && m.record)}>
            {(memory) => (
              <details>
                <summary>
                  {memory.title} · v{memory.version}
                </summary>
                <p>{memory.record?.goal}</p>
                <p>{memory.record?.state}</p>
                <p>Open questions: {memory.record?.open_questions?.join(" · ")}</p>
                <p>Suggested next actions: {memory.record?.next_actions?.join(" · ")}</p>
                <For each={memory.record?.experiences}>
                  {(experience) => (
                    <p>
                      {experience.outcome} — {experience.conditions}: {experience.method} →{" "}
                      {experience.result}
                    </p>
                  )}
                </For>
                <small>
                  Observed {memory.record?.occurred_at}. Evidence and editing are available in the
                  memory list below.
                </small>
              </details>
            )}
          </For>
        </SettingsCard>
        <SettingsCard title="Note processing">
          <For each={status()?.extraction_jobs}>
            {(job) => (
              <div class="memory-connection">
                <span>
                  {job.state} · {job.paths.join(", ")}
                </span>
                <button
                  disabled={busy()}
                  onClick={() => {
                    setPaths(job.paths.join("\n"));
                    setMessage(
                      "Selected source notes restored below. Extract again to retry or reopen the saved preview.",
                    );
                  }}
                >
                  Select source notes
                </button>
              </div>
            )}
          </For>
        </SettingsCard>
        <SettingsCard title={editing() ? "Edit memory" : "Create your first memory"}>
          <label>
            Title
            <input
              value={title()}
              maxLength={160}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
          </label>
          <Show when={!editing()?.record}>
            <label>
              Memory
              <textarea
                value={body()}
                maxLength={20000}
                rows={4}
                onInput={(e) => setBody(e.currentTarget.value)}
              />
            </label>
          </Show>
          <Show when={editing()?.record}>
            {(record) => (
              <>
                <label>
                  Goal
                  <textarea
                    value={record().goal}
                    onInput={(e) => updateProject("goal", e.currentTarget.value)}
                  />
                </label>
                <label>
                  Current state
                  <textarea
                    value={record().state}
                    onInput={(e) => updateProject("state", e.currentTarget.value)}
                  />
                </label>
                <label>
                  Confirmed decisions (one per line)
                  <textarea
                    value={record().decisions?.join("\n")}
                    onInput={(e) => updateProject("decisions", e.currentTarget.value)}
                  />
                </label>
                <label>
                  Open questions (one per line)
                  <textarea
                    value={record().open_questions?.join("\n")}
                    onInput={(e) => updateProject("open_questions", e.currentTarget.value)}
                  />
                </label>
                <label>
                  Suggested next actions (one per line)
                  <textarea
                    value={record().next_actions?.join("\n")}
                    onInput={(e) => updateProject("next_actions", e.currentTarget.value)}
                  />
                </label>
              </>
            )}
          </Show>
          <div class="memory-actions">
            <button
              disabled={busy() || !title().trim() || !body().trim() || !policy().writes_enabled}
              onClick={() => {
                void run(async () => {
                  const current = editing();
                  if (current?.record) {
                    const result = await invoke<{ status: string }>("memory_tool", {
                      method: "memory_checkpoint",
                      params: {
                        request_id: crypto.randomUUID(),
                        scope: current.scope,
                        title: title(),
                        id: current.id,
                        expected_version: current.version,
                        record: { ...current.record, occurred_at: new Date().toISOString() },
                        source_refs: current.source_refs,
                        expires_at: current.expires_at ?? null,
                      },
                    });
                    if (result.status === "conflict")
                      throw new Error("Checkpoint changed elsewhere. Refresh before editing.");
                    if (result.status === "proposed")
                      setMessage("Checkpoint saved for review in Recent changes.");
                  } else
                    await saveMemory(
                      rememberInput({
                        ...editing(),
                        title: title(),
                        body: body(),
                        scope: editing()?.scope ?? scope(),
                      }),
                    );
                  setEditing(undefined);
                  setTitle("");
                  setBody("");
                });
              }}
            >
              Save to {editing()?.scope ?? scope()}
            </button>
            <Show when={editing()}>
              <button
                onClick={() => {
                  setEditing(undefined);
                  setTitle("");
                  setBody("");
                }}
              >
                Cancel edit
              </button>
            </Show>
          </div>
          <label>
            Import from notes · one vault-relative Markdown path per line
            <textarea value={paths()} rows={3} onInput={(e) => setPaths(e.currentTarget.value)} />
          </label>
          <button
            disabled={busy() || !paths().trim()}
            onClick={() => {
              void run(async () => {
                const values = await memoryAdmin<Partial<SharedMemory>[]>("extract", {
                  paths: paths()
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                });
                setCandidates(values);
                setSelected(new Set(values.map((_, i) => i)));
              });
            }}
          >
            Extract with configured AI
          </button>
          <For each={candidates()}>
            {(candidate, i) => (
              <label class="memory-candidate">
                <input
                  type="checkbox"
                  checked={selected().has(i())}
                  onChange={(e) => {
                    const next = new Set(selected());
                    if (e.currentTarget.checked) next.add(i());
                    else next.delete(i());
                    setSelected(next);
                  }}
                />
                <span>
                  <strong>{candidate.title}</strong>
                  <p>{candidate.body}</p>
                </span>
              </label>
            )}
          </For>
          <Show when={candidates().length}>
            <button
              disabled={busy() || !selected().size || !policy().writes_enabled}
              onClick={() => {
                void run(async () => {
                  const remaining = [...candidates()];
                  for (const index of [...selected()].sort((a, b) => b - a)) {
                    const candidate = remaining[index];
                    if (!candidate?.title || !candidate.body)
                      throw new Error("Candidate is missing its title or body");
                    await saveMemory(
                      rememberInput({
                        ...candidate,
                        title: candidate.title,
                        body: candidate.body,
                        scope: scope(),
                      }),
                    );
                    remaining.splice(index, 1);
                    setCandidates([...remaining]);
                    setSelected(new Set([...selected()].filter((i) => i < index)));
                  }
                  setSelected(new Set<number>());
                });
              }}
            >
              Save {selected().size} selected memories
            </button>
          </Show>
        </SettingsCard>
        <SettingsCard title="Current memories">
          <For each={status()?.memories}>
            {(memory) => (
              <details>
                <summary>
                  {memory.title} · {memory.scope} · v{memory.version}
                  {memory.shared ? " · shared" : ""}
                </summary>
                <p class="memory-body">{memory.body}</p>
                <For each={memory.source_refs}>
                  {(source) => (
                    <p>
                      {source.title ?? source.origin ?? source.path}
                      {source.quote ? ` — ${source.quote}` : ""}
                    </p>
                  )}
                </For>
                <div class="memory-actions">
                  <button
                    disabled={busy()}
                    onClick={() => {
                      setEditing(memory);
                      setTitle(memory.title);
                      setBody(memory.body);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    disabled={busy()}
                    onClick={() => {
                      void run(() =>
                        memoryAdmin("manage", {
                          id: memory.id,
                          expected_version: memory.version,
                          action: memory.shared ? "unshare" : "share",
                        }),
                      );
                    }}
                  >
                    {memory.shared ? "Stop sharing" : "Share"}
                  </button>
                  <button
                    disabled={busy()}
                    onClick={() => {
                      void run(() =>
                        memoryAdmin("manage", {
                          id: memory.id,
                          expected_version: memory.version,
                          action: "delete",
                        }),
                      );
                    }}
                  >
                    Delete
                  </button>
                </div>
              </details>
            )}
          </For>
        </SettingsCard>
        <SettingsCard title="Recent changes">
          <For each={status()?.history.slice(0, 30)}>
            {(change) => (
              <div class="memory-connection">
                <span>
                  {change.after.title} · {change.after.status}
                  <small>
                    {change.client} · {new Date(change.created_at).toLocaleString()}
                  </small>
                </span>
                <Show when={change.after.status === "pending"}>
                  <button
                    disabled={busy()}
                    onClick={() =>
                      openTab(change.after.title, change.after.decision_document, "editor")
                    }
                  >
                    Review
                  </button>
                </Show>
                <button
                  disabled={busy() || change.after.status === "pending"}
                  onClick={() => {
                    void run(() => memoryAdmin("undo", { seq: change.seq }));
                  }}
                >
                  Undo
                </button>
              </div>
            )}
          </For>
        </SettingsCard>
      </div>
    </SettingsPanel>
  );
}
