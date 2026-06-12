import type mermaid from "mermaid";
import type { MermaidConfig } from "mermaid";

import {
  normalizeCodeBlockLanguage,
  type CodeBlockPreviewEstimateContext,
  type CodeBlockPreviewRenderContext,
  type CodeBlockPreviewRenderer,
} from "~/plugins/builtin/core_editor/code_block_preview_renderers";

import {
  createMermaidRenderCacheKey,
  getCachedMermaidConfig,
  getCachedMermaidFontReady,
  hashStableValue,
  readCachedMermaidHeight,
  readCachedMermaidSvg,
  writeCachedMermaidSvg,
  writeCachedMermaidHeight,
  type MermaidRenderCacheKeyResult,
} from "./runtime_cache";
import { enqueueMermaidRenderJob, isMermaidRenderQueueClearedError } from "./render_queue";

type Mermaid = typeof mermaid;

const MERMAID_FONT_PRELOAD_SAMPLE_TEXT =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789가나다라마바사아자차카타파하한글테스트あいうえおアイウエオ日本語";
const MERMAID_RENDER_FALLBACK_WIDTH = 1280;
const MERMAID_RENDER_LAYOUT_FRAME_LIMIT = 4;
const MERMAID_RENDER_MIN_WIDTH = 1280;
const MERMAID_ESTIMATE_MIN_HEIGHT = 160;
const MERMAID_ESTIMATE_MAX_HEIGHT = 720;
const MERMAID_SVG_ID_REFERENCE_ATTRIBUTES = new Set(["aria-describedby", "aria-labelledby"]);

let mermaidLoader: Promise<Mermaid> | null = null;
let nextMermaidId = 0;
let nextMermaidSvgInstanceId = 0;

interface MermaidRenderedSvg {
  cacheKey: MermaidRenderCacheKeyResult;
  svg: string;
}

const mermaidCodeBlockPreviewRenderer: CodeBlockPreviewRenderer = {
  id: "mermaid",
  matches: (language) => {
    const normalized = normalizeCodeBlockLanguage(language);
    return normalized === "mermaid" || normalized === "mmd";
  },
  render: renderMermaidPreview,
  clear: clearMermaidPreviewState,
  deferThemeRefreshUntilVisible: true,
  estimateHeight: estimateMermaidPreviewHeight,
  getCacheSignature: getMermaidPreviewCacheSignature,
  preserveOnRefresh: true,
  preserveScrollAnchorOnRender: true,
  refreshOnThemeChange: true,
  reserveEstimatedHeight: true,
};

async function renderMermaidPreview(ctx: CodeBlockPreviewRenderContext): Promise<void> {
  const source = ctx.source.trim();
  const preserveCurrent =
    ctx.preserveCurrent && ctx.previewBody.dataset.kukuCodeBlockMermaidSvg !== undefined;
  const releaseHeightLock = preserveCurrent ? ctx.lockHeight() : null;

  if (!ctx.isCurrent()) {
    releaseHeightLock?.();
    return;
  }

  if (source) {
    const cachedResult = readCachedMermaidRenderResult(ctx, source);
    if (cachedResult) {
      applyMermaidRenderResult(ctx.previewBody, cachedResult);
      releaseHeightLock?.();
      return;
    }
  }

  if (!preserveCurrent) {
    clearMermaidPreviewState(ctx.previewBody);
    ctx.previewBody.dataset.kukuCodeBlockMermaidPlaceholder = "";
    ctx.previewBody.textContent = "";
  }

  if (!source) {
    if (!preserveCurrent) {
      ctx.previewBody.textContent = "Empty Mermaid diagram";
    }
    releaseHeightLock?.();
    return;
  }

  try {
    const result = await enqueueMermaidRenderJob({
      isCurrent: () => ctx.isCurrent(),
      run: () => renderMermaidSvg(ctx, source),
    });
    if (!ctx.isCurrent()) return;
    if (!result) return;

    applyMermaidRenderResult(ctx.previewBody, result);
  } catch (error: unknown) {
    if (isMermaidRenderQueueClearedError(error)) return;
    if (!ctx.isCurrent()) return;
    if (preserveCurrent && ctx.previewBody.dataset.kukuCodeBlockMermaidSvg !== undefined) {
      return;
    }
    ctx.previewBody.removeAttribute("data-kuku-code-block-mermaid-placeholder");
    delete ctx.previewBody.dataset.kukuCodeBlockMermaidSvg;
    ctx.previewBody.dataset.kukuCodeBlockMermaidError = "";
    ctx.previewBody.textContent =
      error instanceof Error ? error.message : "Unable to render diagram";
  } finally {
    releaseHeightLock?.();
  }
}

