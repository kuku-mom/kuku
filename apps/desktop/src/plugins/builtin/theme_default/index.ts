// ── Default Theme Plugin ──
//
// Provides the built-in Kuku dark and light themes.
// Color values are extracted from the base CSS tokens in index.css
// so this plugin can re-apply them at runtime via the theme registry.
//
// This plugin has no commands, no editor contributions, and no views —
// it only contributes a ThemePack with two variants.

import type { KukuPlugin } from "~/plugins/types";

// ── Plugin Definition ──

const themeDefaultPlugin: KukuPlugin = {
  id: "theme-default",
  name: "Default Theme",
  version: "0.1.0",
  description: "Built-in Kuku dark and light themes",

  themes: [
    {
      id: "kuku-default",
      name: "Kuku Default",
      author: "Kuku",
      variants: [
        // ── Dark ──
        {
          name: "Kuku Dark",
          appearance: "dark",
          colors: {
            bgPrimary: "#1a1a1a",
            bgSecondary: "#222222",
            bgTertiary: "#2a2a2a",
            bgElevated: "#2e2e2e",
            textPrimary: "#d4d4d4",
            textSecondary: "#969696",
            textMuted: "#5a5a5a",
            accent: "#d4d4d4",
            accentDim: "rgba(212, 212, 212, 0.12)",
            listActive: "rgba(212, 212, 212, 0.15)",
            listInactive: "rgba(212, 212, 212, 0.08)",
            border: "#2a2a2a",
          },
          extended: {
            ghostHover: "rgba(255, 255, 255, 0.06)",
            ghostSelected: "rgba(255, 255, 255, 0.1)",
            error: "#e55561",
            warning: "#e5a644",
            success: "#6bc46d",
            info: "#8a8a8a",
          },
          syntax: {
            default: "#d4d4d4",
            comment: "#6a6d72",
            keyword: "#c678dd",
            string: "#98c379",
            function: "#9a9a9a",
            number: "#d19a66",
            operator: "#7a7a7a",
            punctuation: "#9a9a9a",
            type: "#e5c07b",
            variable: "#e06c75",
            property: "#e06c75",
            namespace: "#e5c07b",
            tag: "#e06c75",
            attr: "#d19a66",
            "attr-name": "#98c379",
            meta: "#6a6a6a",
            builtin: "#c678dd",
            constant: "#d19a66",
            regexp: "#98c379",
            title: "#9a9a9a",
            selector: "#e06c75",
            deletion: "#e06c75",
            addition: "#98c379",
          },
        },

        // ── Light ──
        {
          name: "Kuku Light",
          appearance: "light",
          colors: {
            bgPrimary: "#ffffff",
            bgSecondary: "#f5f5f5",
            bgTertiary: "#ebebeb",
            bgElevated: "#e0e0e0",
            textPrimary: "#1a1a1a",
            textSecondary: "#666666",
            textMuted: "#999999",
            accent: "#1a1a1a",
            accentDim: "rgba(0, 0, 0, 0.06)",
            listActive: "rgba(0, 0, 0, 0.1)",
            listInactive: "rgba(0, 0, 0, 0.05)",
            border: "#e0e0e0",
          },
          extended: {
            ghostHover: "rgba(0, 0, 0, 0.05)",
            ghostSelected: "rgba(0, 0, 0, 0.1)",
            error: "#dc3545",
            warning: "#d4940a",
            success: "#28a745",
            info: "#525252",
          },
          syntax: {
            default: "#2a2a2a",
            comment: "#8a8a8a",
            keyword: "#7a3d6a",
            string: "#3d6b3d",
            function: "#3a3a3a",
            number: "#7a5a1a",
            operator: "#5a5a5a",
            punctuation: "#3a3a3a",
            type: "#8a5a1a",
            variable: "#a04040",
            property: "#a04040",
            namespace: "#8a5a1a",
            tag: "#a04040",
            attr: "#6a4a0a",
            "attr-name": "#3d6b3d",
            meta: "#8a8a8a",
            builtin: "#7a3d6a",
            constant: "#7a5a1a",
            regexp: "#3d6b3d",
            title: "#2a2a2a",
            selector: "#a04040",
            deletion: "#a04040",
            addition: "#3d6b3d",
          },
        },
      ],
    },
  ],
};

// ── Exports ──

export { themeDefaultPlugin };
