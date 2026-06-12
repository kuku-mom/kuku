import { describe, expect, it } from "vitest";

import { parseWidgetArtifactOutput } from "~/plugins/builtin/ai_widgets/artifact";
import { registerWidgetAiTools } from "~/plugins/builtin/ai_widgets/ai_tools";
import type {
  AiProxyToolRegistry,
  ProxyToolDescriptor,
  ProxyToolSpec,
} from "~/plugins/builtin/core_tool_registry/types";
import type { WidgetProjectFs } from "~/plugins/builtin/ai_widgets/project_store";

describe("widget AI tools", () => {
  it("registers create/list/read widget tools and returns a renderable artifact", async () => {
    const tools = new Map<string, ProxyToolSpec>();
    const fs = createMemoryWidgetFs();
    const registry: AiProxyToolRegistry = {
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
          access: tool.access ?? "readOnly",
          aiEnabled: tool.aiEnabled,
        }));
      },
      getHandler: (name) => tools.get(name)?.handler,
      subscribe: () => () => {},
    };

    registerWidgetAiTools(registry, {
      now: () => "2026-06-09T00:00:00.000Z",
      fs,
    });

    expect([...tools.keys()]).toEqual(["create_widget", "list_widgets", "read_widget"]);
    expect(tools.get("create_widget")?.access).toBe("proposesMutation");
    expect(tools.get("list_widgets")?.access).toBe("readOnly");
    expect(tools.get("read_widget")?.access).toBe("readOnly");

    const create = tools.get("create_widget");
    const output = await create?.handler({
      widgetName: "Daily Trends",
      type: "html",
      code: "<h1>Daily Trends</h1>",
    });

    expect(output).toBeTypeOf("string");
    const artifact = parseWidgetArtifactOutput(output ?? "");
    expect(artifact?.widget.id).toBe("daily-trends");
    expect(artifact?.markdownEmbed).toBe("```kuku-widget\nid: daily-trends\nheight: 320\n```");
    expect(artifact?.widget.files[0]).toEqual({
      path: "index.html",
      content: "<h1>Daily Trends</h1>",
    });

    const listOutput = await tools.get("list_widgets")?.handler({});
    const list = JSON.parse(listOutput ?? "[]") as Record<string, unknown>[];
    expect(list[0]).toMatchObject({
      id: "daily-trends",
      name: "Daily Trends",
      projectPath: ".kuku/plugins/ai-widgets/projects/daily-trends",
      markdownEmbed: "```kuku-widget\nid: daily-trends\nheight: 320\n```",
    });

    const readOutput = await tools.get("read_widget")?.handler({ widgetId: "daily-trends" });
    const readArtifact = parseWidgetArtifactOutput(readOutput ?? "");
    expect(readArtifact?.widget.id).toBe("daily-trends");
    expect(readArtifact?.projectPath).toBe(".kuku/plugins/ai-widgets/projects/daily-trends");
    expect(readArtifact?.markdownEmbed).toBe("```kuku-widget\nid: daily-trends\nheight: 320\n```");
  });

  it("keeps create_widget single-file until bundled project rendering is supported", async () => {
    const tools = new Map<string, ProxyToolSpec>();
    const registry: AiProxyToolRegistry = {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
      list: () => [],
      getHandler: (name) => tools.get(name)?.handler,
      subscribe: () => () => {},
    };

    registerWidgetAiTools(registry, {
      now: () => "2026-06-09T00:00:00.000Z",
      fs: createMemoryWidgetFs(),
    });

    const create = tools.get("create_widget");
    const properties = create?.parameters.properties as Record<string, unknown>;
    const required = create?.parameters.required as string[];

    expect(properties.files).toBeUndefined();
    expect(properties.entry).toBeUndefined();
    expect(required).toContain("code");
    await expect(
      create?.handler({
        widgetName: "Daily Trends",
        type: "html",
        files: [{ path: "index.html", content: "<h1>Daily Trends</h1>" }],
      }),
    ).rejects.toThrow("create_widget accepts only single-file code");
  });
});

function createMemoryWidgetFs(): WidgetProjectFs {
  const files = new Map<string, string>();

  return {
    async readDir(path) {
      const prefix = path.length > 0 ? `${path}/` : "";
      const names = new Set<string>();
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const [name] = rest.split("/");
        if (name) names.add(name);
      }
      return sortedStrings(names);
    },
    async readText(path) {
      const content = files.get(path);
      if (content == null) throw new Error(`Missing file: ${path}`);
      return content;
    },
    async writeText(path, content) {
      files.set(path, content);
    },
  };
}

function sortedStrings(values: Iterable<string>): string[] {
  const result: string[] = [];
  for (const value of values) {
    const index = result.findIndex((existing) => value.localeCompare(existing) < 0);
    if (index === -1) {
      result.push(value);
    } else {
      result.splice(index, 0, value);
    }
  }
  return result;
}
