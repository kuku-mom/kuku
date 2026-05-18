import { describe, expect, it } from "vitest";

import { createProxyToolRegistry } from "./registry";
import type { ProxyToolSpec } from "./types";

describe("proxy tool registry", () => {
  it("preserves tool permission metadata in descriptors", () => {
    const registry = createProxyToolRegistry();

    registry.register({
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
      handler: async () => "{}",
    } as ProxyToolSpec);

    expect(registry.list()[0]).toMatchObject({
      name: "wiki_propose_page",
      access: "proposesMutation",
      kind: "proposal",
      riskLevel: "medium",
      requiresApproval: true,
      modeAvailability: ["agent"],
      permissionRuleKey: "knowledge.wiki_propose_page",
    });
  });
});
