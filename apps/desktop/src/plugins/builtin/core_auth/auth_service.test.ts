import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
const mockListen = vi.fn().mockResolvedValue(() => {});
const mockOpenUrl = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: mockOpenUrl,
}));

async function loadAuthServiceModule() {
  vi.resetModules();
  return import("./auth_service");
}

describe("core_auth auth_service", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockListen.mockClear();
    mockOpenUrl.mockReset();
  });

  it("refreshes signed-out state without calling auth_refresh", async () => {
    let authorizationLoads = 0;
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "auth_check_status":
          return false;
        case "auth_list_plugin_authorizations":
          authorizationLoads += 1;
          return authorizationLoads === 1 ? [{ pluginId: "ai-chat", authorized: true }] : [];
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const auth = await loadAuthServiceModule();
    const service = await auth.createAuthService();

    expect(auth.authAuthorizations).toHaveLength(1);

    await expect(service.refresh()).resolves.toBeUndefined();

    expect(mockInvoke).not.toHaveBeenCalledWith("auth_refresh");
    expect(auth.authAuthorizations).toEqual([]);
    expect(auth.authState.authenticated).toBe(false);
    expect(auth.authState.error).toBeNull();
  });

  it("keeps plugin authorizations loaded after logout", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "auth_check_status":
          return true;
        case "auth_get_user":
          return { email: "kuku@example.com" };
        case "auth_list_plugin_authorizations":
          return [{ pluginId: "ai-chat", authorized: true }];
        case "auth_logout":
          return undefined;
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const auth = await loadAuthServiceModule();
    const service = await auth.createAuthService();

    expect(auth.authAuthorizations).toHaveLength(1);

    await service.logout();

    expect(auth.authAuthorizations).toEqual([{ pluginId: "ai-chat", authorized: true }]);
    expect(auth.authState.authenticated).toBe(false);
    expect(auth.authState.user).toBeNull();
    expect(auth.authState.error).toBeNull();
  });

  it("marks the session signed out when refresh clears stored tokens", async () => {
    let statusChecks = 0;
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "auth_check_status":
          statusChecks += 1;
          return statusChecks <= 2;
        case "auth_get_user":
          return { email: "kuku@example.com" };
        case "auth_list_plugin_authorizations":
          return [{ pluginId: "ai-chat", authorized: true }];
        case "auth_refresh":
          throw new Error("failed to refresh desktop token: invalid token");
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const auth = await loadAuthServiceModule();
    const service = await auth.createAuthService();

    await service.refresh();

    expect(auth.authState.authenticated).toBe(false);
    expect(auth.authState.user).toBeNull();
    expect(auth.authState.error).toBe("failed to refresh desktop token: invalid token");
  });

  it("opens the account dashboard in the browser", async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "auth_check_status":
          return true;
        case "auth_get_user":
          return { email: "kuku@example.com" };
        case "auth_list_plugin_authorizations":
          return [];
        default:
          throw new Error(`unexpected invoke: ${command}`);
      }
    });

    const auth = await loadAuthServiceModule();
    const service = await auth.createAuthService();

    await service.openAccountDashboard();

    expect(mockOpenUrl).toHaveBeenCalledWith(expect.stringMatching(/\/dashboard$/));
  });
});
