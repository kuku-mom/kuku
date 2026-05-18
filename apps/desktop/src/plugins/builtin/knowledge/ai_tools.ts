import type { AiProxyToolRegistry } from "~/plugins/builtin/core_tool_registry/types";
import type { Disposer } from "~/plugins/types";

import type {
  CreateDecisionDocumentRequest,
  KnowledgeContextRequest,
  KnowledgeError,
  MemoryContextRequest,
  ReadWikiPageRequest,
  SearchMemoryRequest,
  SearchWikiRequest,
  WikiProposePageRequest,
  WikiProposeUpdateRequest,
} from "./types";
import type { KnowledgeService } from "./service";

const KNOWLEDGE_AI_TOOL_NAMES = [
  "memory_search",
  "memory_context",
  "wiki_search",
  "wiki_read",
  "knowledge_context",
  "memory_propose",
  "wiki_propose_page",
  "wiki_propose_update",
] as const;
const FORBIDDEN_KNOWLEDGE_AI_TOOL_NAMES = [
  "memory_commit",
  "memory_write",
  "memory_delete",
  "knowledge_apply_decision_document",
  "wiki_write_page",
  "wiki_commit",
  "wiki_apply_decision_document",
] as const;

const SOURCE_REF_PARAMETER_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Vault-relative source document path.",
    },
    title: { type: "string" },
    section_path: {
      type: "array",
      items: { type: "string" },
      description: "Optional source heading path.",
    },
    range: {
      type: "object",
      properties: {
        start_line: { type: "integer" },
        end_line: { type: "integer" },
      },
      required: ["start_line", "end_line"],
    },
    checksum: { type: "string" },
    captured_at: {
      type: "string",
      description: "Optional ISO-8601 capture timestamp.",
    },
  },
  required: ["path"],
};

const PROPOSED_MEMORY_PARAMETER_SCHEMA = {
  type: "object",
  properties: {
    suggested_id: {
      type: "string",
      description: "Optional stable memory id suggestion.",
    },
    kind: {
      type: "string",
      description: "Memory kind, for example decision, preference, or fact.",
    },
    title: { type: "string" },
    body: { type: "string" },
    tags: {
      type: "array",
      items: { type: "string" },
    },
    source_refs: {
      type: "array",
      items: SOURCE_REF_PARAMETER_SCHEMA,
    },
    decision: {
      type: "object",
      properties: {
        question: { type: "string" },
        selected_option_id: {
          type: "string",
          enum: ["yes", "no", "other"],
        },
        other_text: { type: "string" },
      },
    },
  },
  required: ["title", "body"],
};

const PROPOSED_WIKI_PAGE_PARAMETER_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Vault-relative committed wiki page path under Knowledge/wiki ending in .md. Use Knowledge/wiki/sources for source pages, Knowledge/wiki/concepts for concept pages, Knowledge/wiki/entities for entity pages, and Knowledge/wiki/synthesis for synthesis pages.",
    },
    expected_checksum: {
      type: "string",
      description: "Required only for wiki_propose_update.",
    },
    page_type: {
      type: "string",
      enum: ["source", "concept", "entity", "synthesis"],
    },
    title: { type: "string" },
    body: { type: "string" },
    tags: {
      type: "array",
      items: { type: "string" },
    },
    source_refs: {
      type: "array",
      items: SOURCE_REF_PARAMETER_SCHEMA,
    },
    decision: {
      type: "object",
      properties: {
        question: { type: "string" },
        selected_option_id: {
          type: "string",
          enum: ["yes", "no", "other"],
        },
        other_text: { type: "string" },
      },
    },
  },
  required: ["path", "page_type", "title", "body"],
};

const PROPOSED_WIKI_UPDATE_PARAMETER_SCHEMA = {
  ...PROPOSED_WIKI_PAGE_PARAMETER_SCHEMA,
  required: ["path", "expected_checksum", "page_type", "title", "body"],
};

const WIKI_PAGE_TYPE_PARAMETER_SCHEMA = {
  type: "string",
  enum: ["source", "concept", "entity", "synthesis"],
};

