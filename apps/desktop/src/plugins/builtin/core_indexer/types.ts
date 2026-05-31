export interface IndexerStatus {
  state: "idle" | "indexing" | "error";
  totalDocs: number;
  indexedDocs: number;
  lastIndexedAt: number | null;
  resolvedLinks: number;
  unresolvedLinks: number;
  ambiguousLinks: number;
  error: string | null;
}

export interface IndexerDebugStatus {
  runtimeActive: boolean;
  dbPath: string | null;
  lastJobKind: string | null;
  lastJobPath: string | null;
  lastJobSource: string | null;
  lastRebuildReason: string | null;
  queuedRebuildReason: string | null;
  coalescedRebuildCount: number;
  coalescedIndexCount: number;
  rebuildQueued: boolean;
  rebuildRunning: boolean;
  rebuildRerun: boolean;
  lastWatcherEventKind: string | null;
  lastWatcherEventPath: string | null;
  lastWatcherEventSource: string | null;
  lastWatcherEventSkipped: boolean | null;
  lastWatcherEventAt: number | null;
}

export interface SimpleSearchHit {
  docId: string;
  title: string | null;
  sectionPath: string[];
  sectionOrdinal: number;
  snippet: string;
  kind: string;
  score: number;
}

export interface SimpleSearchResult {
  query: string;
  total: number;
  items: SimpleSearchHit[];
}

export interface AdvancedQueryRequest {
  query: string;
  caseSensitive: boolean;
  maxResults?: number;
}

export type IndexerStorageLocation = "app-global" | "vault-local";

export interface IndexerConfig {
  storageLocation: IndexerStorageLocation;
  incrementalUpdates: boolean;
  reindexOnVaultOpen: boolean;
  // Internal/fixed for now; keep closest-folder as the backend compatibility contract.
  resolutionPolicy: "closest-folder";
}

export interface GraphNodeSnapshot {
  id: string;
  name: string;
  filePath: string;
  folder: string;
  clusterIndex: number;
  linkCount: number;
  isOrphan: boolean;
  documentLength?: number;
  wordCount?: number;
  lineCount?: number;
}

export interface GraphLinkSnapshot {
  source: string;
  target: string;
}

export interface GraphSnapshot {
  nodes: GraphNodeSnapshot[];
  links: GraphLinkSnapshot[];
  adjacencyMap: Record<string, string[]>;
  unresolvedCount: number;
  ambiguousCount: number;
}

export interface ResolveWikilinkResult {
  resolvedPath: string | null;
  resolutionKind: "exact" | "basename" | "ambiguous" | "unresolved";
}
