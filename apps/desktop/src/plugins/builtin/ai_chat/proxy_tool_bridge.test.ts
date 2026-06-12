import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AiProxyToolRegistry,
  ProxyToolCallPayload,
  ProxyToolDescriptor,
  ProxyToolSpec,
} from "~/plugins/builtin/core_tool_registry/types";

import { createProxyToolBridge } from "./proxy_tool_bridge";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, callback);
    return mocks.unlisten;
  }),
}));

describe("ai_chat proxy tool bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invoke.mockReset();
    mocks.listeners.clear();
    mocks.unlisten.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets the running tool row paint before executing the proxy handler", async () => {
    const handler = vi.fn(async () => "created");
    await createProxyToolBridge(createRegistry(handler));

    const listener = mocks.listeners.get("ai:proxy-tool-call");
    expect(listener).toBeDefined();

    listener?.({
      payload: {
        sessionId: "session-1",
        callId: "call-1",
        toolName: "create_widget",
        arguments: { widgetName: "Clock" },
      } satisfies ProxyToolCallPayload,
    });

    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(32);

    expect(handler).toHaveBeenCalledWith({ widgetName: "Clock" });
    expect(mocks.invoke).toHaveBeenCalledWith("plugin:kuku-ai|ai_submit_proxy_tool_result", {
      callId: "call-1",
      output: "created",
      isError: false,
    });
  });
});

function createRegistry(handler: ProxyToolSpec["handler"]): AiProxyToolRegistry {
  return {
    register() {
      return () => {};
    },
    list(): ProxyToolDescriptor[] {
      return [];
    },
    getHandler(name) {
      return name === "create_widget" ? handler : undefined;
    },
    subscribe() {
      return () => {};
    },
  };
}
