import type { AiProxyToolRegistry } from "~/plugins/builtin/core_tool_registry/types";
import type { Disposer } from "~/plugins/types";

import { buildWidgetMarkdownEmbed, serializeWidgetArtifactOutput } from "./artifact";
import {
  createWidgetProjectStore,
  defaultEntryForType,
  type WidgetProjectStoreOptions,
} from "./project_store";
import type { WidgetProjectFile, WidgetType } from "./types";

const WIDGET_FILE_PARAMETER_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Project-relative file path such as index.html or src/chart.js.",
    },
    content: { type: "string" },
  },
  required: ["path", "content"],
};

function registerWidgetAiTools(
  registry: AiProxyToolRegistry,
  storeOptions: WidgetProjectStoreOptions = {},
): Disposer {
  const store = createWidgetProjectStore(storeOptions);
  const disposers = [
    registry.register({
      name: "create_widget",
      toolId: "widget.create_widget",
      description:
        "Create or update a sandboxed HTML or SVG visualization widget and return a chat preview artifact plus a markdownEmbed block. Insert markdownEmbed into notes with edit_file to render the widget; do not write raw iframe HTML.",
      category: "widget",
      access: "proposesMutation",
      parameters: {
        type: "object",
        properties: {
          widgetId: {
            type: "string",
            description: "Optional existing widget id to update.",
          },
          widgetName: { type: "string" },
          type: { type: "string", enum: ["html", "svg"] },
          code: {
            type: "string",
            description:
              "Single-file widget source. For html this becomes index.html; for svg this becomes widget.svg.",
          },
          entry: {
            type: "string",
            description: "Entry file when files is used. Defaults to index.html or widget.svg.",
          },
          height: {
            type: "number",
            description: "Rendered widget height in pixels. Defaults to 320.",
          },
          files: {
            type: "array",
            items: WIDGET_FILE_PARAMETER_SCHEMA,
          },
        },
        required: ["widgetName", "type"],
      },
      handler: async (args) => {
        const project = await store.save(widgetSaveInputFromArgs(args));
        return serializeWidgetArtifactOutput({
          kind: "kuku.widget-artifact",
          version: 1,
          widget: project,
          projectPath: `projects/${project.id}`,
          markdownEmbed: buildWidgetMarkdownEmbed(
            project.id,
            optionalNumberArg(args, "height") ?? 320,
          ),
        });
      },
    }),
    registry.register({
      name: "list_widgets",
      toolId: "widget.list_widgets",
      description:
        "List saved sandboxed widget projects from the widget storage directory. Use this before create_widget; reuse an existing widget's markdownEmbed when it already satisfies the request.",
      category: "widget",
      access: "readOnly",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const summaries = await store.list();
        return JSON.stringify(
          summaries.map((summary) => ({
            ...summary,
            projectPath: widgetProjectPath(summary.id),
            markdownEmbed: buildWidgetMarkdownEmbed(summary.id),
          })),
          null,
          2,
        );
      },
    }),
    registry.register({
      name: "read_widget",
      toolId: "widget.read_widget",
      description:
        "Read a saved sandboxed widget project by id and return its artifact, source files, projectPath, and markdownEmbed for reuse.",
      category: "widget",
      access: "readOnly",
      parameters: {
        type: "object",
        properties: {
          widgetId: { type: "string" },
        },
        required: ["widgetId"],
      },
      handler: async (args) => {
        const project = await store.read(stringArg(args, "widgetId"));
        return serializeWidgetArtifactOutput({
          kind: "kuku.widget-artifact",
          version: 1,
          widget: project,
          projectPath: widgetProjectPath(project.id),
          markdownEmbed: buildWidgetMarkdownEmbed(project.id),
        });
      },
    }),
  ];

  return () => {
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      const dispose = disposers[index];
      if (!dispose) continue;
      dispose();
    }
  };
}

function widgetProjectPath(widgetId: string): string {
  return `projects/${widgetId}`;
}

function widgetSaveInputFromArgs(args: Record<string, unknown>): {
  widgetId?: string;
  name: string;
  type: WidgetType;
  entry?: string;
  files: WidgetProjectFile[];
} {
  const name = stringArg(args, "widgetName").trim();
  const type = widgetTypeArg(args.type);
  const entry = optionalStringArg(args, "entry") ?? defaultEntryForType(type);
  const widgetId = optionalStringArg(args, "widgetId");
  const files = filesArg(args.files, args.code, entry);
  return { widgetId, name, type, entry, files };
}

function filesArg(files: unknown, code: unknown, entry: string): WidgetProjectFile[] {
  if (Array.isArray(files) && files.length > 0) {
    return files.map((file) => {
      if (!isRecord(file)) throw new Error("Widget file must be an object");
      return {
        path: stringArg(file, "path"),
        content: stringArg(file, "content"),
      };
    });
  }

  if (typeof code === "string" && code.length > 0) {
    return [{ path: entry, content: code }];
  }

  throw new Error("create_widget requires code or files");
}

function widgetTypeArg(value: unknown): WidgetType {
  if (value === "html" || value === "svg") return value;
  throw new Error("Widget type must be html or svg");
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing string argument: ${key}`);
  }
  return value;
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`Expected string argument: ${key}`);
  return value;
}

function optionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected number argument: ${key}`);
  }
  return Math.max(120, Math.min(1200, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { registerWidgetAiTools, widgetSaveInputFromArgs };