function registerKnowledgeAiTools(
  registry: AiProxyToolRegistry,
  service: KnowledgeService,
): Disposer {
  const disposers = [
    registry.register({
      name: "memory_search",
      toolId: "knowledge.memory_search",
      description: "Search committed Knowledge MemoryItems. This is read-only.",
      category: "knowledge",
      access: "readOnly",
      kind: "search",
      riskLevel: "low",
      requiresApproval: false,
      modeAvailability: ["ask", "inline", "agent"],
      permissionRuleKey: "knowledge.memory_search",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", description: "Defaults to 10 and is capped at 50." },
          tags: { type: "array", items: { type: "string" } },
          kinds: { type: "array", items: { type: "string" } },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const result = await service.searchMemory(memorySearchRequestFromArgs(args));
        if (!result.ok) {
          throw new Error(formatKnowledgeError(result.error));
        }
        return JSON.stringify(result.value, null, 2);
      },
    }),
    registry.register({
      name: "memory_context",
      toolId: "knowledge.memory_context",
      description: "Return committed Knowledge memory context for a query. This is read-only.",
      category: "knowledge",
      access: "readOnly",
      kind: "read",
      riskLevel: "low",
      requiresApproval: false,
      modeAvailability: ["ask", "inline", "agent"],
      permissionRuleKey: "knowledge.memory_context",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          active_path: {
            type: "string",
            description: "Optional vault-relative active document path hint.",
          },
          limit: { type: "integer", description: "Defaults to 10 and is capped at 50." },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const result = await service.memoryContext(memoryContextRequestFromArgs(args));
        if (!result.ok) {
          throw new Error(formatKnowledgeError(result.error));
        }
        return JSON.stringify(result.value, null, 2);
      },
    }),
    registry.register({
      name: "wiki_search",
      toolId: "knowledge.wiki_search",
      description:
        "Search committed Knowledge wiki pages. This is read-only and only returns Knowledge/wiki pages.",
      category: "knowledge",
      access: "readOnly",
      kind: "search",
      riskLevel: "low",
      requiresApproval: false,
      modeAvailability: ["ask", "inline", "agent"],
      permissionRuleKey: "knowledge.wiki_search",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", description: "Defaults to 10 and is capped at 50." },
          tags: { type: "array", items: { type: "string" } },
          page_types: {
            type: "array",
            items: WIKI_PAGE_TYPE_PARAMETER_SCHEMA,
            description: "Optional filter for source, concept, entity, or synthesis pages.",
          },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const result = await service.searchWiki(wikiSearchRequestFromArgs(args));
        if (!result.ok) {
          throw new Error(formatKnowledgeError(result.error));
        }
        return JSON.stringify(result.value, null, 2);
      },
    }),
    registry.register({
      name: "wiki_read",
      toolId: "knowledge.wiki_read",
      description: "Read and parse a committed Knowledge wiki page by path. This is read-only.",
      category: "knowledge",
      access: "readOnly",
      kind: "read",
      riskLevel: "low",
      requiresApproval: false,
      modeAvailability: ["ask", "inline", "agent"],
      permissionRuleKey: "knowledge.wiki_read",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Vault-relative path under Knowledge/wiki ending in .md.",
          },
        },
        required: ["path"],
      },
      handler: async (args) => {
        const result = await service.readWikiPage(readWikiPageRequestFromArgs(args));
        if (!result.ok) {
          throw new Error(formatKnowledgeError(result.error));
        }
        return JSON.stringify(result.value, null, 2);
      },
    }),
    registry.register({
      name: "knowledge_context",
      toolId: "knowledge.knowledge_context",
      description:
        "Return read-only Knowledge context by combining committed memory and wiki search hits.",
      category: "knowledge",
      access: "readOnly",
      kind: "search",
      riskLevel: "low",
      requiresApproval: false,
      modeAvailability: ["ask", "inline", "agent"],
      permissionRuleKey: "knowledge.knowledge_context",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          active_path: {
            type: "string",
            description: "Optional vault-relative active document path hint.",
          },
          limit: { type: "integer", description: "Defaults to 10 and is capped at 50." },
          include: {
            type: "array",
            items: { type: "string", enum: ["memory", "wiki"] },
            description: "Defaults to both memory and wiki.",
          },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const result = await service.knowledgeContext(knowledgeContextRequestFromArgs(args));
        if (!result.ok) {
          throw new Error(formatKnowledgeError(result.error));
        }
        return JSON.stringify(result.value, null, 2);
      },
    }),
    registry.register({
      name: "memory_propose",
      toolId: "knowledge.memory_propose",
      description:
        "Create a Knowledge decision document that proposes memories for explicit user review. This never commits memory.",
      category: "knowledge",
      access: "proposesMutation",
      kind: "proposal",
      riskLevel: "medium",
      requiresApproval: true,
      modeAvailability: ["agent"],
      permissionRuleKey: "knowledge.memory_propose",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          context: { type: "string" },
          source_refs: {
            type: "array",
            items: SOURCE_REF_PARAMETER_SCHEMA,
          },
          proposed_memories: {
            type: "array",
            items: PROPOSED_MEMORY_PARAMETER_SCHEMA,
            description: "Memory proposals to place in a user-reviewed decision document.",
          },
          default_selection: {
            type: "string",
            enum: ["yes", "none"],
            description: "Defaults to yes. Use none when the user should make every selection.",
          },
        },
        required: ["proposed_memories"],
      },
      handler: async (args) => {
        const result = await service.proposeMemory(memoryProposeRequestFromArgs(args));
        if (!result.ok) {
          throw new Error(formatKnowledgeError(result.error));
        }
        return JSON.stringify(result.value, null, 2);
      },
    }),
    registry.register({
      name: "wiki_propose_page",
      toolId: "knowledge.wiki_propose_page",
      description:
        "Create a Knowledge decision document that proposes committed wiki pages for explicit user review. This never writes Knowledge/wiki pages.",
      category: "knowledge",
      access: "proposesMutation",
      kind: "proposal",
      riskLevel: "medium",
      requiresApproval: true,
      modeAvailability: ["agent"],
      permissionRuleKey: "knowledge.wiki_propose_page",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          context: { type: "string" },
          source_refs: {
            type: "array",
            items: SOURCE_REF_PARAMETER_SCHEMA,
          },
          proposed_pages: {
            type: "array",
            items: PROPOSED_WIKI_PAGE_PARAMETER_SCHEMA,
            description: "Wiki pages to place in a user-reviewed decision document.",
          },
          default_selection: {
            type: "string",
            enum: ["yes", "none"],
            description: "Defaults to yes. Use none when the user should make every selection.",
          },
        },
        required: ["proposed_pages"],
      },
      handler: async (args) => {
        const result = await service.proposeWikiPage(wikiProposePageRequestFromArgs(args));
        if (!result.ok) {
          throw new Error(formatKnowledgeError(result.error));
        }
        return JSON.stringify(result.value, null, 2);
      },
    }),
    registry.register({
      name: "wiki_propose_update",
      toolId: "knowledge.wiki_propose_update",
      description:
        "Create a Knowledge decision document that proposes updates to existing committed wiki pages. This never applies the update.",
      category: "knowledge",
      access: "proposesMutation",
      kind: "proposal",
      riskLevel: "medium",
      requiresApproval: true,
      modeAvailability: ["agent"],
      permissionRuleKey: "knowledge.wiki_propose_update",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          context: { type: "string" },
          source_refs: {
            type: "array",
            items: SOURCE_REF_PARAMETER_SCHEMA,
          },
          proposed_updates: {
            type: "array",
            items: PROPOSED_WIKI_UPDATE_PARAMETER_SCHEMA,
            description: "Wiki page updates to place in a user-reviewed decision document.",
          },
          default_selection: {
            type: "string",
            enum: ["yes", "none"],
            description: "Defaults to yes. Use none when the user should make every selection.",
          },
        },
        required: ["proposed_updates"],
      },
      handler: async (args) => {
        const result = await service.proposeWikiUpdate(wikiProposeUpdateRequestFromArgs(args));
        if (!result.ok) {
          throw new Error(formatKnowledgeError(result.error));
        }
        return JSON.stringify(result.value, null, 2);
      },
    }),
  ];

  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}

