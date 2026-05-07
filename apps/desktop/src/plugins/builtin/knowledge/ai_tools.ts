import type { AiProxyToolRegistry } from "~/plugins/builtin/core_tool_registry/types";
import type { Disposer } from "~/plugins/types";

import type {
  CreateDecisionDocumentRequest,
  KnowledgeError,
  MemoryContextRequest,
  SearchMemoryRequest,
} from "./types";
import type { KnowledgeService } from "./service";

const KNOWLEDGE_AI_TOOL_NAMES = ["memory_search", "memory_context", "memory_propose"] as const;
const FORBIDDEN_KNOWLEDGE_AI_TOOL_NAMES = [
  "memory_commit",
  "memory_write",
  "memory_delete",
  "knowledge_apply_decision_document",
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
      name: "memory_propose",
      toolId: "knowledge.memory_propose",
      description:
        "Create a Knowledge decision document that proposes memories for explicit user review. This never commits memory.",
      category: "knowledge",
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
  memoryContextRequestFromArgs,
  memoryProposeRequestFromArgs,
  memorySearchRequestFromArgs,
  registerKnowledgeAiTools,
};
