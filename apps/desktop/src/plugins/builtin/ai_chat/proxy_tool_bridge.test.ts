import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProxyToolRegistry } from "../core_tool_registry/registry";
import type {
  ProxyToolCallPayload,
  ProxyToolDescriptor,
  ProxyToolSpec,
} from "../core_tool_registry/types";
import { createProxyToolBridge } from "./proxy_tool_bridge";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function tool(overrides: Partial<ProxyToolSpec> = {}): ProxyToolSpec {
  return {
    name: "planner_query",
    toolId: "planner.query",
    description: "Query Planner tasks",
    parameters: { type: "object", properties: {} },
    category: "Planner",
    handler: vi.fn(async () => "result"),
    ...overrides,
  };
}

describe("proxy tool bridge", () => {
  const nativeTools = new Map<string, ProxyToolDescriptor>();
  const listeners = new Set<(event: { payload: ProxyToolCallPayload }) => void>();
  const disposers: (() => void)[] = [];
  const pending: ReturnType<typeof deferred>[] = [];
  const results: { callId: string; output: string; isError: boolean }[] = [];
  let beforeRegister: (descriptor: ProxyToolDescriptor) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    nativeTools.clear();
    listeners.clear();
    results.length = 0;
    beforeRegister = async () => {};
    tauri.listen.mockImplementation(
      async (_name: string, listener: (event: { payload: ProxyToolCallPayload }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    );
    tauri.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command.endsWith("ai_register_proxy_tool")) {
        const descriptor = args.descriptor as ProxyToolDescriptor;
        await beforeRegister(descriptor);
        nativeTools.set(descriptor.name, descriptor);
      } else if (command.endsWith("ai_unregister_proxy_tool")) {
        nativeTools.delete(args.name as string);
      } else if (command.endsWith("ai_submit_proxy_tool_result")) {
        results.push(args as (typeof results)[number]);
      } else throw new Error(`Unexpected command: ${command}`);
    });
  });

  afterEach(async () => {
    pending.splice(0).forEach((gate) => gate.resolve());
    disposers.splice(0).forEach((dispose) => dispose());
    // A final empty sync waits behind all registrations and cleanup queued by
    // this test, including the old bridge in the replacement-race case.
    const finished = vi.fn();
    const dispose = await createProxyToolBridge(createProxyToolRegistry(), {
      onToolsChanged: finished,
    });
    await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
    dispose();
    expect(nativeTools.size).toBe(0);
    vi.restoreAllMocks();
  });

  async function bridge(registry: ReturnType<typeof createProxyToolRegistry>) {
    const dispose = await createProxyToolBridge(registry);
    disposers.push(dispose);
    return dispose;
  }

  async function emit(overrides: Partial<ProxyToolCallPayload> = {}) {
    const callId = `call-${results.length}`;
    const payload = {
      sessionId: "session",
      callId,
      toolName: "planner_query",
      toolId: "planner.query",
      arguments: { day: "2026-09-04" },
      ...overrides,
    };
    for (const listener of listeners) listener({ payload });
    await vi.waitFor(() => expect(results.some((result) => result.callId === callId)).toBe(true));
    const result = results.find((result) => result.callId === callId);
    if (!result) throw new Error(`No result returned for ${callId}`);
    return result;
  }

  it("forwards access metadata and executes calls with the same authorized access", async () => {
    const registry = createProxyToolRegistry();
    const query = tool();
    const mutation = tool({
      name: "planner_update_task",
      toolId: "planner.update_task",
      access: "proposesMutation",
    });
    registry.register(query);
    registry.register(mutation);
    await bridge(registry);
    await vi.waitFor(() => expect(nativeTools.size).toBe(2));
    expect(nativeTools.get(query.name)?.access).toBe("readOnly");
    expect(nativeTools.get(mutation.name)?.access).toBe("proposesMutation");
    await expect(emit()).resolves.toMatchObject({ isError: false });
    await expect(
      emit({
        toolName: mutation.name,
        toolId: mutation.toolId,
        access: "proposesMutation",
      }),
    ).resolves.toMatchObject({ isError: false });
    expect(query.handler).toHaveBeenCalledWith({ day: "2026-09-04" });
    expect(mutation.handler).toHaveBeenCalledOnce();
  });

  it("rejects delayed read-only calls after a tool is replaced by a mutation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = createProxyToolRegistry();
    registry.register(tool());
    await bridge(registry);
    await vi.waitFor(() => expect(nativeTools.size).toBe(1));
    const mutation = tool({ access: "proposesMutation" });
    registry.register(mutation);
    await vi.waitFor(() => expect(nativeTools.get(mutation.name)?.access).toBe("proposesMutation"));
    await expect(emit({ access: "readOnly" })).resolves.toMatchObject({ isError: true });
    // Missing access is treated as legacy read-only, never as permission to write.
    await expect(emit()).resolves.toMatchObject({ isError: true });
    expect(mutation.handler).not.toHaveBeenCalled();
  });

  it("gates disabled tools immediately even before native removal completes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = createProxyToolRegistry();
    registry.register(tool());
    await bridge(registry);
    await vi.waitFor(() => expect(nativeTools.size).toBe(1));
    const disabled = tool({ aiEnabled: false });
    registry.register(disabled);
    expect(registry.getHandler(disabled.name)).toBeUndefined();
    await expect(emit()).resolves.toMatchObject({ isError: true });
    expect(disabled.handler).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(nativeTools.size).toBe(0));
  });

  it("rejects stale identities without invoking a different registered tool", async () => {
    const registry = createProxyToolRegistry();
    const query = tool();
    registry.register(query);
    await bridge(registry);
    await vi.waitFor(() => expect(nativeTools.size).toBe(1));
    await expect(emit({ toolId: "another_plugin.query" })).resolves.toMatchObject({
      isError: true,
    });
    expect(query.handler).not.toHaveBeenCalled();
  });

  it("does not execute a replacement whose new access failed to register", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = createProxyToolRegistry();
    registry.register(tool());
    await bridge(registry);
    await vi.waitFor(() => expect(nativeTools.size).toBe(1));
    beforeRegister = async () => {
      throw new Error("native registration failed");
    };
    const mutation = tool({ access: "proposesMutation" });
    registry.register(mutation);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    await expect(emit({ access: "proposesMutation" })).resolves.toMatchObject({ isError: true });
    expect(mutation.handler).not.toHaveBeenCalled();
  });

  it("cleans up a registration that finishes after bridge disposal", async () => {
    const gate = deferred();
    pending.push(gate);
    const started = vi.fn();
    beforeRegister = async () => {
      started();
      await gate.promise;
    };
    const registry = createProxyToolRegistry();
    registry.register(tool());
    const changed = vi.fn();
    const dispose = await createProxyToolBridge(registry, { onToolsChanged: changed });
    disposers.push(dispose);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    dispose();
    gate.resolve();
    await vi.waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith("plugin:kuku-ai|ai_unregister_proxy_tool", {
        name: "planner_query",
      }),
    );
    expect(nativeTools.size).toBe(0);
    expect(changed).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it("finishes old cleanup before a replacement bridge registers the same tool", async () => {
    const gate = deferred();
    pending.push(gate);
    const started = vi.fn();
    beforeRegister = async () => {
      started();
      if (started.mock.calls.length === 1) await gate.promise;
    };
    const oldRegistry = createProxyToolRegistry();
    oldRegistry.register(tool());
    const disposeOld = await bridge(oldRegistry);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    disposeOld();
    const replacement = createProxyToolRegistry();
    replacement.register(tool({ access: "proposesMutation" }));
    await bridge(replacement);
    gate.resolve();
    await vi.waitFor(() =>
      expect(nativeTools.get("planner_query")?.access).toBe("proposesMutation"),
    );
    expect(
      tauri.invoke.mock.calls
        .filter(([command]) => !String(command).endsWith("ai_submit_proxy_tool_result"))
        .map(([command]) => String(command).split("|")[1]),
    ).toEqual(["ai_register_proxy_tool", "ai_unregister_proxy_tool", "ai_register_proxy_tool"]);
    expect(listeners.size).toBe(1);
  });

  it("removes tools unregistered during an in-flight sync", async () => {
    const gate = deferred();
    pending.push(gate);
    const started = vi.fn();
    beforeRegister = async () => {
      started();
      await gate.promise;
    };
    const registry = createProxyToolRegistry();
    const query = tool();
    const unregister = registry.register(query);
    await bridge(registry);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    unregister();
    await expect(emit()).resolves.toMatchObject({ isError: true });
    gate.resolve();
    await vi.waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith("plugin:kuku-ai|ai_unregister_proxy_tool", {
        name: query.name,
      }),
    );
    expect(nativeTools.size).toBe(0);
    expect(query.handler).not.toHaveBeenCalled();
  });
});
