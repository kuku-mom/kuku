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
});

function createRegistry(tools: ProxyToolDescriptor[]): AiProxyToolRegistry {
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
    subscribe() {
      return () => {};
    },
  };
}