async function renderMermaidSvg(
  ctx: CodeBlockPreviewRenderContext,
  source: string,
): Promise<MermaidRenderedSvg | null> {
  let renderContainer: HTMLElement | null = null;
  try {
    const renderWidth = await waitForMermaidRenderWidth(ctx.previewBody, ctx.editorRoot);
    if (!ctx.isCurrent()) return null;

    const { cacheKey, config } = getMermaidRenderInputs(
      ctx.root,
      ctx.language,
      source,
      renderWidth,
    );
    const cachedSvg = readCachedMermaidSvg(cacheKey.key);
    if (cachedSvg !== null) {
      return {
        cacheKey,
        svg: cachedSvg,
      };
    }

    renderContainer = createMermaidRenderContainer(ctx.previewBody, renderWidth);
    const mermaid = await loadMermaid();
    await waitForMermaidFonts(ctx.root, source, config);
    if (!ctx.isCurrent()) return null;

    mermaid.initialize(config);
    const result = await mermaid.render(
      `kuku-editor-mermaid-${nextMermaidId++}`,
      source,
      renderContainer,
    );

    if (!ctx.isCurrent()) return null;
    writeCachedMermaidSvg(cacheKey.key, result.svg, cacheKey.parts.widthBucket);
    return {
      cacheKey,
      svg: result.svg,
    };
  } finally {
    renderContainer?.remove();
  }
}

function readCachedMermaidRenderResult(
  ctx: CodeBlockPreviewRenderContext,
  source: string,
): MermaidRenderedSvg | null {
  const measuredWidth = getMeasuredMermaidRenderWidth(ctx.previewBody, ctx.editorRoot);
  if (measuredWidth <= 0) return null;

  const renderWidth = Math.max(Math.ceil(measuredWidth), MERMAID_RENDER_MIN_WIDTH);
  const { cacheKey } = getMermaidRenderInputs(ctx.root, ctx.language, source, renderWidth);
  const cachedSvg = readCachedMermaidSvg(cacheKey.key);
  if (cachedSvg === null) return null;
  return {
    cacheKey,
    svg: cachedSvg,
  };
}

function applyMermaidRenderResult(previewBody: HTMLElement, result: MermaidRenderedSvg): void {
  previewBody.removeAttribute("data-kuku-code-block-mermaid-placeholder");
  delete previewBody.dataset.kukuCodeBlockMermaidError;
  previewBody.dataset.kukuCodeBlockMermaidSvg = "";
  previewBody.innerHTML = instantiateMermaidSvg(previewBody.ownerDocument, result.svg);
  rememberRenderedMermaidHeight(previewBody, result.cacheKey);
}

function instantiateMermaidSvg(doc: Document, svg: string): string {
  const template = doc.createElement("template");
  template.innerHTML = svg.trim();
  const svgElement = template.content.firstElementChild;
  if (!svgElement) return svg;

  const idPrefix = `kuku-mermaid-svg-${nextMermaidSvgInstanceId++}-`;
  const idMap = new Map<string, string>();
  const elements = [svgElement, ...svgElement.querySelectorAll("*")];
  for (const element of elements) {
    const id = element.getAttribute("id");
    if (!id || idMap.has(id)) continue;
    idMap.set(id, `${idPrefix}${id}`);
  }
  if (idMap.size === 0) return svg;

  for (const element of elements) {
    const id = element.getAttribute("id");
    if (id) {
      element.setAttribute("id", idMap.get(id) ?? id);
    }

    for (const attributeName of element.getAttributeNames()) {
      if (attributeName === "id") continue;
      const value = element.getAttribute(attributeName);
      if (value === null) continue;
      const nextValue = rewriteMermaidSvgReferenceValue(attributeName, value, idMap);
      if (nextValue !== value) {
        element.setAttribute(attributeName, nextValue);
      }
    }
  }

  for (const styleElement of svgElement.querySelectorAll("style")) {
    const text = styleElement.textContent;
    if (!text) continue;
    styleElement.textContent = rewriteMermaidSvgStyleText(text, idMap);
  }

  return svgElement.outerHTML;
}

