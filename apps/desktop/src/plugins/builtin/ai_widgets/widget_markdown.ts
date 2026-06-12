import type { Code, RootContent } from "mdast";

import type { MdastToPmBlockHandler, PMNodeJSON, PmToMdastBlockHandler } from "~/lib/markdown";

const KUKU_WIDGET_LANGUAGE = "kuku-widget";
const DEFAULT_WIDGET_HEIGHT = 320;
const MIN_WIDGET_HEIGHT = 120;
const MAX_WIDGET_HEIGHT = 1200;

interface KukuWidgetAttrs {
  id: string;
  height: number;
}

const kukuWidgetMdastHandler: MdastToPmBlockHandler = (node) => {
  const code = node as Code;
  if (code.lang !== KUKU_WIDGET_LANGUAGE) {
    return codeBlockPmNode(code);
  }

  const attrs = parseKukuWidgetAttrs(code.value);
  if (!attrs) {
    return codeBlockPmNode(code);
  }

  return [
    {
      type: "kukuWidget",
      attrs: attrs as unknown as Record<string, unknown>,
    },
  ];
};

const kukuWidgetPmHandler: PmToMdastBlockHandler = (node) => {
  const attrs = normalizeKukuWidgetAttrs(node.attrs ?? {});
  if (!attrs) return null;

  const result: Code = {
    type: "code",
    lang: KUKU_WIDGET_LANGUAGE,
    value: `id: ${attrs.id}\nheight: ${attrs.height}`,
  };
  return result as RootContent;
};

function parseKukuWidgetAttrs(value: string): KukuWidgetAttrs | null {
  const fields = new Map<string, string>();
  for (const line of value.replace(/\r\n?/g, "\n").split("\n")) {
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

function normalizeKukuWidgetAttrs(attrs: Record<string, unknown>): KukuWidgetAttrs | null {
  const id = typeof attrs.id === "string" ? attrs.id.trim() : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) return null;

  return { id, height: normalizeKukuWidgetHeight(attrs.height) };
}

function normalizeKukuWidgetHeight(rawHeight: unknown): number {
  let parsedHeight = DEFAULT_WIDGET_HEIGHT;
  if (typeof rawHeight === "number") {
    parsedHeight = rawHeight;
  } else if (typeof rawHeight === "string" && rawHeight.trim()) {
    parsedHeight = Number(rawHeight);
  }

  if (!Number.isFinite(parsedHeight)) return DEFAULT_WIDGET_HEIGHT;
  return Math.max(MIN_WIDGET_HEIGHT, Math.min(MAX_WIDGET_HEIGHT, Math.round(parsedHeight)));
}

function codeBlockPmNode(code: Code): PMNodeJSON[] {
  const result: PMNodeJSON = {
    type: "codeBlock",
    attrs: { language: code.lang ?? "" },
  };
  if (code.value) {
    result.content = [{ type: "text", text: code.value }];
  }
  return [result];
}

export {
  DEFAULT_WIDGET_HEIGHT,
  KUKU_WIDGET_LANGUAGE,
  MAX_WIDGET_HEIGHT,
  MIN_WIDGET_HEIGHT,
  kukuWidgetMdastHandler,
  kukuWidgetPmHandler,
  normalizeKukuWidgetAttrs,
  normalizeKukuWidgetHeight,
};
export type { KukuWidgetAttrs };
