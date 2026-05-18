import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AiProxyToolRegistry,
  ProxyToolDescriptor,
  ProxyToolSpec,
} from "~/plugins/builtin/core_tool_registry/types";

import { createProxyToolBridge } from "./proxy_tool_bridge";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

describe("proxy tool bridge", () => {
  afterEach(() => {
    invokeMock.mockReset();
  });

  it("passes permission metadata when registering proxy tools with Rust", async () => {
    const registry = createRegistry([
      {
        name: "wiki_propose_page",
        toolId: "knowledge.wiki_propose_page",
        description: "Create a Knowledge decision document for review.",
        category: "knowledge",
        parameters: { type: "object", properties: {} },
        access: "proposesMutation",
        kind: "proposal",
        riskLevel: "medium",
        requiresApproval: true,
        modeAvailability: ["agent"],
        permissionRuleKey: "knowledge.wiki_propose_page",
        aiEnabled: true,
      } as ProxyToolDescriptor,
    ]);

    const dispose = await createProxyToolBridge(registry);
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith("plugin:kuku-ai|ai_register_proxy_tool", {
      descriptor: expect.objectContaining({
        toolId: "knowledge.wiki_propose_page",
        name: "wiki_propose_page",
        access: "proposesMutation",
        kind: "proposal",
        riskLevel: "medium",
        requiresApproval: true,
        modeAvailability: ["agent"],
        permissionRuleKey: "knowledge.wiki_propose_page",
      }),
    });

    dispose();
  });

  it("retries failed proxy registrations on the next registry sync", async () => {
    let listener: (() => void) | undefined;
    const registry = createRegistry(
      [
        {
          name: "memory_context",
          toolId: "knowledge.memory_context",
          description: "Read committed Knowledge memory.",
          category: "knowledge",
          parameters: { type: "object", properties: {} },
          access: "readOnly",
          kind: "read",
          riskLevel: "low",
          requiresApproval: false,
          modeAvailability: ["ask", "inline", "agent"],
          permissionRuleKey: "knowledge.memory_context",
          aiEnabled: true,
        } as ProxyToolDescriptor,
      ],
      (nextListener) => {
        listener = nextListener;
      },
    );
    invokeMock.mockResolvedValue(undefined);
    invokeMock.mockRejectedValueOnce(
      new Error("modeAvailability must contain at least one chat mode"),
    );

    const dispose = await createProxyToolBridge(registry);
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledTimes(1);

    listener?.();
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledTimes(2);

    dispose();
  });
});

function createRegistry(
  tools: ProxyToolDescriptor[],
  onSubscribe?: (listener: () => void) => void,
): AiProxyToolRegistry {
  return {
    register() {
      return () => {};
    },
    list() {
      return tools;
    },
    getHandler(_name: string): ProxyToolSpec["handler"] | undefined {
      return undefined;
    },
    subscribe(listener) {
      onSubscribe?.(listener);
      return () => {};
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
