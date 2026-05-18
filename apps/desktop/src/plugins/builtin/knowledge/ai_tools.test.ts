import { describe, expect, it } from "vitest";

import type {
  AiProxyToolRegistry,
  ProxyToolDescriptor,
  ProxyToolSpec,
} from "~/plugins/builtin/core_tool_registry/types";

import {
  FORBIDDEN_KNOWLEDGE_AI_TOOL_NAMES,
  KNOWLEDGE_AI_TOOL_NAMES,
  knowledgeContextRequestFromArgs,
  memoryContextRequestFromArgs,
  memoryProposeRequestFromArgs,
  memorySearchRequestFromArgs,
  readWikiPageRequestFromArgs,
  registerKnowledgeAiTools,
  wikiSearchRequestFromArgs,
  wikiProposePageRequestFromArgs,
  wikiProposeUpdateRequestFromArgs,
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

  it("classifies committed Knowledge reads as read-only and proposals as mutations", () => {
    const registry = createRegistry();
    const service = createService();

    registerKnowledgeAiTools(registry, service);

    const byName = new Map(registry.list().map((tool) => [tool.name, tool]));
    for (const name of ["memory_search", "wiki_search", "knowledge_context"]) {
      expect(byName.get(name)).toMatchObject({
        access: "readOnly",
        kind: "search",
        riskLevel: "low",
      });
    }
    for (const name of ["memory_context", "wiki_read"]) {
      expect(byName.get(name)).toMatchObject({
        access: "readOnly",
        kind: "read",
        riskLevel: "low",
      });
    }
    for (const name of ["memory_propose", "wiki_propose_page", "wiki_propose_update"]) {
      expect(byName.get(name)).toMatchObject({
        access: "proposesMutation",
        kind: "proposal",
        riskLevel: "medium",
        requiresApproval: true,
        modeAvailability: ["agent"],
      });
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

  it("calls wiki_propose_page and returns the created decision document", async () => {
    const registry = createRegistry();
    const service = createService();
    registerKnowledgeAiTools(registry, service);

    const handler = registry.getHandler("wiki_propose_page");
    const output = await handler?.({
      title: "Auth Wiki",
      proposed_pages: [
        {
          path: "Knowledge/wiki/concepts/session-cookie-auth.md",
          page_type: "concept",
          title: "Session cookie auth",
          body: "Use session cookies first.",
        },
      ],
      default_selection: "none",
    });

    expect(service.lastWikiPageRequest?.default_selection).toBe("none");
    expect(service.lastWikiPageRequest?.proposed_pages[0]).toMatchObject({
      path: "Knowledge/wiki/concepts/session-cookie-auth.md",
      page_type: "concept",
    });
    expect(JSON.parse(output ?? "{}")).toMatchObject({
      doc_id: "doc_auth",
      path: "Knowledge/decisions/auth.md",
    });
  });

  it("calls wiki_propose_update and carries expected checksums", async () => {
    const registry = createRegistry();
    const service = createService();
    registerKnowledgeAiTools(registry, service);

    const handler = registry.getHandler("wiki_propose_update");
    const output = await handler?.({
      title: "Auth Wiki Update",
      proposed_updates: [
        {
          path: "Knowledge/wiki/concepts/session-cookie-auth.md",
          expected_checksum:
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
          page_type: "concept",
          title: "Session cookie auth",
          body: "Use session cookies first, updated.",
        },
      ],
    });

    expect(service.lastWikiUpdateRequest?.proposed_updates[0].expected_checksum).toMatch(
      /^sha256:/,
    );
    expect(JSON.parse(output ?? "{}")).toMatchObject({
      path: "Knowledge/decisions/auth.md",
      should_open: true,
    });
  });

  it("registers Gemini-compatible array item schemas", () => {
    const registry = createRegistry();
    const service = createService();
    registerKnowledgeAiTools(registry, service);

    for (const tool of registry.list()) {
      expect(findArrayWithoutItems(tool.parameters)).toEqual([]);
    }
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

  it("calls wiki_search and returns committed wiki hits", async () => {
    const registry = createRegistry();
    const service = createService();
    registerKnowledgeAiTools(registry, service);

    const handler = registry.getHandler("wiki_search");
    const output = await handler?.({
      query: "session",
      limit: 3,
      tags: ["auth"],
      page_types: ["concept"],
    });

    expect(service.lastWikiSearchRequest).toEqual({
      query: "session",
      limit: 3,
      tags: ["auth"],
      page_types: ["concept"],
    });
    expect(JSON.parse(output ?? "{}")).toMatchObject({
      hits: [
        {
          id: "wiki_auth",
          path: "Knowledge/wiki/concepts/session-cookie-auth.md",
        },
      ],
    });
  });

  it("calls wiki_read and returns parsed wiki page content", async () => {
    const registry = createRegistry();
    const service = createService();
    registerKnowledgeAiTools(registry, service);

    const handler = registry.getHandler("wiki_read");
    const output = await handler?.({
      path: "Knowledge/wiki/concepts/session-cookie-auth.md",
    });

    expect(service.lastReadWikiRequest).toEqual({
      path: "Knowledge/wiki/concepts/session-cookie-auth.md",
    });
    expect(JSON.parse(output ?? "{}")).toMatchObject({
      path: "Knowledge/wiki/concepts/session-cookie-auth.md",
      page: { id: "wiki_auth", page_type: "concept" },
    });
  });

  it("calls knowledge_context and combines memory and wiki context", async () => {
    const registry = createRegistry();
    const service = createService();
    registerKnowledgeAiTools(registry, service);

    const handler = registry.getHandler("knowledge_context");
    const output = await handler?.({
      query: "session",
      active_path: "Notes/Auth.md",
      limit: 2,
      include: ["memory", "wiki"],
    });

    expect(service.lastKnowledgeContextRequest).toEqual({
      query: "session",
      active_path: "Notes/Auth.md",
      limit: 2,
      include: ["memory", "wiki"],
    });
    expect(JSON.parse(output ?? "{}")).toMatchObject({
      query: "session",
      memory_hits: [{ id: "mem_auth" }],
      wiki_hits: [{ id: "wiki_auth" }],
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

  it("normalizes wiki proposal arguments without adding write or apply fields", () => {
    const createRequest = wikiProposePageRequestFromArgs({
      title: "Auth Wiki",
      proposed_pages: [
        {
          path: "Knowledge/wiki/concepts/session-cookie-auth.md",
          page_type: "concept",
          title: "Session cookie auth",
          body: "Use session cookies first.",
        },
      ],
      default_selection: "yes",
    });

    expect(createRequest).toEqual({
      title: "Auth Wiki",
      context: undefined,
      source_refs: undefined,
      proposed_pages: [
        {
          path: "Knowledge/wiki/concepts/session-cookie-auth.md",
          page_type: "concept",
          title: "Session cookie auth",
          body: "Use session cookies first.",
        },
      ],
      default_selection: "yes",
    });
    expect("source" in createRequest).toBe(false);
    expect("apply" in createRequest).toBe(false);

    const updateRequest = wikiProposeUpdateRequestFromArgs({
      proposed_updates: [
        {
          path: "Knowledge/wiki/concepts/session-cookie-auth.md",
          expected_checksum:
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
          page_type: "concept",
          title: "Session cookie auth",
          body: "Updated body.",
        },
      ],
    });

    expect(updateRequest.proposed_updates[0].expected_checksum).toMatch(/^sha256:/);
    expect("source" in updateRequest).toBe(false);
    expect("apply" in updateRequest).toBe(false);
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

  it("normalizes wiki_search, wiki_read, and knowledge_context arguments", () => {
    expect(
      wikiSearchRequestFromArgs({
        query: "session",
        limit: 50,
        tags: ["auth", 1, "debug"],
        page_types: ["concept", "invalid", "source"],
      }),
    ).toEqual({
      query: "session",
      limit: 50,
      tags: ["auth", "debug"],
      page_types: ["concept", "source"],
    });

    expect(
      readWikiPageRequestFromArgs({
        path: "Knowledge/wiki/concepts/session-cookie-auth.md",
      }),
    ).toEqual({
      path: "Knowledge/wiki/concepts/session-cookie-auth.md",
    });

    expect(
      knowledgeContextRequestFromArgs({
        query: "session",
        active_path: "Notes/Auth.md",
        limit: 5,
        include: ["memory", "raw", "wiki"],
      }),
    ).toEqual({
      query: "session",
      active_path: "Notes/Auth.md",
      limit: 5,
      include: ["memory", "wiki"],
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
        access: tool.access,
        kind: tool.kind,
        riskLevel: tool.riskLevel,
        requiresApproval: tool.requiresApproval,
        modeAvailability: tool.modeAvailability,
        permissionRuleKey: tool.permissionRuleKey,
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

function findArrayWithoutItems(value: unknown, path = "$"): string[] {
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const missing = record.type === "array" && !("items" in record) ? [path] : [];

  return Object.entries(record).reduce<string[]>((acc, [key, child]) => {
    acc.push(...findArrayWithoutItems(child, `${path}.${key}`));
    return acc;
  }, missing);
}

function createService(): KnowledgeService & {
  lastRequest?: Parameters<KnowledgeService["proposeMemory"]>[0];
  lastWikiPageRequest?: Parameters<KnowledgeService["proposeWikiPage"]>[0];
  lastWikiUpdateRequest?: Parameters<KnowledgeService["proposeWikiUpdate"]>[0];
  lastSearchRequest?: Parameters<KnowledgeService["searchMemory"]>[0];
  lastContextRequest?: Parameters<KnowledgeService["memoryContext"]>[0];
  lastWikiSearchRequest?: Parameters<KnowledgeService["searchWiki"]>[0];
  lastReadWikiRequest?: Parameters<KnowledgeService["readWikiPage"]>[0];
  lastKnowledgeContextRequest?: Parameters<KnowledgeService["knowledgeContext"]>[0];
} {
  const service: KnowledgeService & {
    lastRequest?: Parameters<KnowledgeService["proposeMemory"]>[0];
    lastWikiPageRequest?: Parameters<KnowledgeService["proposeWikiPage"]>[0];
    lastWikiUpdateRequest?: Parameters<KnowledgeService["proposeWikiUpdate"]>[0];
    lastSearchRequest?: Parameters<KnowledgeService["searchMemory"]>[0];
    lastContextRequest?: Parameters<KnowledgeService["memoryContext"]>[0];
    lastWikiSearchRequest?: Parameters<KnowledgeService["searchWiki"]>[0];
    lastReadWikiRequest?: Parameters<KnowledgeService["readWikiPage"]>[0];
    lastKnowledgeContextRequest?: Parameters<KnowledgeService["knowledgeContext"]>[0];
  } = {
    lastRequest: undefined,
    lastWikiPageRequest: undefined,
    lastWikiUpdateRequest: undefined,
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
        wiki_dir_exists: true,
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
        wiki_dir_exists: true,
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
    createWikiDecisionDocument: async () => ({
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
    proposeWikiPage: async (request) => {
      service.lastWikiPageRequest = request;
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
    proposeWikiUpdate: async (request) => {
      service.lastWikiUpdateRequest = request;
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
    readWikiPage: async (request) => {
      service.lastReadWikiRequest = request;
      return {
        ok: true,
        value: {
          path: request.path,
          markdown: "---\nid: wiki_auth\n---\nUse session cookies first.\n",
          checksum: "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
          page: {
            id: "wiki_auth",
            page_type: "concept",
            title: "Session cookie auth",
            body: "Use session cookies first.",
            tags: ["auth"],
            source_refs: [],
            status: "active",
            created_at: "2026-05-07T00:00:00Z",
            updated_at: "2026-05-07T00:00:00Z",
            proposal_id: "prop_auth",
            decision_document: "Knowledge/decisions/auth.md",
          },
        },
      };
    },
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
    searchWiki: async (request) => {
      service.lastWikiSearchRequest = request;
      return {
        ok: true,
        value: {
          hits: [wikiHit()],
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
    knowledgeContext: async (request) => {
      service.lastKnowledgeContextRequest = request;
      return {
        ok: true,
        value: {
          query: request.query,
          active_path: request.active_path,
          memory_hits: [memoryHit()],
          wiki_hits: [wikiHit()],
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

function wikiHit() {
  return {
    id: "wiki_auth",
    path: "Knowledge/wiki/concepts/session-cookie-auth.md",
    title: "Session cookie auth",
    page_type: "concept" as const,
    snippet: "Use session cookies first.",
    tags: ["auth"],
    source_refs: [],
    score: 100,
  };
}
