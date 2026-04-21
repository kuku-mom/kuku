import { createEffect, onCleanup, onMount } from "solid-js";

import { PanelLeftIcon, PanelRightIcon } from "~/components/icons";
import PanelLayout from "~/components/layout/panel_layout";
import TitleBar from "~/components/layout/title_bar";
import UpdateIndicator from "~/components/layout/update_indicator";
import VaultBrowser from "~/components/vault/vault_browser";

import { FONT_SANS_FALLBACK, FONT_MONO_FALLBACK, buildFontFamily } from "~/lib/font_fallback";
import { installAccessibilitySuppression } from "~/lib/disable_accessibility";
import { bootstrapPlugins, destroyPlugins } from "~/plugins/bootstrap";
import { Slot } from "~/plugins/slots";
import { initSettings, settingsState } from "~/stores/settings";
import { initTheme } from "~/stores/theme";
import { destroyCloseHandler, initCloseHandler } from "~/stores/files";
import { closeVault, openVault, syncConfiguredVaultSelection, vaultState } from "~/stores/vault";
import {
  destroyWindowListeners,
  initWindowListeners,
  layoutState,
  toggleLeftPanel,
  toggleRightPanel,
} from "~/stores/layout";

// ── Styles ──

const ACTION_BTN =
  "flex size-[26px] cursor-pointer items-center justify-center rounded-xs border-none bg-transparent text-icon-muted transition-all duration-150 hover:bg-ghost-hover hover:text-icon active:bg-ghost-active [&>svg]:size-3.5";

// ── Component ──

export default function App() {
  initTheme();
  let cleanupAccessibilitySuppression: (() => void) | null = null;

  // Apply appearance settings reactively
  createEffect(() => {
    const { fontFamily } = settingsState.appearance;
    document.documentElement.style.setProperty(
      "--font-ui",
      buildFontFamily(fontFamily, FONT_SANS_FALLBACK),
    );
  });

  createEffect(() => {
    const { fontFamily, fontMono, fontSize, lineHeight, tabSize } = settingsState.editor;
    document.documentElement.style.setProperty(
      "--font-editor",
      buildFontFamily(fontFamily, FONT_SANS_FALLBACK),
    );
    document.documentElement.style.setProperty(
      "--font-mono",
      buildFontFamily(fontMono, FONT_MONO_FALLBACK),
    );
    document.documentElement.style.setProperty("--editor-font-size", `${fontSize / 16}rem`);
    document.documentElement.style.setProperty("--editor-tab-size", String(tabSize));
    // Indent scales with tab size, but clamps to a minimum wide enough for
    // three-digit ordered counters (`100. `). Smaller values let wide counters
    // overflow past the list's left edge because prosekit positions the
    // counter via `inset-inline-end: calc(100% - indent)` — counter text
    // wider than the indent gets pushed outside the <li>.
    document.documentElement.style.setProperty(
      "--editor-list-indent",
      `max(${tabSize * 0.5}em, 2.5em)`,
    );
    document.documentElement.style.setProperty("--editor-line-height", String(lineHeight));
    document.documentElement.style.setProperty("--editor-overflow-wrap", "break-word");
    document.documentElement.style.setProperty("--editor-white-space", "break-spaces");
    document.documentElement.style.setProperty("--editor-content-width", "100%");
    document.documentElement.style.setProperty("--editor-code-width", "100%");
    document.documentElement.style.setProperty("--editor-code-overflow-x", "auto");
    document.documentElement.style.setProperty("--scrollbar-size", "8px");
    document.documentElement.style.setProperty(
      "--native-scrollbar-size-thin",
      "var(--scrollbar-size, 8px)",
    );
    document.documentElement.style.setProperty(
      "--native-scrollbar-size-thick",
      "calc(var(--scrollbar-size, 8px) + 2px)",
    );
    document.documentElement.style.setProperty(
      "--native-scrollbar-size",
      "var(--native-scrollbar-size-thick)",
    );
    document.documentElement.style.setProperty(
      "--native-scrollbar-track",
      "color-mix(in srgb, var(--color-text-muted) 6%, transparent)",
    );
    document.documentElement.style.setProperty(
      "--native-scrollbar-thumb",
      "color-mix(in srgb, var(--color-text-muted) 28%, transparent)",
    );
    document.documentElement.style.setProperty(
      "--native-scrollbar-thumb-hover",
      "color-mix(in srgb, var(--color-text-muted) 42%, transparent)",
    );
    document.documentElement.style.setProperty(
      "--native-scrollbar-thumb-active",
      "color-mix(in srgb, var(--color-text-muted) 52%, transparent)",
    );
    document.documentElement.style.setProperty("--native-scrollbar-radius", "0px");
    document.documentElement.style.setProperty("--editor-table-width", "fit-content");
    document.documentElement.style.setProperty("--editor-table-max-width", "100%");
  });

  onMount(() => {
    void initializeApp();
    cleanupAccessibilitySuppression = installAccessibilitySuppression();
  });
  onCleanup(() => {
    cleanupAccessibilitySuppression?.();
    void closeVault();
    destroyPlugins();
    destroyCloseHandler();
    destroyWindowListeners();
  });

  async function initializeApp(): Promise<void> {
    try {
      await initSettings();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[Settings] Failed to initialize settings", error);
    }

    await bootstrapPlugins();
    initCloseHandler().catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[Window] Failed to register close handler", error);
    });
    initWindowListeners().catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[Window] Failed to register window listeners", error);
    });
    void restoreLastVault();
  }

  async function restoreLastVault(): Promise<void> {
    try {
      const lastVault = settingsState.lastOpenedVault;
      syncConfiguredVaultSelection(lastVault);
      if (lastVault) {
        await openVault(lastVault);
      }
    } catch {
      // Ignore restore errors and let the user open a vault manually.
    }
  }

  return (
    <div class="flex h-screen w-screen flex-col overflow-hidden">
      <TitleBar
        left={
          <>
            <button
              type="button"
              class={ACTION_BTN}
              classList={{ "text-text-secondary!": layoutState.leftPanelOpen }}
              onClick={toggleLeftPanel}
              title="Toggle Left Panel"
            >
              <PanelLeftIcon active={layoutState.leftPanelOpen} />
            </button>
            <UpdateIndicator />
          </>
        }
        center={<span class="text-xs text-text-muted">{vaultState.rootName ?? "Vault"}</span>}
        right={
          <button
            type="button"
            class={ACTION_BTN}
            classList={{ "text-text-secondary!": layoutState.rightPanelOpen }}
            onClick={toggleRightPanel}
            title="Toggle Right Panel"
          >
            <PanelRightIcon active={layoutState.rightPanelOpen} />
          </button>
        }
      />
      <PanelLayout
        left={<VaultBrowser />}
        bottom={<p class="p-3 text-xs text-text-muted">Bottom Panel</p>}
      />
      <div class="pointer-events-none fixed inset-0 z-50">
        <Slot name="overlay" />
      </div>
    </div>
  );
}
