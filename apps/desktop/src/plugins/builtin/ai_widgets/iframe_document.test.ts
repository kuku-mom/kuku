import { describe, expect, it } from "vitest";

import {
  WIDGET_IFRAME_SANDBOX,
  buildWidgetIframeDocument,
} from "~/plugins/builtin/ai_widgets/iframe_document";
import type { WidgetProject } from "~/plugins/builtin/ai_widgets/types";

describe("widget iframe document", () => {
  it("uses scripts without same-origin and embeds a restrictive CSP", () => {
    expect(WIDGET_IFRAME_SANDBOX).toBe("allow-scripts");

    const project: WidgetProject = {
      id: "daily-trends",
      name: "Daily Trends",
      type: "html",
      entry: "index.html",
      files: [{ path: "index.html", content: "<script>document.body.textContent = 'ok'</script>" }],
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };

    const srcdoc = buildWidgetIframeDocument(project);

    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain("script-src 'unsafe-inline'");
    expect(srcdoc).toContain("<script>document.body.textContent = 'ok'</script>");
    expect(srcdoc).not.toContain("allow-same-origin");
  });

  it("wraps svg widgets in a complete html document", () => {
    const project: WidgetProject = {
      id: "sparkline",
      name: "Sparkline",
      type: "svg",
      entry: "widget.svg",
      files: [{ path: "widget.svg", content: "<svg><path d=\"M0 0L10 10\" /></svg>" }],
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    };

    expect(buildWidgetIframeDocument(project)).toContain("<main><svg>");
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
});
