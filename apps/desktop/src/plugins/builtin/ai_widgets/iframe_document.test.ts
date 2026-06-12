import { describe, expect, it } from "vitest";

import {
  WIDGET_IFRAME_SANDBOX,
  buildWidgetIframeDocument,
} from "~/plugins/builtin/ai_widgets/iframe_document";
import type { WidgetProject } from "~/plugins/builtin/ai_widgets/types";

describe("widget iframe document", () => {
  it("uses a scriptless sandbox and embeds a restrictive CSP", () => {
    expect(WIDGET_IFRAME_SANDBOX).toBe("");

    const project: WidgetProject = {
      id: "daily-trends",
      name: "Daily Trends",
      type: "html",
      entry: "index.html",
      files: [{ path: "index.html", content: "<button>ok</button>" }],
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };

    const srcdoc = buildWidgetIframeDocument(project);

    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain("script-src 'none'");
    expect(srcdoc).toContain("<button>ok</button>");
    expect(srcdoc).not.toContain("allow-same-origin");
    expect(srcdoc).not.toContain("allow-scripts");
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

  it("rejects widget source that can navigate before rendering a preview", () => {
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

    expect(() => buildWidgetIframeDocument(project)).toThrow(
      "Widget source cannot navigate or call external APIs",
    );
  });
});
