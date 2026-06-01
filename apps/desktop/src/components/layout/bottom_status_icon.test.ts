import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readSource(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), "utf8");
}

describe("bottom-right status icon", () => {
  it("renders sync status as a single overlay icon without a bottom bar", () => {
    const appSource = readSource("app.tsx");
    const syncPluginSource = readSource("plugins/builtin/core_sync/index.ts");

    expect(appSource).not.toContain('import StatusBar from "~/components/layout/status_bar";');
    expect(appSource).not.toContain("<StatusBar />");
    expect(appSource).not.toContain("<UpdateIndicator />");
    expect(appSource).toContain('<Slot name="overlay" />');

    expect(syncPluginSource).toContain('location: { slot: "overlay" }');
    expect(syncPluginSource).not.toContain("statusBar:");
    expect(syncPluginSource).not.toContain('location: { slot: "titleBarRightAction" }');
  });

  it("uses a compact sync icon with a bottom-right popover for other statuses", () => {
    const syncIndicatorSource = readSource("plugins/builtin/core_sync/sync_status_indicator.tsx");

    expect(syncIndicatorSource).toContain("pointer-events-auto fixed right-2 bottom-2");
    expect(syncIndicatorSource).toContain('data-kuku-sync-status-icon="true"');
    expect(syncIndicatorSource).toContain('data-kuku-sync-status-popover="true"');
    expect(syncIndicatorSource).toContain('data-kuku-status-popover-update="true"');
    expect(syncIndicatorSource).toContain("updaterState.status");
    expect(syncIndicatorSource).toContain("bottom-7");
    expect(syncIndicatorSource).toContain("right-0");
    expect(syncIndicatorSource).not.toContain("min-w-0 truncate");
  });
});