function rewriteMermaidSvgReferenceValue(
  attributeName: string,
  value: string,
  idMap: Map<string, string>,
): string {
  let nextValue = value;
  if (MERMAID_SVG_ID_REFERENCE_ATTRIBUTES.has(attributeName)) {
    nextValue = nextValue
      .split(/(\s+)/)
      .map((part) => idMap.get(part) ?? part)
      .join("");
  }

  for (const [id, nextId] of idMap) {
    nextValue = rewriteMermaidSvgUrlReference(nextValue, id, nextId);
    if (nextValue === `#${id}`) {
      nextValue = `#${nextId}`;
    }
  }
  return nextValue;
}

function rewriteMermaidSvgStyleText(text: string, idMap: Map<string, string>): string {
  let nextText = text;
  for (const [id, nextId] of idMap) {
    nextText = rewriteMermaidSvgUrlReference(nextText, id, nextId);
    nextText = replaceDelimitedMermaidSvgHashReference(nextText, id, nextId);
  }
  return nextText;
}

function rewriteMermaidSvgUrlReference(value: string, id: string, nextId: string): string {
  return value.replace(
    new RegExp(`url\\(\\s*(['"]?)#${escapeRegExp(id)}\\1\\s*\\)`, "g"),
    `url(#${nextId})`,
  );
}

