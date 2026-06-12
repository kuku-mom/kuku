import type { WidgetProject } from "./types";

const WIDGET_IFRAME_SANDBOX = "allow-scripts";
const WIDGET_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
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
  const body = entry ? entry.content : "";

  if (project.type === "svg") {
    return completeHtmlDocument(`<main>${body}</main>`);
  }

  if (/<html[\s>]/i.test(body)) {
    if (/<head(\s[^>]*)?>/i.test(body)) {
      return body.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${headInjection()}`);
    }
    return body.replace(/<html(\s[^>]*)?>/i, (match) => `${match}<head>${headInjection()}</head>`);
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

export { WIDGET_CSP, WIDGET_IFRAME_SANDBOX, buildWidgetIframeDocument };
