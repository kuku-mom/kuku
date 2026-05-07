import { describe, expect, it } from "vitest";

import type {
  AiProxyToolRegistry,
  ProxyToolDescriptor,
  ProxyToolSpec,
} from "~/plugins/builtin/core_tool_registry/types";

import {
  FORBIDDEN_KNOWLEDGE_AI_TOOL_NAMES,
  KNOWLEDGE_AI_TOOL_NAMES,
  memoryContextRequestFromArgs,
  memoryProposeRequestFromArgs,
  memorySearchRequestFromArgs,
  registerKnowledgeAiTools,
} from "./ai_tools";
import type { KnowledgeService } from "./service";

describe("knowledge AI tools", () => {
  it("registers only the allowed Knowledge proposal tool and never exposes apply/write/delete", () => {
    const registry = createRegistry();
    const service = createService();

    registerKnowledgeAiTools(registry, service);

    const names = registry.list().map((tool) => tool.name);
    expect(names).toEqual([...KNOWLEDGE_AI_TOOL_NAMES]);
    for (const forbidden of FORBIDDEN_KNOWLEDGE_AI_TOOL_NAMES) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("calls memory_propose and returns the created decision document", async () => {
    const registry = createRegistry();
    const service = createService();
    registerKnowledgeAiTools(registry, service);

    const handler = registry.getHandler("memory_propose");
    const output = await handler?.({
      title: "Auth",
      proposed_memories: [{ title: "Auth", body: "Use session cookies first." }],
      default_selection: "none",
    });

    expect(service.lastRequest?.default_selection).toBe("none");
    expect(JSON.parse(output ?? "{}")).toMatchObject({
      doc_id: "doc_auth",
      path: "Knowledge/decisions/auth.md",
    });
  });

  it("calls memory_search and returns committed memory hits", async () => {
    const registry = createRegistry();
    const service = createService();
    registerKnowledgeAiTools(registry, service);

    const handler = registry.getHandler("memory_search");
    const output = await handler?.({
      query: "session",
      limit: 3,
      tags: ["auth"],
      kinds: ["decision"],
    });

    expect(service.lastSearchRequest).toEqual({
      query: "session",
      limit: 3,
      tags: ["auth"],
      kinds: ["decision"],
    });
    expect(JSON.parse(output ?? "{}")).toMatchObject({
      hits: [{ id: "mem_auth", path: "Knowledge/memory/mem_auth.md" }],
    });
  });

  it("calls memory_context and returns read-only memory context", async () => {
    const registry = createRegistry();
    const service = createService();
    registerKnowledgeAiTools(registry, service);

    const handler = registry.getHandler("memory_context");
    const output = await handler?.({
      query: "session",
      active_path: "Notes/Auth.md",
      limit: 2,
    });

    expect(service.lastContextRequest).toEqual({
      query: "session",
      active_path: "Notes/Auth.md",
      limit: 2,
    });
    expect(JSON.parse(output ?? "{}")).toMatchObject({
      query: "session",
      memories: [{ id: "mem_auth", path: "Knowledge/memory/mem_auth.md" }],
    });
  });

  it("normalizes memory_propose arguments without adding apply fields", () => {
    const request = memoryProposeRequestFromArgs({
      title: "Auth",
      proposed_memories: [{ title: "Auth", body: "Use session cookies first." }],
      default_selection: "yes",
    });

    expect(request).toEqual({
      title: "Auth",
      context: undefined,
      source_refs: undefined,
      proposed_memories: [{ title: "Auth", body: "Use session cookies first." }],
      default_selection: "yes",
    });
    expect("expected_checksum" in request).toBe(false);
    expect("source" in request).toBe(false);
  });

  it("normalizes memory_search and memory_context arguments", () => {
    expect(
      memorySearchRequestFromArgs({
        query: "session",
        limit: 50,
        tags: ["auth", 1, "debug"],
        kinds: ["decision"],
      }),
    ).toEqual({
      query: "session",
      limit: 50,
      tags: ["auth", "debug"],
      kinds: ["decision"],
    });

    expect(
      memoryContextRequestFromArgs({
        query: "session",
        active_path: "Notes/Auth.md",
        limit: 5,
      }),
    ).toEqual({
      query: "session",
      active_path: "Notes/Auth.md",
      limit: 5,
    });
  });
});

function createRegistry(): AiProxyToolRegistry {
  const tools = new Map<string, ProxyToolSpec>();
  return {
    register(tool) {
      tools.set(tool.name, tool);
      return () => tools.delete(tool.name);
    },
    list(): ProxyToolDescriptor[] {
      return [...tools.values()].map((tool) => ({
        name: tool.name,
        toolId: tool.toolId,
        description: tool.description,
        parameters: tool.parameters,
        category: tool.category,
        aiEnabled: tool.aiEnabled,
      }));
    },
    getHandler(name) {
      return tools.get(name)?.handler;
    },
    subscribe() {
      return () => {};
    },
  };
}

function createService(): KnowledgeService & {
  lastRequest?: Parameters<KnowledgeService["proposeMemory"]>[0];
  lastSearchRequest?: Parameters<KnowledgeService["searchMemory"]>[0];
  lastContextRequest?: Parameters<KnowledgeService["memoryContext"]>[0];
} {
  const service: KnowledgeService & {
    lastRequest?: Parameters<KnowledgeService["proposeMemory"]>[0];
    lastSearchRequest?: Parameters<KnowledgeService["searchMemory"]>[0];
    lastContextRequest?: Parameters<KnowledgeService["memoryContext"]>[0];
  } = {
    lastRequest: undefined,
    lastSearchRequest: undefined,
    lastContextRequest: undefined,
    status: async () => ({
      ok: true,
      value: {
        initialized: true,
        root_exists: true,
        memory_dir_exists: true,
        proposals_dir_exists: true,
        decisions_dir_exists: true,
        cache_dir_exists: true,
      },
    }),
    init: async () => ({
      ok: true,
      value: {
        initialized: true,
        root_exists: true,
        memory_dir_exists: true,
        proposals_dir_exists: true,
        decisions_dir_exists: true,
        cache_dir_exists: true,
        created_dirs: [],
      },
    }),
    createDecisionDocument: async () => ({
      ok: true,
      value: {
        doc_id: "doc_auth",
        proposal_id: "prop_auth",
        path: "Knowledge/decisions/auth.md",
        title: "Auth",
        created: true,
        should_open: true,
      },
    }),
    proposeMemory: async (request) => {
      service.lastRequest = request;
      return {
        ok: true,
        value: {
          doc_id: "doc_auth",
          proposal_id: "prop_auth",
          path: "Knowledge/decisions/auth.md",
          title: "Auth",
          created: true,
          should_open: true,
        },
      };
    },
    readDecisionDocument: async () => ({
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "read decision document is not used by this test",
      },
    }),
    readMemory: async () => ({
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "read memory is not used by this test",
      },
    }),
    applyDecisionDocument: async () => ({
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "apply is not exposed to AI",
      },
    }),
    searchMemory: async (request) => {
      service.lastSearchRequest = request;
      return {
        ok: true,
        value: {
          hits: [memoryHit()],
          warnings: [],
          skipped_paths: [],
        },
      };
    },
    memoryContext: async (request) => {
      service.lastContextRequest = request;
      return {
        ok: true,
        value: {
          query: request.query,
          memories: [memoryHit()],
          warnings: [],
          skipped_paths: [],
        },
      };
    },
  };
  return service;
}

function memoryHit() {
  return {
    id: "mem_auth",
    path: "Knowledge/memory/mem_auth.md",
    title: "Auth",
    kind: "decision",
    snippet: "Use session cookies first.",
    tags: ["auth"],
    source_refs: [],
    score: 100,
  };
}
