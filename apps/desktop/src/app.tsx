import { createEffect, onCleanup, onMount, Show } from "solid-js";

import { PanelLeftIcon, PanelRightIcon } from "~/components/icons";
import PanelLayout from "~/components/layout/panel_layout";
import RightPanelTabBar from "~/components/layout/right_panel_tab_bar";
import SettingsDialog from "~/components/settings/settings_dialog";
import TabBar from "~/components/layout/tab_bar";
import TitleBar from "~/components/layout/title_bar";
import UpdateIndicator from "~/components/layout/update_indicator";
import VaultBrowser from "~/components/vault/vault_browser";

import { currentLocale, t } from "~/i18n";
import {
  FONT_SANS_FALLBACK,
  FONT_SANS_JA_FALLBACK,
  FONT_MONO_FALLBACK,
  buildFontFamily,
  resolveLocaleSansFontName,
} from "~/lib/font_fallback";
import { installAccessibilitySuppression } from "~/lib/disable_accessibility";
import { bootstrapPlugins, destroyPlugins } from "~/plugins/bootstrap";
import { Slot } from "~/plugins/slots";
import { initSettings, settingsState } from "~/stores/settings";
import { initTheme } from "~/stores/theme";
import { checkForUpdates } from "~/stores/updater";
import { closeVault, openVault, syncConfiguredVaultSelection } from "~/stores/vault";
import {
  destroyWindowListeners,
  initWindowListeners,
  layoutState,
  toggleLeftPanel,
  toggleRightPanel,
} from "~/stores/layout";

// ── Styles ──

const RESIZE_HANDLE_PX = 1;
const COLLAPSED_LEFT_RAIL_PX = 40;
const TITLE_BAR_LEFT_CHROME_PX = 136;
const TITLE_BAR_LEFT_CHROME_FULLSCREEN_PX = 64;
const TITLE_BAR_RIGHT_CHROME_PX = 72;

const ACTION_BTN =
  "flex size-[26px] cursor-pointer items-center justify-center rounded-xs border-none bg-transparent text-icon-muted transition-all duration-150 hover:bg-ghost-hover hover:text-icon active:bg-ghost-active [&>svg]:size-3.5";

// ── Component ──

export default function App() {
  initTheme();
  let cleanupAccessibilitySuppression: (() => void) | null = null;

  // Apply appearance settings reactively
  createEffect(() => {
    document.documentElement.lang = currentLocale();
  });

  createEffect(() => {
    const locale = currentLocale();
    const { fontFamily } = settingsState.appearance;
    const sansFallback = locale === "ja" ? FONT_SANS_JA_FALLBACK : FONT_SANS_FALLBACK;
    const effectiveSansFont = resolveLocaleSansFontName(fontFamily, locale);
    document.documentElement.style.setProperty(
      "--font-ui",
      buildFontFamily(effectiveSansFont, sansFallback),
    );
  });

  createEffect(() => {
    const locale = currentLocale();
    const { fontFamily, fontMono, fontSize, lineHeight, tabSize } = settingsState.editor;
    const sansFallback = locale === "ja" ? FONT_SANS_JA_FALLBACK : FONT_SANS_FALLBACK;
    const effectiveEditorSansFont = resolveLocaleSansFontName(fontFamily, locale);
    document.documentElement.style.setProperty(
      "--font-editor",
      buildFontFamily(effectiveEditorSansFont, sansFallback),
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
    initWindowListeners().catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[Window] Failed to register window listeners", error);
    });
    void restoreLastVault();
    // Dev builds ship with a placeholder updater endpoint (`example.invalid`)
    // so the plugin can initialize; skipping the check avoids a red "Update
    // failed" pill on every run. Use `window.__kukuUpdater.simulate()` or
    // `checkForUpdates()` from the console when iterating on the UI.
    if (import.meta.env.PROD) void checkForUpdates();
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

  function titleBarLeftPanelColumn(): string {
    const panelColumnWidth = layoutState.leftPanelOpen
      ? `${layoutState.leftPanelWidth + RESIZE_HANDLE_PX}px`
      : `${COLLAPSED_LEFT_RAIL_PX}px`;
    const chromeColumnWidth = layoutState.isFullscreen
      ? TITLE_BAR_LEFT_CHROME_FULLSCREEN_PX
      : TITLE_BAR_LEFT_CHROME_PX;

    return `max(${panelColumnWidth}, ${chromeColumnWidth}px)`;
  }

  function titleBarRightPanelColumn(): string {
    const panelColumnWidth = layoutState.rightPanelOpen
      ? `${layoutState.rightPanelWidth + RESIZE_HANDLE_PX}px`
      : "0px";

    return `max(${panelColumnWidth}, ${TITLE_BAR_RIGHT_CHROME_PX}px)`;
  }

  function titleBarGridTemplateColumns(): string {
    return `${titleBarLeftPanelColumn()} minmax(0, 1fr) ${titleBarRightPanelColumn()}`;
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
              title={t("app.action.toggle_left_panel")}
            >
              <PanelLeftIcon active={layoutState.leftPanelOpen} />
            </button>
            <UpdateIndicator />
            <Slot name="titleBarLeftAction" />
          </>
        }
        center={
          <div
            class="grid h-full min-w-0 flex-1 items-stretch"
            data-kuku-titlebar-panel-grid="true"
            style={{ "grid-template-columns": titleBarGridTemplateColumns() }}
          >
            <div class="h-full border-r border-border" aria-hidden="true" />
            <div class="flex h-full min-w-0">
              <TabBar />
            </div>
            <Show when={layoutState.rightPanelOpen}>
              <div class="flex h-full min-w-0">
                <RightPanelTabBar />
              </div>
            </Show>
          </div>
        }
        right={
          <>
            <Slot name="titleBarRightAction" />
            <button
              type="button"
              class={ACTION_BTN}
              classList={{ "text-text-secondary!": layoutState.rightPanelOpen }}
              onClick={toggleRightPanel}
              title={t("app.action.toggle_right_panel")}
            >
              <PanelRightIcon active={layoutState.rightPanelOpen} />
            </button>
          </>
        }
      />
      <PanelLayout
        left={<VaultBrowser />}
        bottom={<p class="p-3 text-xs text-text-muted">{t("app.bottom_panel.placeholder")}</p>}
      />
      <SettingsDialog />
      <div class="pointer-events-none fixed inset-0 z-50">
        <Slot name="overlay" />
      </div>
    </div>
  );
}
