import { describe, expect, it } from "vitest";

import {
  DELETE_ACCOUNT_CONFIRMATION_TEXT,
  accountDeleteClickAction,
  accountDeleteButtonLabel,
  canRequestAccountDelete,
} from "./account_delete_confirmation";

describe("account delete confirmation", () => {
  it("requires the exact typed phrase before account deletion can be requested", () => {
    expect(canRequestAccountDelete("delete my account")).toBe(true);
    expect(canRequestAccountDelete(" delete my account ")).toBe(true);
    expect(canRequestAccountDelete("DELETE MY ACCOUNT")).toBe(false);
    expect(canRequestAccountDelete("delete account")).toBe(false);
  });

  it("arms a second confirmation click before the destructive request", () => {
    expect(accountDeleteClickAction(DELETE_ACCOUNT_CONFIRMATION_TEXT, false)).toBe("arm");
    expect(accountDeleteClickAction(DELETE_ACCOUNT_CONFIRMATION_TEXT, true)).toBe("delete");
    expect(accountDeleteClickAction("delete account", true)).toBe("blocked");
  });

  it("changes the button label while waiting for the second confirmation click", () => {
    expect(accountDeleteButtonLabel(false)).toBe("Delete account");
    expect(accountDeleteButtonLabel(true)).toBe("Click again to permanently delete");
  });
});
