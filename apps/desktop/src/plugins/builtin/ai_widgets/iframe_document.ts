import type { WidgetProject } from "./types";

const WIDGET_IFRAME_SANDBOX = "";
const WIDGET_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");
const WIDGET_BASE_STYLE =
  'html,body{margin:0;min-height:100%;background:transparent;color:CanvasText;font:13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;scrollbar-width:none;-ms-overflow-style:none}main{display:block}*{scrollbar-width:none;-ms-overflow-style:none}*::-webkit-scrollbar{display:none;width:0;height:0}';

function buildWidgetIframeDocument(project: WidgetProject): string {
  const entry = project.files.find((file) => file.path === project.entry) ?? project.files[0];
  const body = entry ? sanitizeWidgetSourceForIframe(entry.content) : "";

  if (project.type === "svg") {
    return completeHtmlDocument(`<main>${body}</main>`);
  }

  return completeHtmlDocument(body);
}

function completeHtmlDocument(body: string): string {
  return `<!doctype html><html><head>${headInjection()}</head><body>${body}</body></html>`;
}

function headInjection(): string {
  return `${cspMeta()}<style>${WIDGET_BASE_STYLE}</style>`;
}

function cspMeta(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(WIDGET_CSP)}">`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

const ALLOWED_STATIC_URLS = new Set(["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xlink"]);

const EXTERNAL_URL_PATTERN = /\bhttps?:\/\/[^\s"'<>`)]+/gi;
const PROTOCOL_RELATIVE_URL_PATTERN = /(?:^|[^:])(\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}[^\s"'<>`)]*)/gi;
const BLOCKED_WIDGET_SOURCE_PATTERNS = [
  /<script\b/i,
  /\s+on[A-Za-z][\w:-]*\s*=/i,
  /\bjavascript\s*:/i,
  /\bfetch\s*\(/i,
  /\bXMLHttpRequest\b/i,
  /\bWebSocket\s*\(/i,
  /\bEventSource\s*\(/i,
  /\bnavigator\s*\.\s*sendBeacon\s*\(/i,
  /\b(?:window|self|globalThis)\s*\.\s*open\s*\(/i,
  /\bopen\s*\(/i,
  /\blocation\s*(?:=|\.|\[)/i,
  /\b(?:window|self|globalThis|document)\s*\.\s*location\b/i,
  /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh\b/i,
  /<a\b[^>]*\bhref\s*=/i,
  /<(?:base|embed|form|iframe|object)\b/i,
];

function assertSafeWidgetSource(path: string, content: string): void {
  if (typeof content !== "string") {
    throw new Error(`Invalid widget file content: ${path}`);
  }

  if (BLOCKED_WIDGET_SOURCE_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new Error(`Widget source cannot navigate or call external APIs: ${path}`);
  }

  for (const match of content.matchAll(EXTERNAL_URL_PATTERN)) {
    const url = stripUrlPunctuation(match[0]);
    if (!ALLOWED_STATIC_URLS.has(url)) {
      throw new Error(`Widget source cannot reference external URL: ${path}`);
    }
  }

  for (const match of content.matchAll(PROTOCOL_RELATIVE_URL_PATTERN)) {
    const url = stripUrlPunctuation(match[1] ?? "");
    if (url.length > 0) {
      throw new Error(`Widget source cannot reference protocol-relative URL: ${path}`);
    }
  }
}

function sanitizeWidgetSourceForIframe(content: string): string {
  return content
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "")
    .replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh\b[^>]*>/gi, "")
    .replace(/<\/?(?:base|embed|form|iframe|object)\b[^>]*>/gi, "")
    .replace(/\s+on[A-Za-z][\w:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /\s+(href|xlink:href|src|srcset|action|formaction)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
      (match: string, name: string, rawValue: string) => {
        const value = unquoteAttributeValue(rawValue).trim();
        if (name.toLowerCase() === "src" && /^(?:data|blob):/i.test(value)) {
          return match;
        }
        return "";
      },
    );
}

function unquoteAttributeValue(value: string): string {
  const first = value[0];
  const last = value.at(-1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function stripUrlPunctuation(url: string): string {
  return url.replace(/[),.;]+$/u, "");
}

export { WIDGET_CSP, WIDGET_IFRAME_SANDBOX, assertSafeWidgetSource, buildWidgetIframeDocument };
