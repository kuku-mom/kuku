import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";

import { readVaultFile } from "~/lib/vault_fs";
import type { SearchService } from "~/plugins/builtin/core_indexer/service";
import type {
  GraphLink,
  GraphNode,
  GraphState,
  GraphStoreLike,
} from "~/plugins/builtin/graph_view/graph_types";
import {
  flattenMarkdownFiles,
  type WikilinkSuggestItem,
} from "~/plugins/builtin/wikilink/wikilink_suggest";
import { vaultState } from "~/stores/vault";

interface VoxelGraphStoreConfig {
  service: SearchService;
  debounceMs?: number;
}

interface Resolver {
  resolve(source: WikilinkSuggestItem, rawTarget: string, mode: "wiki" | "markdown"): string | null;
}

interface DocumentMetrics {
  documentLength: number;
  wordCount: number;
  lineCount: number;
}

const DEFAULT_DEBOUNCE_MS = 300;
const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;
const MARKDOWN_LINK_RE = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const CONCURRENCY = 16;

const [getVoxelGraphStore, setVoxelGraphStore] = createSignal<GraphStoreLike | null>(null);

function stripMarkdownExtension(path: string): string {
  return path.replace(/\.(md|markdown)$/i, "");
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function normalizeVaultPath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function cleanWikilinkTarget(raw: string): string {
  return raw.split("|")[0].split("#")[0].trim();
}

function cleanMarkdownTarget(raw: string): string {
  const withoutHash = raw.split("#")[0].split("?")[0].trim();
  try {
    return decodeURIComponent(withoutHash);
  } catch {
    return withoutHash;
  }
}

function isExternalTarget(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

function folderAffinity(sourceFolder: string, candidatePath: string): number {
  const candidateFolder = dirname(candidatePath);
  if (candidateFolder === sourceFolder) return 1_000;
  const sourceParts = sourceFolder.split("/").filter(Boolean);
  const candidateParts = candidateFolder.split("/").filter(Boolean);
  let score = 0;
  for (let index = 0; index < Math.min(sourceParts.length, candidateParts.length); index++) {
    if (sourceParts[index] !== candidateParts[index]) break;
    score += 1;
  }
  return score;
}

function createResolver(files: readonly WikilinkSuggestItem[]): Resolver {
  const byPath = new Map<string, string>();
  const byPathWithoutExt = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  const byBasenameWithoutExt = new Map<string, string[]>();

  for (const file of files) {
    const lowerPath = file.path.toLowerCase();
    const lowerPathWithoutExt = stripMarkdownExtension(file.path).toLowerCase();
    const lowerBasename = basename(file.path).toLowerCase();
    const lowerBasenameWithoutExt = stripMarkdownExtension(basename(file.path)).toLowerCase();

    byPath.set(lowerPath, file.path);
    byPathWithoutExt.set(lowerPathWithoutExt, file.path);
    byBasename.set(lowerBasename, [...(byBasename.get(lowerBasename) ?? []), file.path]);
    byBasenameWithoutExt.set(lowerBasenameWithoutExt, [
      ...(byBasenameWithoutExt.get(lowerBasenameWithoutExt) ?? []),
      file.path,
    ]);
  }

  function bestCandidate(source: WikilinkSuggestItem, candidates: string[] | undefined) {
    if (!candidates || candidates.length === 0) return null;
    return [...candidates].sort(
      (left, right) =>
        folderAffinity(source.folder, right) - folderAffinity(source.folder, left) ||
        left.localeCompare(right),
    )[0];
  }

  return {
    resolve(source, rawTarget, mode) {
      const cleaned =
        mode === "wiki" ? cleanWikilinkTarget(rawTarget) : cleanMarkdownTarget(rawTarget);
      if (!cleaned || isExternalTarget(cleaned)) return null;

      const relativeTarget =
        mode === "markdown" && !cleaned.startsWith("/")
          ? normalizeVaultPath(source.folder ? `${source.folder}/${cleaned}` : cleaned)
          : normalizeVaultPath(cleaned.replace(/^\/+/, ""));
      if (!relativeTarget) return null;

      const exactPath = isMarkdownPath(relativeTarget) ? relativeTarget : `${relativeTarget}.md`;
      const lowerExactPath = exactPath.toLowerCase();
      const lowerWithoutExt = stripMarkdownExtension(relativeTarget).toLowerCase();

      return (
        byPath.get(lowerExactPath) ??
        byPathWithoutExt.get(lowerWithoutExt) ??
        bestCandidate(source, byBasename.get(basename(exactPath).toLowerCase())) ??
        bestCandidate(
          source,
          byBasenameWithoutExt.get(basename(stripMarkdownExtension(relativeTarget)).toLowerCase()),
        )
      );
    },
  };
}

function extractTargets(content: string): { target: string; mode: "wiki" | "markdown" }[] {
  const targets: { target: string; mode: "wiki" | "markdown" }[] = [];
  WIKILINK_RE.lastIndex = 0;
  MARKDOWN_LINK_RE.lastIndex = 0;

  for (let match = WIKILINK_RE.exec(content); match; match = WIKILINK_RE.exec(content)) {
    targets.push({ target: match[1], mode: "wiki" });
  }
  for (let match = MARKDOWN_LINK_RE.exec(content); match; match = MARKDOWN_LINK_RE.exec(content)) {
    targets.push({ target: match[1], mode: "markdown" });
  }
  return targets;
}

function documentMetricsFromContent(content: string): DocumentMetrics {
  const trimmed = content.trim();
  return {
    documentLength: content.length,
    wordCount: trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length,
    lineCount: content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length,
  };
}

async function readDocumentMetrics(
  paths: readonly string[],
): Promise<Map<string, DocumentMetrics>> {
  const metrics = new Map<string, DocumentMetrics>();
  await mapWithConcurrency(paths, CONCURRENCY, async (path) => {
    try {
      metrics.set(path, documentMetricsFromContent(await readVaultFile(path)));
    } catch {
      metrics.set(path, { documentLength: 0, wordCount: 0, lineCount: 0 });
    }
  });
  return metrics;
}

function applyDocumentMetrics<T extends GraphNode>(
  nodes: readonly T[],
  metrics: ReadonlyMap<string, DocumentMetrics>,
): T[] {
  return nodes.map((node) => {
    const metric = metrics.get(node.filePath);
    if (!metric) return node;
    return {
      ...node,
      documentLength: metric.documentLength,
      wordCount: metric.wordCount,
      lineCount: metric.lineCount,
    };
  });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function buildFallbackGraphState(): Promise<
  Pick<GraphState, "nodes" | "links" | "adjacencyMap" | "clusters">
> {
  const files = flattenMarkdownFiles(vaultState.files);
  const clusters = [...new Set(files.map((file) => file.folder || "Root"))].sort();
  const clusterIndexes = new Map(clusters.map((folder, index) => [folder, index]));
  const resolver = createResolver(files);
  const adjacencyMap: Record<string, string[]> = Object.fromEntries(
    files.map((file) => [file.path, []]),
  );
  const links: GraphLink[] = [];
  const linkKeys = new Set<string>();
  const metrics = new Map<string, DocumentMetrics>();

  await mapWithConcurrency(files, CONCURRENCY, async (file) => {
    let content = "";
    try {
      content = await readVaultFile(file.path);
    } catch {
      metrics.set(file.path, { documentLength: 0, wordCount: 0, lineCount: 0 });
      return;
    }
    metrics.set(file.path, documentMetricsFromContent(content));

    for (const { target, mode } of extractTargets(content)) {
      const resolved = resolver.resolve(file, target, mode);
      if (!resolved || resolved === file.path) continue;

      const key = `${file.path}\n${resolved}`;
      if (linkKeys.has(key)) continue;
      linkKeys.add(key);
      links.push({ source: file.path, target: resolved });
      adjacencyMap[file.path]?.push(resolved);
      adjacencyMap[resolved]?.push(file.path);
    }
  });

  for (const neighbours of Object.values(adjacencyMap)) {
    neighbours.sort();
  }
  links.sort(
    (left, right) =>
      left.source.localeCompare(right.source) || left.target.localeCompare(right.target),
  );

  const nodes: GraphNode[] = files.map((file) => {
    const folder = file.folder || "Root";
    const linkCount = adjacencyMap[file.path]?.length ?? 0;
    return {
      id: file.path,
      name: file.name,
      filePath: file.path,
      folder,
      clusterIndex: clusterIndexes.get(folder) ?? 0,
      linkCount,
      isOrphan: linkCount === 0,
      ...(metrics.get(file.path) ?? { documentLength: 0, wordCount: 0, lineCount: 0 }),
    };
  });

  return { nodes, links, adjacencyMap, clusters };
}

function createVoxelGraphStore(config: VoxelGraphStoreConfig): GraphStoreLike {
  const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const [state, setState] = createStore<GraphState>({
    nodes: [],
    links: [],
    adjacencyMap: {},
    clusters: [],
    isIndexing: false,
    lastIndexedAt: null,
    error: null,
  });

  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshInFlight = false;
  let rerunRequested = false;
  let disposed = false;
  let buildGeneration = 0;

  function isCurrentBuild(generation: number): boolean {
    return !disposed && generation === buildGeneration;
  }

  async function buildGraphData(): Promise<void> {
    if (disposed) return;
    if (refreshInFlight) {
      rerunRequested = true;
      return;
    }

    const generation = buildGeneration;
    refreshInFlight = true;
    setState("error", null);

    try {
      const [snapshot, status] = await Promise.all([
        config.service.getGraphSnapshot(),
        config.service.getStatus(),
      ]);
      const clusters = [...new Set(snapshot.nodes.map((node) => node.folder))].sort();
      const useFallback =
        snapshot.nodes.length === 0 && flattenMarkdownFiles(vaultState.files).length > 0;
      const graph = useFallback
        ? await buildFallbackGraphState()
        : {
            nodes: applyDocumentMetrics(
              snapshot.nodes,
              await readDocumentMetrics(snapshot.nodes.map((node) => node.filePath)),
            ),
            links: snapshot.links,
            adjacencyMap: snapshot.adjacencyMap,
            clusters,
          };

      if (!isCurrentBuild(generation)) return;
      setState(
        produce((s) => {
          s.nodes = graph.nodes;
          s.links = graph.links;
          s.adjacencyMap = graph.adjacencyMap;
          s.clusters = graph.clusters;
          s.isIndexing = status.state === "indexing";
          s.lastIndexedAt = status.lastIndexedAt;
          s.error = status.error ?? null;
        }),
      );

      if (status.state === "indexing" && isCurrentBuild(generation)) {
        scheduleRebuild(Math.max(debounceMs, 500));
      }
    } catch (error) {
      try {
        const graph = await buildFallbackGraphState();
        if (!isCurrentBuild(generation)) return;
        setState(
          produce((s) => {
            s.nodes = graph.nodes;
            s.links = graph.links;
            s.adjacencyMap = graph.adjacencyMap;
            s.clusters = graph.clusters;
            s.isIndexing = false;
            s.lastIndexedAt = null;
            s.error = null;
          }),
        );
      } catch {
        if (!isCurrentBuild(generation)) return;
        const message = error instanceof Error ? error.message : String(error);
        setState(
          produce((s) => {
            s.isIndexing = false;
            s.error = message;
          }),
        );
      }
    } finally {
      refreshInFlight = false;
      if (rerunRequested && !disposed) {
        rerunRequested = false;
        void buildGraphData();
      }
    }
  }

  function scheduleRebuild(delay = debounceMs): void {
    if (disposed) return;
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      void buildGraphData();
    }, delay);
  }

  function clear(): void {
    buildGeneration += 1;
    rerunRequested = false;
    if (rebuildTimer) {
      clearTimeout(rebuildTimer);
      rebuildTimer = null;
    }
    setState({
      nodes: [],
      links: [],
      adjacencyMap: {},
      clusters: [],
      isIndexing: false,
      lastIndexedAt: null,
      error: null,
    });
  }

  function dispose(): void {
    disposed = true;
    buildGeneration += 1;
    rerunRequested = false;
    if (rebuildTimer) {
      clearTimeout(rebuildTimer);
      rebuildTimer = null;
    }
  }

  return { state, buildGraphData, scheduleRebuild, clear, dispose };
}

export { createVoxelGraphStore, getVoxelGraphStore, setVoxelGraphStore };
