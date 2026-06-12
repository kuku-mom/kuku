import { invoke } from "@tauri-apps/api/core";

import type {
  WidgetProject,
  WidgetProjectFile,
  WidgetProjectSummary,
  WidgetSaveInput,
  WidgetType,
} from "./types";

const AI_WIDGETS_PLUGIN_ID = "ai-widgets";
const PROJECTS_DIR = "projects";

interface WidgetProjectFs {
  readDir(path: string): Promise<string[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
}

interface WidgetProjectStoreOptions {
  now?: () => string;
  fs?: WidgetProjectFs;
}

interface WidgetProjectStore {
  save(input: WidgetSaveInput): Promise<WidgetProject>;
  list(): Promise<WidgetProjectSummary[]>;
  read(id: string): Promise<WidgetProject>;
}

function createWidgetProjectStore(options: WidgetProjectStoreOptions = {}): WidgetProjectStore {
  const fs = options.fs ?? createTauriWidgetProjectFs();
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async save(input) {
      const id = normalizeWidgetId(input.widgetId ?? input.name);
      const type = normalizeWidgetType(input.type);
      const files = normalizeFiles(input.files);
      const entry = input.entry ?? defaultEntryForType(type);
      assertSafeWidgetFilePath(entry);
      if (!files.some((file) => file.path === entry)) {
        throw new Error(`Widget entry file is missing: ${entry}`);
      }

      const timestamp = now();
      const previous = await readManifestIfExists(fs, id);
      const project: WidgetProject = {
        id,
        name: input.name.trim() || id,
        type,
        entry,
        files,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };

      await fs.writeText(manifestPath(id), JSON.stringify(toManifest(project), null, 2));
      await Promise.all(
        files.map((file) => fs.writeText(projectFilePath(id, file.path), file.content)),
      );
      return project;
    },

    async list() {
      let ids: string[];
      try {
        ids = await fs.readDir(PROJECTS_DIR);
      } catch {
        return [];
      }

      const summaries: WidgetProjectSummary[] = [];
      for (const id of ids) {
        try {
          assertSafeWidgetId(id);
          const manifest = await readManifest(fs, id);
          summaries.push({
            id: manifest.id,
            name: manifest.name,
            type: manifest.type,
            entry: manifest.entry,
            updatedAt: manifest.updatedAt,
          });
        } catch {
          // Ignore incomplete project folders; the next successful save repairs them.
        }
      }
      return sortedWidgetProjectSummaries(summaries);
    },

    async read(id) {
      assertSafeWidgetId(id);
      const manifest = await readManifest(fs, id);
      const files = await Promise.all(
        manifest.files.map(async (file) => ({
          path: file.path,
          content: await fs.readText(projectFilePath(id, file.path)),
        })),
      );
      return { ...manifest, files };
    },
  };
}

function createTauriWidgetProjectFs(): WidgetProjectFs {
  const primary = createVaultWidgetProjectFs();
  const legacy = createLegacyPluginWidgetProjectFs();
  return {
    async readDir(path) {
      const names = new Set<string>();
      for (const fs of [primary, legacy]) {
        try {
          for (const name of await fs.readDir(path)) names.add(name);
        } catch {
          // Missing storage roots are normal before the first widget is saved.
        }
      }
      return sortedStrings(names);
    },
    async readText(path) {
      try {
        return await primary.readText(path);
      } catch {
        return legacy.readText(path);
      }
    },
    writeText(path, content) {
      return primary.writeText(path, content);
    },
  };
}

function createVaultWidgetProjectFs(): WidgetProjectFs {
  return {
    readDir(path) {
      return invoke<string[]>("vault_plugin_fs_read_dir", { pluginId: AI_WIDGETS_PLUGIN_ID, path });
    },
    readText(path) {
      return invoke<string>("vault_plugin_fs_read_text", { pluginId: AI_WIDGETS_PLUGIN_ID, path });
    },
    writeText(path, content) {
      return invoke<void>("vault_plugin_fs_write_text", {
        pluginId: AI_WIDGETS_PLUGIN_ID,
        path,
        content,
      });
    },
  };
}

