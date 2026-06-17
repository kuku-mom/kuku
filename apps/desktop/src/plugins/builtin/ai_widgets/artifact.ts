import type { WidgetArtifactEnvelope, WidgetProject, WidgetProjectFile } from "./types";

function serializeWidgetArtifactOutput(envelope: WidgetArtifactEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

function parseWidgetArtifactOutput(output: string): WidgetArtifactEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (parsed.kind !== "kuku.widget-artifact" || parsed.version !== 1) return null;
  if (typeof parsed.projectPath !== "string") return null;
  if (!isWidgetProject(parsed.widget)) return null;

  return {
    kind: "kuku.widget-artifact",
    version: 1,
    projectPath: parsed.projectPath,
    markdownEmbed:
      typeof parsed.markdownEmbed === "string"
        ? parsed.markdownEmbed
        : buildWidgetMarkdownEmbed(parsed.widget.id),
    widget: parsed.widget,
  };
}

function buildWidgetMarkdownEmbed(widgetId: string, height = 320): string {
  return `\`\`\`kuku-widget\nid: ${widgetId}\nheight: ${height}\n\`\`\``;
}

function isWidgetProject(value: unknown): value is WidgetProject {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string") return false;
  if (typeof value.name !== "string") return false;
  if (value.type !== "html" && value.type !== "svg") return false;
  if (typeof value.entry !== "string") return false;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  if (!Array.isArray(value.files) || !value.files.every(isWidgetProjectFile)) return false;
  return true;
}

function isWidgetProjectFile(value: unknown): value is WidgetProjectFile {
  return isRecord(value) && typeof value.path === "string" && typeof value.content === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { buildWidgetMarkdownEmbed, parseWidgetArtifactOutput, serializeWidgetArtifactOutput };
