import { createEffect, onCleanup, onMount } from "solid-js";

import { PanelLeftIcon, PanelRightIcon } from "~/components/icons";
import PanelLayout from "~/components/layout/panel_layout";
import TitleBar from "~/components/layout/title_bar";
import VaultBrowser from "~/components/vault/vault_browser";

import { initFonts } from "~/lib/fonts";
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

  // Apply appearance settings reactively
  createEffect(() => {
    const { fontFamily } = settingsState.appearance;
    document.documentElement.style.setProperty("--font-ui", `"Emoji", "${fontFamily}"`);
  });

  createEffect(() => {
    const { fontFamily, fontMono, fontSize, lineHeight, wordWrap, tabSize } = settingsState.editor;
    document.documentElement.style.setProperty("--font-editor", `"Emoji", "${fontFamily}"`);
    document.documentElement.style.setProperty("--font-mono", `"Emoji", "${fontMono}"`);
    document.documentElement.style.setProperty("--editor-font-size", `${fontSize / 16}rem`);
    document.documentElement.style.setProperty("--editor-tab-size", String(tabSize));
    document.documentElement.style.setProperty("--editor-list-indent", `${tabSize * 0.5}em`);
    document.documentElement.style.setProperty("--editor-line-height", String(lineHeight));
    document.documentElement.style.setProperty(
      "--editor-overflow-wrap",
      wordWrap ? "break-word" : "normal",
    );
    document.documentElement.style.setProperty(
      "--editor-white-space",
      wordWrap ? "break-spaces" : "pre",
    );
    document.documentElement.style.setProperty(
      "--editor-content-width",
      wordWrap ? "100%" : "max-content",
    );
    document.documentElement.style.setProperty(
      "--editor-code-width",
      wordWrap ? "100%" : "fit-content",
    );
    document.documentElement.style.setProperty(
      "--editor-code-overflow-x",
      wordWrap ? "auto" : "visible",
    );
    document.documentElement.style.setProperty(
      "--editor-table-width",
      wordWrap ? "fit-content" : "max-content",
    );
    document.documentElement.style.setProperty(
      "--editor-table-max-width",
      wordWrap ? "100%" : "none",
    );
  });

  onMount(() => {
    void initializeApp();
  });
  onCleanup(() => {
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
    void initFonts();
    void initCloseHandler();
    void initWindowListeners();
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
          <button
            type="button"
            class={ACTION_BTN}
            classList={{ "text-text-secondary!": layoutState.leftPanelOpen }}
            onClick={toggleLeftPanel}
            title="Toggle Left Panel"
          >
            <PanelLeftIcon active={layoutState.leftPanelOpen} />
          </button>
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
