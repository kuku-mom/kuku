// Development fixture only: exercises the production registry and handlers.
import { For, createSignal, onCleanup } from "solid-js";

import type { AiProxyToolRegistry } from "~/plugins/builtin/core_tool_registry/types";

export function PlannerAiConsole(props: { registry: AiProxyToolRegistry }) {
  const [tools, setTools] = createSignal(props.registry.list());
  const [tool, setTool] = createSignal("planner_tasks_search");
  const [args, setArgs] = createSignal("{}");
  const [result, setResult] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal("ready");
  onCleanup(props.registry.subscribe(() => setTools(props.registry.list())));
  async function run() {
    if (busy()) return;
    setBusy(true);
    setStatus("running");
    try {
      const input: unknown = JSON.parse(args());
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Arguments must be an object");
      const handler = props.registry.getHandler(tool());
      if (!handler) throw new Error("Tool unavailable");
      const output = await handler(input as Record<string, unknown>);
      setResult(output);
      setStatus("success");
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Planner AI tool fixture"
      style={{
        padding: "12px",
        "max-height": "45vh",
        overflow: "auto",
        border: "1px solid var(--color-border-default)",
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <label>
          AI tool
          <select
            aria-label="AI tool"
            value={tool()}
            onChange={(event) => setTool(event.currentTarget.value)}
          >
            <For each={tools().filter((item) => item.name.startsWith("planner_"))}>
              {(item) => (
                <option value={item.name}>
                  {item.name} · {item.access ?? "readOnly"}
                </option>
              )}
            </For>
          </select>
        </label>
        <label style={{ display: "block" }}>
          Tool arguments
          <textarea
            aria-label="Tool arguments"
            rows={3}
            value={args()}
            onInput={(event) => setArgs(event.currentTarget.value)}
            style={{ display: "block", width: "100%", "font-family": "monospace" }}
          />
        </label>
        <button type="submit" disabled={busy()}>
          Run AI tool
        </button>
        <output aria-label="Tool status">{status()}</output>
      </form>
      <pre aria-label="Tool result" style={{ "white-space": "pre-wrap", "font-size": "11px" }}>
        {result()}
      </pre>
    </section>
  );
}
