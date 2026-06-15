// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CodeBlockPreviewRenderContext } from "~/plugins/builtin/core_editor/code_block_preview_renderers";
import type { WidgetProject } from "./types";
import { widgetCodeBlockPreviewRenderer } from "./renderer";
import { WIDGET_IFRAME_DRAG_GUARD_ATTR } from "./widget_iframe_drag_guard";

const readWidgetProject = vi.hoisted(() => vi.fn());

vi.mock("./project_store", () => ({
  createWidgetProjectStore: () => ({
    read: readWidgetProject,
  }),
}));

describe("widget code block preview renderer", () => {
  beforeEach(() => {
    readWidgetProject.mockReset();
    document.body.innerHTML = "";
  });

  it("matches kuku-widget code fences", () => {
    expect(widgetCodeBlockPreviewRenderer.matches("kuku-widget")).toBe(true);
    expect(widgetCodeBlockPreviewRenderer.matches("KUKU-WIDGET")).toBe(true);
    expect(widgetCodeBlockPreviewRenderer.matches("mermaid")).toBe(false);
  });

  it("renders saved widgets from a kuku-widget code block", async () => {
    readWidgetProject.mockResolvedValue(createWidgetProject());
    const ctx = createRenderContext("id: seoul-clock\nheight: 360");

    await widgetCodeBlockPreviewRenderer.render(ctx);

    const iframe = ctx.previewBody.querySelector("iframe");
    expect(readWidgetProject).toHaveBeenCalledWith("seoul-clock");
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.style.height).toBe("360px");
    expect(iframe?.srcdoc).toContain("Seoul");
    expect(ctx.root.dataset.kukuWidgetCodeBlock).toBe("");
    expect(ctx.previewBody.dataset.kukuWidgetPreview).toBe("");
    expect(ctx.root.dataset.kukuCodeBlockPreviewOnly).toBe("");
  });

  it("updates the widget height from the resize handle", async () => {
    readWidgetProject.mockResolvedValue(createWidgetProject());
    const updateSource = vi.fn();
    const ctx = createRenderContext("id: seoul-clock\nheight: 360", updateSource);

    await widgetCodeBlockPreviewRenderer.render(ctx);

    ctx.previewBody
      .querySelector<HTMLElement>("[data-kuku-widget-resize-handle]")
      ?.dispatchEvent(createPointerEvent("pointerdown", 100));
    window.dispatchEvent(createPointerEvent("pointermove", 140));
    window.dispatchEvent(createPointerEvent("pointerup", 140));

    expect(updateSource).toHaveBeenCalledWith("id: seoul-clock\nheight: 400");
  });

  it("keeps the widget centered in the viewport while resizing", async () => {
    readWidgetProject.mockResolvedValue(createWidgetProject());
    const ctx = createRenderContext("id: seoul-clock\nheight: 360");
    const viewport = ctx.editorRoot.parentElement;
    if (!viewport) throw new Error("Missing test viewport");
    viewport.scrollTop = 200;

    await widgetCodeBlockPreviewRenderer.render(ctx);

    ctx.previewBody
      .querySelector<HTMLElement>("[data-kuku-widget-resize-handle]")
      ?.dispatchEvent(createPointerEvent("pointerdown", 100));
    window.dispatchEvent(createPointerEvent("pointermove", 140));

    expect(viewport.scrollTop).toBe(220);
  });

  it("keeps other widget iframes from interrupting resize drags", async () => {
    readWidgetProject.mockResolvedValue(createWidgetProject());
    const ctx = createRenderContext("id: seoul-clock\nheight: 360");
    const otherIframe = document.createElement("iframe");
    otherIframe.setAttribute(WIDGET_IFRAME_DRAG_GUARD_ATTR, "");
    ctx.editorRoot.append(otherIframe);

    await widgetCodeBlockPreviewRenderer.render(ctx);

    const iframe = ctx.previewBody.querySelector("iframe");
    ctx.previewBody
      .querySelector<HTMLElement>("[data-kuku-widget-resize-handle]")
      ?.dispatchEvent(createPointerEvent("pointerdown", 100));

    expect(iframe?.style.pointerEvents).toBe("none");
    expect(otherIframe.style.pointerEvents).toBe("none");

    window.dispatchEvent(createPointerEvent("pointerup", 120));

    expect(iframe?.style.pointerEvents).toBe("");
    expect(otherIframe.style.pointerEvents).toBe("");
  });

  it("expands when the iframe reports very tall responsive content", async () => {
    readWidgetProject.mockResolvedValue(createWidgetProject());
    const updateSource = vi.fn();
    const ctx = createRenderContext("id: seoul-clock\nheight: 360", updateSource);

    await widgetCodeBlockPreviewRenderer.render(ctx);

    const iframe = ctx.previewBody.querySelector("iframe");
    window.dispatchEvent(
      createMessageEvent({ type: "kuku-widget:resize", height: 50000 }, iframe?.contentWindow),
    );

    expect(iframe?.style.height).toBe("50000px");
    expect(updateSource).toHaveBeenCalledWith("id: seoul-clock\nheight: 50000");
  });
});

function createRenderContext(
  source: string,
  updateSource: CodeBlockPreviewRenderContext["updateSource"] = vi.fn(),
): CodeBlockPreviewRenderContext {
  const root = document.createElement("div");
  const editorRoot = document.createElement("div");
  const previewBody = document.createElement("div");
  const viewport = document.createElement("div");
  viewport.dataset.scrollAreaViewport = "";
  editorRoot.append(previewBody);
  viewport.append(editorRoot);
  document.body.append(viewport);
  return {
    root,
    editorRoot,
    previewBody,
    language: "kuku-widget",
    source,
    token: 1,
    preserveCurrent: false,
    isCurrent: () => true,
    lockHeight: () => null,
    updateSource,
  };
}

function createPointerEvent(type: string, clientY: number): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "clientY", { value: clientY });
  return event;
}

function createMessageEvent(data: unknown, source: Window | null | undefined): Event {
  const event = new Event("message");
  Object.defineProperty(event, "data", { value: data });
  Object.defineProperty(event, "source", { value: source ?? null });
  return event;
}

function createWidgetProject(): WidgetProject {
  return {
    id: "seoul-clock",
    name: "Seoul Clock",
    type: "html",
    entry: "index.html",
    files: [{ path: "index.html", content: "<main>Seoul</main>" }],
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
  };
}