function memorySearchRequestFromArgs(args: Record<string, unknown>): SearchMemoryRequest {
  return {
    query: requiredString(args.query, "query"),
    limit: optionalInteger(args.limit, "limit"),
    tags: optionalStringArray(args.tags),
    kinds: optionalStringArray(args.kinds),
  };
}

function memoryContextRequestFromArgs(args: Record<string, unknown>): MemoryContextRequest {
  return {
    query: requiredString(args.query, "query"),
    active_path: optionalString(args.active_path),
    limit: optionalInteger(args.limit, "limit"),
  };
}

function wikiSearchRequestFromArgs(args: Record<string, unknown>): SearchWikiRequest {
  return {
    query: requiredString(args.query, "query"),
    limit: optionalInteger(args.limit, "limit"),
    tags: optionalStringArray(args.tags),
    page_types: optionalWikiPageTypes(args.page_types),
  };
}

function readWikiPageRequestFromArgs(args: Record<string, unknown>): ReadWikiPageRequest {
  return {
    path: requiredString(args.path, "path"),
  };
}

function knowledgeContextRequestFromArgs(args: Record<string, unknown>): KnowledgeContextRequest {
  return {
    query: requiredString(args.query, "query"),
    active_path: optionalString(args.active_path),
    limit: optionalInteger(args.limit, "limit"),
    include: optionalKnowledgeContextInclude(args.include),
  };
}

