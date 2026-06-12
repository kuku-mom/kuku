import {
  KUKU_WIDGET_LANGUAGE,
  type KukuWidgetAttrs,
  normalizeKukuWidgetAttrs,
} from "./widget_markdown";

function buildKukuWidgetSource(attrs: KukuWidgetAttrs): string {
  return `\`\`\`${KUKU_WIDGET_LANGUAGE}\nid: ${attrs.id}\nheight: ${attrs.height}\n\`\`\``;
}

function parseKukuWidgetSource(source: string): KukuWidgetAttrs | null {
  const normalized = source.replace(/\r\n?/g, "\n").trim();
  const fenced = new RegExp(`^\`\`\`${KUKU_WIDGET_LANGUAGE}\\n([\\s\\S]*?)\\n\`\`\`$`).exec(
    normalized,
  );
  return parseKukuWidgetSourceBody(fenced ? fenced[1] : normalized);
}

function parseKukuWidgetSourceBody(body: string): KukuWidgetAttrs | null {
  const fields = new Map<string, string>();
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    fields.set(match[1], match[2].trim());
  }

  return normalizeKukuWidgetAttrs({
    id: fields.get("id"),
    height: fields.get("height"),
  });
}

export { buildKukuWidgetSource, parseKukuWidgetSource };
