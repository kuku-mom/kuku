import { describe, expect, it } from "vitest";

import {
  WIDGET_IFRAME_SANDBOX,
  buildWidgetIframeDocument,
} from "~/plugins/builtin/ai_widgets/iframe_document";
import type { WidgetProject } from "~/plugins/builtin/ai_widgets/types";

describe("widget iframe document", () => {
  it("uses an opaque script sandbox and embeds a restrictive CSP", () => {
    expect(WIDGET_IFRAME_SANDBOX).toBe("allow-scripts");

    const project: WidgetProject = {
      id: "daily-trends",
      name: "Daily Trends",
      type: "html",
      entry: "index.html",
      files: [
        {
          path: "index.html",
          content:
            '<button id="ok">ok</button><script>document.getElementById("ok")?.setAttribute("data-ready","1")</script>',
        },
      ],
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };

    const srcdoc = buildWidgetIframeDocument(project);

    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain("frame-src 'none'");
    expect(srcdoc).toContain("navigate-to 'none'");
    expect(srcdoc).toContain("script-src 'unsafe-inline'");
    expect(srcdoc).toContain('<button id="ok">ok</button>');
    expect(srcdoc).toContain("data-ready");
    expect(srcdoc.indexOf("kukuWidgetBlocked")).toBeLessThan(srcdoc.indexOf("<button"));
    expect(srcdoc).toContain("Location.prototype");
    expect(srcdoc).not.toContain("allow-same-origin");
    expect(srcdoc).not.toContain("allow-top-navigation");
  });

  it("wraps svg widgets in a complete html document", () => {
    const project: WidgetProject = {
      id: "sparkline",
      name: "Sparkline",
      type: "svg",
      entry: "widget.svg",
      files: [{ path: "widget.svg", content: '<svg><path d="M0 0L10 10" /></svg>' }],
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };

    expect(buildWidgetIframeDocument(project)).toContain("<main><svg>");
  });

  it("hides widget scrollbars in generated iframe documents", () => {
    const project: WidgetProject = {
      id: "long-widget",
      name: "Long Widget",
      type: "html",
      entry: "index.html",
      files: [{ path: "index.html", content: "<div style='height:2000px'>Tall</div>" }],
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };

    const srcdoc = buildWidgetIframeDocument(project);

    expect(srcdoc).toContain("scrollbar-width:none");
    expect(srcdoc).toContain("::-webkit-scrollbar{display:none");
  });

  it("reports intrinsic content height for responsive embedding", () => {
    const project: WidgetProject = {
      id: "responsive-widget",
      name: "Responsive Widget",
      type: "html",
      entry: "index.html",
      files: [{ path: "index.html", content: "<main>Responsive</main>" }],
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };

    const srcdoc = buildWidgetIframeDocument(project);

    expect(srcdoc).toContain("kuku-widget:resize");
    expect(srcdoc).toContain("ResizeObserver");
    expect(srcdoc).toContain("postMessage");
    expect(srcdoc).toContain("widgetRoot?.scrollHeight");
    expect(srcdoc).toContain("getBoundingClientRect");
    expect(srcdoc).not.toContain("body?.scrollHeight");
    expect(srcdoc).not.toContain("html?.scrollHeight");
    expect(srcdoc).not.toContain("widgetRootRect?.bottom");
  });

  it("marks the widget root so it fills the rendered viewport", () => {
    const project: WidgetProject = {
      id: "fill-widget",
      name: "Fill Widget",
      type: "html",
      entry: "index.html",
      files: [{ path: "index.html", content: "<main>Fill</main>" }],
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };

    const srcdoc = buildWidgetIframeDocument(project);

    expect(srcdoc).toContain("[data-kuku-widget-root]");
    expect(srcdoc).toContain("data-kuku-widget-root");
    expect(srcdoc).toContain("height:100%");
    expect(srcdoc).toContain("width:100%");
    expect(srcdoc).toContain("overflow:hidden");
    expect(srcdoc).toContain("display:flex");
    expect(srcdoc).toContain("justify-content:center");
  });

  it("injects csp even when a full html widget omits head", () => {
    const project: WidgetProject = {
      id: "headless",
      name: "Headless",
      type: "html",
      entry: "index.html",
      files: [{ path: "index.html", content: "<html><body>ok</body></html>" }],
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };

    expect(buildWidgetIframeDocument(project)).toContain("Content-Security-Policy");
  });

  it("places the CSP before untrusted full-html source that contains a fake head tag", () => {
    const project: WidgetProject = {
      id: "fake-head",
      name: "Fake Head",
      type: "html",
      entry: "index.html",
      files: [
        {
          path: "index.html",
          content: "<!-- <head> --><html><body><p>ready</p></body></html>",
        },
      ],
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };

    const srcdoc = buildWidgetIframeDocument(project);

    expect(srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(srcdoc.indexOf("<!-- <head>"));
  });

  it("uses a safe fallback for unsafe legacy widget source during preview rendering", () => {
    const project: WidgetProject = {
      id: "unsafe",
      name: "Unsafe",
      type: "html",
      entry: "index.html",
      files: [
        {
          path: "index.html",
          content:
            "<script>globalThis['loc' + 'ation']['href'] = String.fromCharCode(104,116,116,112,115)</script>",
        },
      ],
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };

    const srcdoc = buildWidgetIframeDocument(project);

    expect(srcdoc).toContain("Content-Security-Policy");
    expect(srcdoc).toContain("data-kuku-widget-fallback");
    expect(srcdoc).not.toContain("loc' + 'ation");
  });

  it("uses a safe fallback for computed global navigation source", () => {
    const project: WidgetProject = {
      id: "computed-navigation",
      name: "Computed Navigation",
      type: "html",
      entry: "index.html",
      files: [
        {
          path: "index.html",
          content:
            "<script>globalThis[String.fromCharCode(108,111,99,97,116,105,111,110)].href = String.fromCharCode(104,116,116,112,115,58,47,47,101,120,97,109,112,108,101,46,99,111,109)</script>",
        },
      ],
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };

    const srcdoc = buildWidgetIframeDocument(project);

    expect(srcdoc).toContain("data-kuku-widget-fallback");
    expect(srcdoc).not.toContain("String.fromCharCode(108");
  });
});