function memoryProposeRequestFromArgs(
  args: Record<string, unknown>,
): CreateDecisionDocumentRequest {
  if (!Array.isArray(args.proposed_memories)) {
    throw new Error("proposed_memories is required");
  }

  return {
    title: optionalString(args.title),
    context: optionalString(args.context),
    source_refs: optionalArray(args.source_refs) as CreateDecisionDocumentRequest["source_refs"],
    proposed_memories: args.proposed_memories as CreateDecisionDocumentRequest["proposed_memories"],
    default_selection: parseDefaultSelection(args.default_selection),
  };
}

function wikiProposePageRequestFromArgs(args: Record<string, unknown>): WikiProposePageRequest {
  if (!Array.isArray(args.proposed_pages)) {
    throw new Error("proposed_pages is required");
  }
  const sourceRefs = optionalArray(args.source_refs) as WikiProposePageRequest["source_refs"];

  return {
    title: optionalString(args.title),
    context: optionalString(args.context),
    source_refs: sourceRefs,
    proposed_pages: normalizeWikiProposalBodies(
      args.proposed_pages,
      sourceRefs,
    ) as WikiProposePageRequest["proposed_pages"],
    default_selection: parseDefaultSelection(args.default_selection),
  };
}

function wikiProposeUpdateRequestFromArgs(args: Record<string, unknown>): WikiProposeUpdateRequest {
  if (!Array.isArray(args.proposed_updates)) {
    throw new Error("proposed_updates is required");
  }
  const sourceRefs = optionalArray(args.source_refs) as WikiProposeUpdateRequest["source_refs"];

  return {
    title: optionalString(args.title),
    context: optionalString(args.context),
    source_refs: sourceRefs,
    proposed_updates: normalizeWikiProposalBodies(
      args.proposed_updates,
      sourceRefs,
    ) as WikiProposeUpdateRequest["proposed_updates"],
    default_selection: parseDefaultSelection(args.default_selection),
  };
}

function normalizeWikiProposalBodies(
  proposedPages: unknown[],
  requestSourceRefs?: WikiProposePageRequest["source_refs"],
): unknown[] {
  return proposedPages.map((page) => {
    if (!isRecord(page) || typeof page.body !== "string") return page;

    const sourceRefs = [
      ...(requestSourceRefs ?? []),
      ...(Array.isArray(page.source_refs) ? page.source_refs : []),
    ];
    const body = preserveSourceRefWikilinkTargets(page.body, sourceRefs);

    return body === page.body ? page : { ...page, body };
  });
}

function preserveSourceRefWikilinkTargets(markdown: string, sourceRefs: unknown[]): string {
  const refsByTitle = new Map<string, string>();
  for (const sourceRef of sourceRefs) {
    if (!isRecord(sourceRef)) continue;
    if (typeof sourceRef.path !== "string" || sourceRef.path.trim() === "") continue;
    if (typeof sourceRef.title !== "string" || sourceRef.title.trim() === "") continue;

    refsByTitle.set(normalizeWikilinkLookupKey(sourceRef.title), sourceRef.path);
  }

  if (refsByTitle.size === 0) return markdown;

  return markdown.replace(/\[\[([^\]\n|]+)\]\]/g, (match, rawTarget: string) => {
    const displayText = rawTarget.trim();
    const sourcePath = refsByTitle.get(normalizeWikilinkLookupKey(displayText));
    if (!sourcePath || displayText === sourcePath) return match;

    return `[[${sourcePath}|${displayText}]]`;
  });
}

function normalizeWikilinkLookupKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} is required`);
  }
  return value;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  return value;
}

function optionalArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function optionalWikiPageTypes(value: unknown): SearchWikiRequest["page_types"] {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (item): item is NonNullable<SearchWikiRequest["page_types"]>[number] =>
      item === "source" || item === "concept" || item === "entity" || item === "synthesis",
  );
}

function optionalKnowledgeContextInclude(value: unknown): KnowledgeContextRequest["include"] {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (item): item is NonNullable<KnowledgeContextRequest["include"]>[number] =>
      item === "memory" || item === "wiki",
  );
}

function parseDefaultSelection(value: unknown): CreateDecisionDocumentRequest["default_selection"] {
  if (value === "yes" || value === "none") {
    return value;
  }
  return undefined;
}

function formatKnowledgeError(error: KnowledgeError): string {
  return JSON.stringify({ code: error.code, message: error.message, details: error.details });
}

export {
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
};