function replaceDelimitedMermaidSvgHashReference(
  value: string,
  id: string,
  nextId: string,
): string {
  return value.replace(
    new RegExp(`#${escapeRegExp(id)}(?=([\\s,.#:{>~+\\[\\)"';]|$))`, "g"),
    `#${nextId}`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function estimateMermaidPreviewHeight(ctx: CodeBlockPreviewEstimateContext): number | null {
  const source = ctx.source.trim();
  if (!source) return MERMAID_ESTIMATE_MIN_HEIGHT;

  const width = Math.max(ctx.width, MERMAID_RENDER_MIN_WIDTH);
  const { cacheKey } = getMermaidRenderInputs(ctx.root, ctx.language, source, width);
  const cachedHeight = readCachedMermaidHeight(cacheKey.key);
  if (cachedHeight !== null) return cachedHeight;

  return estimateMermaidHeightFromSource(source, cacheKey.parts.widthBucket);
}

function getMermaidPreviewCacheSignature(ctx: CodeBlockPreviewEstimateContext): string | null {
  const source = ctx.source.trim();
  if (!source) return null;

  const width = Math.max(ctx.width, MERMAID_RENDER_MIN_WIDTH);
  return getMermaidRenderInputs(ctx.root, ctx.language, source, width).cacheKey.key;
}

function clearMermaidPreviewState(previewBody: HTMLElement): void {
  delete previewBody.dataset.kukuCodeBlockMermaidSvg;
  delete previewBody.dataset.kukuCodeBlockMermaidError;
  delete previewBody.dataset.kukuCodeBlockMermaidPlaceholder;
}

function getMermaidRenderInputs(
  root: HTMLElement,
  language: string,
  source: string,
  width: number,
): {
  cacheKey: MermaidRenderCacheKeyResult;
  config: MermaidConfig;
} {
  const builtConfig = buildMermaidConfig(root);
  const configSignature = hashStableValue(builtConfig);
  const config = getCachedMermaidConfig(configSignature, () => builtConfig);
  const fontSignature = getMermaidFontSignature(config);
  const securitySignature = getMermaidSecuritySignature(config);
  const cacheKey = createMermaidRenderCacheKey({
    configSignature,
    fontSignature,
    language,
    securitySignature,
    source,
    width,
  });

  return { cacheKey, config };
}

function getMermaidFontSignature(config: MermaidConfig): string {
  return hashStableValue({
    fontFamily: config.fontFamily ?? "",
    fontSize: config.fontSize ?? "",
    themeFontFamily: config.themeVariables?.fontFamily ?? "",
    themeFontSize: config.themeVariables?.fontSize ?? "",
  });
}

function getMermaidSecuritySignature(config: MermaidConfig): string {
  return hashStableValue({
    securityLevel: config.securityLevel ?? "",
    startOnLoad: config.startOnLoad ?? "",
  });
}

function rememberRenderedMermaidHeight(
  previewBody: HTMLElement,
  cacheKey: MermaidRenderCacheKeyResult,
): void {
  const measuredHeight = Math.max(
    previewBody.offsetHeight,
    previewBody.getBoundingClientRect().height,
    previewBody.firstElementChild?.getBoundingClientRect().height ?? 0,
  );
  writeCachedMermaidHeight(cacheKey.key, measuredHeight, cacheKey.parts.widthBucket);
}

function estimateMermaidHeightFromSource(source: string, widthBucket: number): number {
  const lines = Math.max(1, source.split("\n").length);
  const firstLine = source
    .split("\n")
    .find((line) => line.trim())
    ?.trim()
    .toLowerCase();
  let multiplier = 1;

  if (firstLine?.startsWith("sequencediagram")) {
    multiplier = 1.3;
  } else if (
    firstLine?.startsWith("classdiagram") ||
    firstLine?.startsWith("statediagram") ||
    firstLine?.startsWith("erdiagram")
  ) {
    multiplier = 1.2;
  } else if (firstLine?.startsWith("gantt") || firstLine?.startsWith("journey")) {
    multiplier = 1.35;
  }

  if (widthBucket < 896) {
    multiplier *= 1.15;
  }

  return clampNumber(
    Math.round((140 + lines * 18) * multiplier),
    MERMAID_ESTIMATE_MIN_HEIGHT,
    MERMAID_ESTIMATE_MAX_HEIGHT,
  );
}

function buildMermaidConfig(root: HTMLElement): MermaidConfig {
  const readToken = createCssTokenReader(root);
  const darkMode = root.ownerDocument.documentElement.dataset.theme !== "light";
  const fontFamily = normalizeCssTokenValue(
    readToken(
      "--font-editor",
      '"Emoji", "Goorm Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    ),
  );
  const fontSize = readComputedPixelValue(root, "fontSize", 16);
  const stateFontSize = Math.max(16, Math.round(fontSize * 1.5));
  const stateLabelHeight = Math.ceil(stateFontSize * 0.7);
  const background = readToken("--color-mermaid-bg", "#1e1e1e");
  const surface = readToken("--color-mermaid-surface", "#262626");
  const surfaceAlt = readToken("--color-mermaid-surface-alt", "#303030");
  const border = readToken("--color-mermaid-border", "#5a5a5a");
  const borderStrong = readToken("--color-mermaid-border-strong", "#8a8a8a");
  const text = readToken("--color-mermaid-text", "#d4d4d4");
  const mutedText = readToken("--color-mermaid-text-muted", "#969696");
  const line = readToken("--color-mermaid-line", "#8a8a8a");
  const accent = readToken("--color-mermaid-accent", "#d4d4d4");
  const accentAlt = readToken("--color-mermaid-accent-alt", "#c0c0c0");
  const success = readToken("--color-mermaid-success", "#6bc46d");
  const warning = readToken("--color-mermaid-warning", "#e5a644");
  const danger = readToken("--color-mermaid-danger", "#e55561");
  const info = readToken("--color-mermaid-info", "#8a8a8a");
  const noteBackground = readToken("--color-mermaid-note-bg", surfaceAlt);
  const clusterBackground = readToken("--color-mermaid-cluster-bg", surface);
  const edgeLabelBackground = readToken("--color-mermaid-edge-label-bg", background);
  const sectionBackground = readToken("--color-mermaid-section-bg", surface);
  const taskBackground = readToken("--color-mermaid-task-bg", surfaceAlt);
  const taskDoneBackground = readToken("--color-mermaid-task-done-bg", success);
  const taskActiveBackground = readToken("--color-mermaid-task-active-bg", warning);
  const taskCriticalBackground = readToken("--color-mermaid-task-critical-bg", danger);
  const themeColorLimit = 12;
  const radius = parsePositiveCssNumber(readToken("--radius-sm", "2px"), 2);
  const strokeWidth = 1.5;
  const tagFontSize = `${Math.max(10, Math.round(fontSize * 0.625))}px`;
  const bodyFontSize = `${fontSize}px`;
  const pieTitleFontSize = `${Math.max(20, Math.round(fontSize * 1.5))}px`;
  const pieTextFontSize = `${Math.max(13, Math.round(fontSize))}px`;
  const journeyFills = [
    readToken("--color-mermaid-journey-fill-1", surfaceAlt),
    readToken("--color-mermaid-journey-fill-2", surface),
    readToken("--color-mermaid-journey-fill-3", taskDoneBackground),
    readToken("--color-mermaid-journey-fill-4", taskActiveBackground),
    readToken("--color-mermaid-journey-fill-5", taskCriticalBackground),
    readToken("--color-mermaid-journey-fill-6", noteBackground),
  ];
  const journeyActors = [success, warning, info, accentAlt, danger, mutedText];
  const scale = [
    readToken("--color-mermaid-scale-1", accent),
    readToken("--color-mermaid-scale-2", mutedText),
    readToken("--color-mermaid-scale-3", success),
    readToken("--color-mermaid-scale-4", warning),
    readToken("--color-mermaid-scale-5", danger),
    readToken("--color-mermaid-scale-6", info),
  ];
  const diagramScale = [
    readToken("--color-mermaid-diagram-scale-1", surfaceAlt),
    readToken("--color-mermaid-diagram-scale-2", darkMode ? "#3a3a3a" : "#d0d0d0"),
    readToken("--color-mermaid-diagram-scale-3", taskDoneBackground),
    readToken("--color-mermaid-diagram-scale-4", taskActiveBackground),
    readToken("--color-mermaid-diagram-scale-5", taskCriticalBackground),
    readToken("--color-mermaid-diagram-scale-6", noteBackground),
  ];
  const xyChartScale = darkMode
    ? scale
    : [
        readToken("--color-mermaid-xy-scale-1", "#b8b8b8"),
        readToken("--color-mermaid-xy-scale-2", "#6f6f6f"),
        readToken("--color-mermaid-xy-scale-3", "#9a9a9a"),
        readToken("--color-mermaid-xy-scale-4", "#c8c8c8"),
        readToken("--color-mermaid-xy-scale-5", "#858585"),
        readToken("--color-mermaid-xy-scale-6", "#adadad"),
      ];
  const diagramScaleContrast = repeatPalette([line], themeColorLimit);
  const diagramScalePeer = repeatPalette([borderStrong, border, line, accentAlt], themeColorLimit);
  const diagramScaleLabels = repeatPalette([text], themeColorLimit);
  const surfacePalette = [surface, surfaceAlt, clusterBackground, noteBackground, taskBackground];
  const surfacePeerPalette = [borderStrong, border, line, mutedText, accentAlt];
  const gitPalette = repeatPalette(
    [accent, success, warning, danger, info, accentAlt, mutedText, borderStrong],
    8,
  );
  const gitContrast = repeatPalette([background], 8);
  const branchLabelPalette = repeatPalette([darkMode ? background : edgeLabelBackground], 8);

  return {
    fontFamily,
    fontSize,
    journey: {
      actorColours: journeyActors,
      sectionColours: [text],
      sectionFills: journeyFills,
      taskFontFamily: fontFamily,
      taskFontSize: Math.max(12, Math.round(fontSize * 0.875)),
      titleColor: text,
      titleFontFamily: fontFamily,
      titleFontSize: `${Math.round(fontSize * 2)}px`,
    },
    securityLevel: "strict",
    startOnLoad: false,
    state: {
      fontSize: stateFontSize,
      fontSizeFactor: Math.max(5.02, fontSize * 0.9),
      labelHeight: stateLabelHeight,
      textHeight: Math.ceil(stateFontSize * 0.65),
    },
    theme: "base",
    themeVariables: {
      THEME_COLOR_LIMIT: themeColorLimit,
      activationBkgColor: surfaceAlt,
      activationBorderColor: borderStrong,
      actorBkg: surface,
      actorBorder: borderStrong,
      actorLineColor: line,
      actorTextColor: text,
      activeTaskBkgColor: taskActiveBackground,
      activeTaskBorderColor: warning,
      altBackground: surfaceAlt,
      altSectionBkgColor: surfaceAlt,
      archEdgeArrowColor: line,
      archEdgeColor: line,
      archEdgeWidth: "3",
      archGroupBorderColor: borderStrong,
      archGroupBorderWidth: "2px",
      arrowheadColor: line,
      attributeBackgroundColorEven: surface,
      attributeBackgroundColorOdd: surfaceAlt,
      background,
      border2: borderStrong,
      border1: border,
      branchLabelColor: darkMode ? background : edgeLabelBackground,
      cScale0: diagramScale[0],
      cScale1: diagramScale[1],
      cScale2: diagramScale[2],
      cScale3: diagramScale[3],
      cScale4: diagramScale[4],
      cScale5: diagramScale[5],
      cScale6: diagramScale[0],
      cScale7: diagramScale[1],
      cScale8: diagramScale[2],
      cScale9: diagramScale[3],
      cScale10: diagramScale[4],
      cScale11: diagramScale[5],
      ...buildIndexedThemeVariables("cScaleInv", diagramScaleContrast, themeColorLimit),
      ...buildIndexedThemeVariables("cScaleLabel", diagramScaleLabels, themeColorLimit),
      ...buildIndexedThemeVariables("cScalePeer", diagramScalePeer, themeColorLimit),
      classText: text,
      clusterBkg: clusterBackground,
      clusterBorder: border,
      commitLabelBackground: surfaceAlt,
      commitLabelColor: text,
      commitLabelFontSize: tagFontSize,
      compositeBackground: surface,
      compositeBorder: border,
      compositeTitleBackground: surfaceAlt,
      critBkgColor: taskCriticalBackground,
      critBorderColor: danger,
      cynefin: {
        arrowColor: line,
        arrowWidth: 2,
        boundaryColor: border,
        boundaryWidth: 2,
        chaoticBg: taskCriticalBackground,
        clearBg: taskActiveBackground,
        cliffColor: danger,
        cliffWidth: 4,
        complexBg: taskDoneBackground,
        complicatedBg: noteBackground,
        confusionBg: surfaceAlt,
        domainFontSize: Math.max(14, Math.round(fontSize)),
        itemFontSize: Math.max(11, Math.round(fontSize * 0.75)),
        labelColor: text,
        textColor: text,
      },
      darkTextColor: text,
      darkMode,
      defaultLinkColor: line,
      doneTaskBkgColor: taskDoneBackground,
      doneTaskBorderColor: success,
      dropShadow: "none",
      edgeLabelBackground,
      emArrowhead: line,
      emCommandFill: noteBackground,
      emCommandStroke: info,
      emEventFill: taskActiveBackground,
      emEventStroke: warning,
      emProcessorFill: taskCriticalBackground,
      emProcessorStroke: danger,
      emReadModelFill: taskDoneBackground,
      emReadModelStroke: success,
      emRelationStroke: line,
      emSwimlaneBackgroundOdd: surfaceAlt,
      emSwimlaneBackgroundStroke: border,
      emUiFill: surface,
      emUiStroke: border,
      errorBkgColor: taskCriticalBackground,
      errorTextColor: text,
      excludeBkgColor: surfaceAlt,
      fillType0: journeyFills[0],
      fillType1: journeyFills[1],
      fillType2: journeyFills[2],
      fillType3: journeyFills[3],
      fillType4: journeyFills[4],
      fillType5: journeyFills[5],
      fillType6: journeyFills[0],
      fillType7: journeyFills[1],
      fontFamily,
      fontSize: bodyFontSize,
      fontWeight: "400",
      git0: gitPalette[0],
      git1: gitPalette[1],
      git2: gitPalette[2],
      git3: gitPalette[3],
      git4: gitPalette[4],
      git5: gitPalette[5],
      git6: gitPalette[6],
      git7: gitPalette[7],
      ...buildIndexedThemeVariables("gitBranchLabel", branchLabelPalette, 8),
      ...buildIndexedThemeVariables("gitInv", gitContrast, 8),
      gradientStart: borderStrong,
      gradientStop: border,
      gridColor: border,
      innerEndBackground: surfaceAlt,
      labelColor: text,
      labelBackground: edgeLabelBackground,
      labelBackgroundColor: edgeLabelBackground,
      labelBoxBkgColor: surface,
      labelBoxBorderColor: border,
      labelTextColor: text,
      lineColor: line,
      loopTextColor: text,
      mainBkg: surface,
      nodeBkg: surface,
      nodeBorder: borderStrong,
      nodeTextColor: text,
      noteBkgColor: noteBackground,
      noteBorderColor: border,
      noteFontWeight: "400",
      noteTextColor: text,
      personBkg: surface,
      personBorder: borderStrong,
      pie1: scale[0],
      pie2: scale[1],
      pie3: scale[2],
      pie4: scale[3],
      pie5: scale[4],
      pie6: scale[5],
      pie7: scale[0],
      pie8: scale[1],
      pie9: scale[2],
      pie10: scale[3],
      pie11: scale[4],
      pie12: scale[5],
      pieLegendTextColor: text,
      pieLegendTextSize: pieTextFontSize,
      pieOuterStrokeColor: background,
      pieOuterStrokeWidth: "2px",
      pieOpacity: "0.9",
      pieSectionTextColor: background,
      pieSectionTextSize: pieTextFontSize,
      pieStrokeColor: background,
      pieStrokeWidth: "2px",
      pieTitleTextColor: text,
      pieTitleTextSize: pieTitleFontSize,
      primaryBorderColor: borderStrong,
      primaryColor: surface,
      primaryTextColor: text,
      quadrant1Fill: surface,
      quadrant1TextFill: text,
      quadrant2Fill: surfaceAlt,
      quadrant2TextFill: text,
      quadrant3Fill: surface,
      quadrant3TextFill: text,
      quadrant4Fill: surfaceAlt,
      quadrant4TextFill: text,
      quadrantExternalBorderStrokeFill: border,
      quadrantInternalBorderStrokeFill: border,
      quadrantPointFill: accent,
      quadrantPointTextFill: text,
      quadrantTitleFill: text,
      quadrantXAxisTextFill: mutedText,
      quadrantYAxisTextFill: mutedText,
      relationColor: line,
      relationLabelBackground: edgeLabelBackground,
      relationLabelColor: text,
      radar: {
        axisColor: line,
        axisLabelFontSize: Math.max(11, Math.round(fontSize * 0.75)),
        axisStrokeWidth: 2,
        curveOpacity: 0.55,
        curveStrokeWidth: 2,
        graticuleColor: border,
        graticuleOpacity: 0.35,
        graticuleStrokeWidth: 1,
        legendBoxSize: Math.max(10, Math.round(fontSize * 0.75)),
        legendFontSize: Math.max(11, Math.round(fontSize * 0.75)),
      },
      radius,
      rectBkgColor: surfaceAlt,
      requirementBackground: surface,
      requirementBorderColor: border,
      requirementBorderSize: "1",
      requirementTextColor: text,
      rowEven: surface,
      rowOdd: surfaceAlt,
      scaleLabelColor: text,
      secondaryBorderColor: border,
      secondaryColor: surfaceAlt,
      secondaryTextColor: text,
      sectionBkgColor: sectionBackground,
      sectionBkgColor2: surfaceAlt,
      sequenceNumberColor: background,
      secondBkg: surfaceAlt,
      signalColor: line,
      signalTextColor: text,
      specialStateColor: warning,
      stateBkg: surface,
      stateLabelColor: text,
      strokeWidth,
      ...buildIndexedThemeVariables("surface", surfacePalette, surfacePalette.length),
      ...buildIndexedThemeVariables("surfacePeer", surfacePeerPalette, surfacePeerPalette.length),
      tagLabelBackground: surfaceAlt,
      tagLabelBorder: accentAlt,
      tagLabelColor: text,
      tagLabelFontSize: tagFontSize,
      taskBkgColor: taskBackground,
      taskBorderColor: border,
      taskTextClickableColor: accentAlt,
      taskTextColor: text,
      taskTextDarkColor: text,
      taskTextLightColor: background,
      taskTextOutsideColor: text,
      tertiaryBorderColor: border,
      tertiaryColor: background,
      tertiaryTextColor: text,
      textColor: text,
      titleColor: text,
      todayLineColor: danger,
      transitionColor: line,
      transitionLabelColor: text,
      useGradient: false,
      venn1: scale[0],
      venn2: scale[1],
      venn3: scale[2],
      venn4: scale[3],
      venn5: scale[4],
      venn6: scale[5],
      venn7: scale[0],
      venn8: scale[1],
      vennSetTextColor: text,
      vennTitleTextColor: text,
      vertLineColor: border,
      wardley: {
        annotationFill: surface,
        annotationStroke: border,
        annotationTextColor: text,
        axisColor: line,
        axisTextColor: text,
        backgroundColor: background,
        componentFill: surface,
        componentLabelColor: text,
        componentStroke: borderStrong,
        evolutionStroke: danger,
        gridColor: border,
        linkStroke: line,
      },
      wardleyEvolutionColor: danger,
      xyChart: {
        backgroundColor: background,
        dataLabelColor: text,
        plotColorPalette: xyChartScale.join(","),
        titleColor: text,
        xAxisLabelColor: mutedText,
        xAxisLineColor: border,
        xAxisTickColor: border,
        xAxisTitleColor: text,
        yAxisLabelColor: mutedText,
        yAxisLineColor: border,
        yAxisTickColor: border,
        yAxisTitleColor: text,
      },
    },
  };
}

function createCssTokenReader(root: HTMLElement): (name: string, fallback: string) => string {
  const style = root.ownerDocument.defaultView?.getComputedStyle(
    root.ownerDocument.documentElement,
  );
  return (name, fallback) => style?.getPropertyValue(name).trim() || fallback;
}

function normalizeCssTokenValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parsePositiveCssNumber(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function repeatPalette(values: string[], count: number): string[] {
  return Array.from({ length: count }, (_, index) => values[index % values.length] ?? "");
}

function buildIndexedThemeVariables(
  prefix: string,
  values: string[],
  count: number,
): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [prefix + index, values[index] ?? ""]),
  );
}

function createMermaidRenderContainer(previewBody: HTMLElement, width: number): HTMLElement {
  const container = previewBody.ownerDocument.createElement("div");
  container.dataset.kukuCodeBlockMermaidRenderContainer = "";
  container.style.position = "absolute";
  container.style.left = "0";
  container.style.top = "0";
  container.style.width = `${width}px`;
  container.style.height = "1px";
  container.style.overflow = "visible";
  container.style.opacity = "0";
  container.style.pointerEvents = "none";
  previewBody.append(container);
  return container;
}

async function waitForMermaidRenderWidth(
  previewBody: HTMLElement,
  fallbackRoot: HTMLElement,
): Promise<number> {
  const win = previewBody.ownerDocument.defaultView ?? window;
  for (let attempt = 0; attempt < MERMAID_RENDER_LAYOUT_FRAME_LIMIT; attempt += 1) {
    const measuredWidth = getMeasuredMermaidRenderWidth(previewBody, fallbackRoot);
    if (measuredWidth > 0) {
      return Math.max(Math.ceil(measuredWidth), MERMAID_RENDER_MIN_WIDTH);
    }
    await new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));
  }

  return MERMAID_RENDER_FALLBACK_WIDTH;
}