function createLegacyPluginWidgetProjectFs(): WidgetProjectFs {
  return {
    readDir(path) {
      return invoke<string[]>("plugin_fs_read_dir", { pluginId: AI_WIDGETS_PLUGIN_ID, path });
    },
    readText(path) {
      return invoke<string>("plugin_fs_read_text", { pluginId: AI_WIDGETS_PLUGIN_ID, path });
    },
    writeText(path, content) {
      return invoke<void>("plugin_fs_write_text", {
        pluginId: AI_WIDGETS_PLUGIN_ID,
        path,
        content,
      });
    },
  };
}

async function readManifestIfExists(
  fs: WidgetProjectFs,
  id: string,
): Promise<WidgetProject | null> {
  try {
    return await readManifest(fs, id);
  } catch {
    return null;
  }
}

async function readManifest(fs: WidgetProjectFs, id: string): Promise<WidgetProject> {
  const raw = await fs.readText(manifestPath(id));
  const parsed: unknown = JSON.parse(raw);
  if (!isWidgetProjectManifest(parsed)) {
    throw new Error(`Invalid widget manifest: ${id}`);
  }
  return parsed;
}

function toManifest(project: WidgetProject): WidgetProject {
  return {
    ...project,
    files: project.files.map((file) => ({ path: file.path, content: "" })),
  };
}

function normalizeFiles(files: WidgetProjectFile[]): WidgetProjectFile[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Widget requires at least one file");
  }

  const seen = new Set<string>();
  return files.map((file) => {
    assertSafeWidgetFilePath(file.path);
    if (seen.has(file.path)) {
      throw new Error(`Duplicate widget file path: ${file.path}`);
    }
    seen.add(file.path);
    return { path: file.path, content: file.content };
  });
}

function normalizeWidgetType(type: WidgetType): WidgetType {
  if (type !== "html" && type !== "svg") {
    throw new Error(`Unsupported widget type: ${String(type)}`);
  }
  return type;
}

function normalizeWidgetId(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  const id = slug || "widget";
  assertSafeWidgetId(id);
  return id;
}

function assertSafeWidgetId(id: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
    throw new Error(`Unsafe widget id: ${id}`);
  }
}

function assertSafeWidgetFilePath(path: string): void {
  const unsafe =
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\0") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
    !path.split("/").every((part) => /^[A-Za-z0-9._-]+$/.test(part));

  if (unsafe) {
    throw new Error(`Unsafe widget file path: ${path}`);
  }
}

function defaultEntryForType(type: WidgetType): string {
  return type === "svg" ? "widget.svg" : "index.html";
}

function manifestPath(id: string): string {
  return `${PROJECTS_DIR}/${id}/manifest.json`;
}

function projectFilePath(id: string, path: string): string {
  return `${PROJECTS_DIR}/${id}/files/${path}`;
}

function sortedWidgetProjectSummaries(summaries: WidgetProjectSummary[]): WidgetProjectSummary[] {
  return insertSorted(
    summaries,
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
  );
}

function sortedStrings(values: Iterable<string>): string[] {
  return insertSorted(values, (a, b) => a.localeCompare(b));
}

function insertSorted<T>(values: Iterable<T>, compare: (a: T, b: T) => number): T[] {
  const result: T[] = [];
  for (const value of values) {
    const index = result.findIndex((existing) => compare(value, existing) < 0);
    if (index === -1) {
      result.push(value);
    } else {
      result.splice(index, 0, value);
    }
  }
  return result;
}

function isWidgetProjectManifest(value: unknown): value is WidgetProject {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string") return false;
  if (typeof value.name !== "string") return false;
  if (value.type !== "html" && value.type !== "svg") return false;
  if (typeof value.entry !== "string") return false;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  if (!Array.isArray(value.files)) return false;
  return value.files.every(
    (file) => isRecord(file) && typeof file.path === "string" && typeof file.content === "string",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export {
  AI_WIDGETS_PLUGIN_ID,
  assertSafeWidgetFilePath,
  createWidgetProjectStore,
  defaultEntryForType,
  normalizeWidgetId,
};
export type { WidgetProjectFs, WidgetProjectStore, WidgetProjectStoreOptions };
