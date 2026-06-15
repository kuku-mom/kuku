import type { WidgetProject } from "./types";

const WIDGET_IFRAME_SANDBOX = "allow-scripts";
const WIDGET_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "navigate-to 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");
const WIDGET_BASE_STYLE =
  'html,body{margin:0;width:100%;height:100%;min-height:100%;background:transparent;color:CanvasText;font:13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;scrollbar-width:none;-ms-overflow-style:none}[data-kuku-widget-root]{box-sizing:border-box;min-height:100%;width:100%}main{display:block}*{scrollbar-width:none;-ms-overflow-style:none}*::-webkit-scrollbar{display:none;width:0;height:0}';
const WIDGET_RUNTIME_GUARD =
  '(()=>{const kukuWidgetBlocked=()=>{throw new Error("kuku widget sandbox blocked external navigation or network access")};const lock=(target,name,value=kukuWidgetBlocked)=>{try{Object.defineProperty(target,name,{value,configurable:false,writable:false})}catch{}};lock(globalThis,"fetch");lock(globalThis,"XMLHttpRequest");lock(globalThis,"WebSocket");lock(globalThis,"EventSource");lock(globalThis,"open");try{lock(navigator,"sendBeacon")}catch{}try{lock(history,"pushState");lock(history,"replaceState")}catch{}try{const locationPrototype=Location.prototype;lock(locationPrototype,"assign");lock(locationPrototype,"replace");lock(locationPrototype,"reload")}catch{}try{document.addEventListener("click",(event)=>{const link=event.target?.closest?.("a[href]");if(link){event.preventDefault();event.stopImmediatePropagation();kukuWidgetBlocked()}},true);document.addEventListener("submit",(event)=>{event.preventDefault();event.stopImmediatePropagation();kukuWidgetBlocked()},true)}catch{}})();';
const WIDGET_AUTO_RESIZE =
  '(()=>{let last=0;const root=()=>[...document.body.children].find((element)=>!["SCRIPT","STYLE"].includes(element.tagName));const markRoot=()=>root()?.setAttribute("data-kuku-widget-root","");const measure=()=>{const body=document.body;const html=document.documentElement;const widgetRoot=root();const widgetRootRect=widgetRoot?.getBoundingClientRect?.();return Math.ceil(Math.max(body?.scrollHeight??0,body?.offsetHeight??0,html?.scrollHeight??0,html?.offsetHeight??0,widgetRoot?.scrollHeight??0,widgetRoot?.offsetHeight??0,widgetRootRect?.height??0,widgetRootRect?.bottom??0))};const post=()=>{const height=measure();if(height>0&&height!==last){last=height;parent.postMessage({type:"kuku-widget:resize",height},"*")}};const start=()=>{markRoot();post();requestAnimationFrame(()=>{markRoot();post()});try{const observer=new ResizeObserver(post);observer.observe(document.documentElement);if(document.body)observer.observe(document.body);const widgetRoot=root();if(widgetRoot)observer.observe(widgetRoot)}catch{setInterval(post,500)}};if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",start,{once:true})}else{start()}addEventListener("load",post)})();';
const WIDGET_FALLBACK_BODY =
  '<main data-kuku-widget-fallback="" style="box-sizing:border-box;display:grid;min-height:100%;place-items:center;padding:16px;color:#555;background:#fff;font:13px system-ui,-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,sans-serif">Widget unavailable</main>';

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
  return `${cspMeta()}<style>${WIDGET_BASE_STYLE}</style><script>${WIDGET_RUNTIME_GUARD}</script><script>${WIDGET_AUTO_RESIZE}</script>`;
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
  /<script\b[^>]*\bsrc\s*=/i,
  /\s+on[A-Za-z][\w:-]*\s*=/i,
  /\bjavascript\s*:/i,
  /\bfetch\s*\(/i,
  /\bXMLHttpRequest\b/i,
  /\bWebSocket\s*\(/i,
  /\bEventSource\s*\(/i,
  /\bimport\s*\(/i,
  /\beval\s*\(/i,
  /\bFunction\s*\(/i,
  /\bnew\s+Function\b/i,
  /\bset(?:Timeout|Interval)\s*\(\s*(?:"|'|`)/i,
  /\bnavigator\s*\.\s*sendBeacon\s*\(/i,
  /\b(?:window|self|globalThis)\s*\.\s*open\s*\(/i,
  /\b(?:top|parent)\s*\.\s*open\s*\(/i,
  /\b(?:window|self|globalThis|top|parent|document)\s*\[/i,
  /\bthis\s*\[/i,
  /\bopen\s*\(/i,
  /\blocation\s*(?:=|\.|\[)/i,
  /\b(?:window|self|globalThis|document|top|parent)\s*\.\s*location\b/i,
  /["']loc["']\s*\+\s*["']ation["']/i,
  /\bhistory\s*\.\s*(?:pushState|replaceState)\s*\(/i,
  /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh\b/i,
  /<a\b[^>]*\bhref\s*=/i,
  /<(?:base|embed|form|iframe|object)\b/i,
];

function assertSafeWidgetSource(path: string, content: string): void {
  const reason = unsafeWidgetSourceReason(path, content);
  if (reason) throw new Error(reason);
}

function sanitizeWidgetSourceForIframe(content: string): string {
  return unsafeWidgetSourceReason("widget preview", content) ? WIDGET_FALLBACK_BODY : content;
}

function unsafeWidgetSourceReason(path: string, content: string): string | null {
  if (typeof content !== "string") {
    return `Invalid widget file content: ${path}`;
  }

  if (BLOCKED_WIDGET_SOURCE_PATTERNS.some((pattern) => pattern.test(content))) {
    return `Widget source cannot navigate or call external APIs: ${path}`;
  }

  for (const match of content.matchAll(EXTERNAL_URL_PATTERN)) {
    const url = stripUrlPunctuation(match[0]);
    if (!ALLOWED_STATIC_URLS.has(url)) {
      return `Widget source cannot reference external URL: ${path}`;
    }
  }

  for (const match of content.matchAll(PROTOCOL_RELATIVE_URL_PATTERN)) {
    const url = stripUrlPunctuation(match[1] ?? "");
    if (url.length > 0) {
      return `Widget source cannot reference protocol-relative URL: ${path}`;
    }
  }

  return null;
}

function stripUrlPunctuation(url: string): string {
  return url.replace(/[),.;]+$/u, "");
}

export { WIDGET_CSP, WIDGET_IFRAME_SANDBOX, assertSafeWidgetSource, buildWidgetIframeDocument };
