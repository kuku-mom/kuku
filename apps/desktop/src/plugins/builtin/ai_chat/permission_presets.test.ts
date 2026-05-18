import { describe, expect, it } from "vitest";

import type { MessageKey } from "~/i18n";
import { KO_MESSAGES } from "~/i18n/locales/ko";
import {
  getPermissionPreset,
  getPermissionPresetOptions,
  PERMISSION_PRESETS,
} from "./permission_presets";

describe("ai chat permission presets", () => {
  it("orders the user-facing presets from safest to broadest", () => {
    expect(PERMISSION_PRESETS.map((preset) => preset.id)).toEqual([
      "default",
      "auto-review",
      "full-access",
    ]);
  });

  it("requires an extra confirmation before enabling full access", () => {
    expect(getPermissionPreset("default").requiresConfirmation).toBe(false);
    expect(getPermissionPreset("auto-review").requiresConfirmation).toBe(false);
    expect(getPermissionPreset("full-access").requiresConfirmation).toBe(true);
  });

  it("builds localized selector options", () => {
    const translate = (key: MessageKey): string => KO_MESSAGES[key];

    expect(getPermissionPresetOptions(translate)).toMatchObject([
      {
        id: "default",
        label: "기본 권한",
      },
      {
        id: "auto-review",
        label: "자동 검토",
      },
      {
        id: "full-access",
        label: "전체 권한",
      },
    ]);
  });
});
