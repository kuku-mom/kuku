import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
const mockListen = vi.fn().mockResolvedValue(() => {});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

async function loadAuthServiceModule() {
  vi.resetModules();
  return import("./auth_service");
}

describe("core_auth auth_service", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockListen.mockClear();
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

  it("clears cached authorizations on logout", async () => {
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

    expect(auth.authAuthorizations).toEqual([]);
    expect(auth.authState.authenticated).toBe(false);
    expect(auth.authState.user).toBeNull();
    expect(auth.authState.error).toBeNull();
  });
});