function getMeasuredMermaidRenderWidth(
  previewBody: HTMLElement,
  fallbackRoot: HTMLElement,
): number {
  const codeBlock = previewBody.closest<HTMLElement>("[data-kuku-code-block]");
  return Math.max(
    previewBody.clientWidth,
    previewBody.getBoundingClientRect().width,
    previewBody.parentElement?.clientWidth ?? 0,
    codeBlock?.clientWidth ?? 0,
    fallbackRoot.clientWidth,
    fallbackRoot.getBoundingClientRect().width,
  );
}

function readComputedPixelValue(
  root: HTMLElement,
  propertyName: "fontSize",
  fallback: number,
): number {
  const style = root.ownerDocument.defaultView?.getComputedStyle(root);
  const rawValue = style?.[propertyName] ?? "";
  const value = Number.parseFloat(rawValue);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function waitForMermaidFonts(
  root: HTMLElement,
  source: string,
  config: MermaidConfig,
): Promise<void> {
  const fonts = root.ownerDocument.fonts;
  const fontFamily = normalizeCssTokenValue(config.fontFamily ?? "");
  if (!fonts || !fontFamily) return;

  const fontSize =
    typeof config.fontSize === "number" && config.fontSize > 0 ? config.fontSize : 16;
  const sample = `${source.slice(0, 512)} ${MERMAID_FONT_PRELOAD_SAMPLE_TEXT}`;
  const loadSpecs = [
    `${fontSize}px ${fontFamily}`,
    `500 ${fontSize}px ${fontFamily}`,
    `700 ${fontSize}px ${fontFamily}`,
  ];

  await getCachedMermaidFontReady(root.ownerDocument, getMermaidFontSignature(config), async () => {
    await Promise.allSettled(loadSpecs.map((spec) => loadFontFace(fonts, spec, sample)));
    await fonts.ready.catch(() => undefined);
    await waitForNextAnimationFrame(root.ownerDocument);
  });
}

function loadFontFace(fonts: FontFaceSet, spec: string, sample: string): Promise<FontFace[]> {
  try {
    return fonts.load(spec, sample);
  } catch {
    return Promise.resolve([]);
  }
}

function waitForNextAnimationFrame(doc: Document): Promise<void> {
  return new Promise((resolve) => {
    const win = doc.defaultView;
    if (!win) {
      resolve();
      return;
    }
    win.requestAnimationFrame(() => resolve());
  });
}

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize(buildMermaidConfig(document.documentElement));
      return mermaid;
    });
  }
  return mermaidLoader;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export { mermaidCodeBlockPreviewRenderer };
