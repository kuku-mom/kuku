import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createStore, unwrap } from "solid-js/store";

import type {
  AuthAuthorizationResult,
  AuthPluginAuthorization,
  AuthService,
  AuthSnapshot,
  AuthUser,
} from "./types";
import type { Disposer } from "~/plugins/types";

const [authState, setAuthState] = createStore<AuthSnapshot>({
  loading: false,
  authenticated: false,
  user: null,
  error: null,
});

const [authAuthorizations, setAuthAuthorizations] = createStore<AuthPluginAuthorization[]>([]);

let authServiceRef: AuthService | null = null;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getAuthService(): AuthService | null {
  return authServiceRef;
}

function setAuthService(service: AuthService | null): void {
  authServiceRef = service;
}

function resetAuthServiceState(): void {
  setAuthState({
    loading: false,
    authenticated: false,
    user: null,
    error: null,
  });
  setAuthAuthorizations([]);
}

async function createAuthService(): Promise<AuthService> {
  const listeners = new Set<(snapshot: AuthSnapshot) => void>();
  const unlistenFns: UnlistenFn[] = [];

  function emit(): void {
    const nextSnapshot = snapshotAuthState();
    for (const listener of listeners) {
      listener(nextSnapshot);
    }
  }

  async function checkAuth(options?: { clearError?: boolean }): Promise<void> {
    setAuthState("loading", true);
    if (options?.clearError ?? true) {
      setAuthState("error", null);
    }
    try {
      const authenticated = await invoke<boolean>("auth_check_status");
      const user = authenticated ? await invoke<AuthUser | null>("auth_get_user") : null;
      setAuthState("authenticated", authenticated);
      setAuthState("user", user);
    } catch (error) {
      setAuthState("authenticated", false);
      setAuthState("user", null);
      setAuthState("error", getErrorMessage(error));
    } finally {
      setAuthState("loading", false);
      emit();
    }
  }

  async function loadAuthorizations(): Promise<void> {
    try {
      const items = await invoke<AuthPluginAuthorization[]>("auth_list_plugin_authorizations");
      setAuthAuthorizations(items);
    } catch (error) {
      setAuthAuthorizations([]);
      throw error;
    }
  }

  async function login(): Promise<void> {
    setAuthState("loading", true);
    setAuthState("error", null);
    emit();
    try {
      await invoke<void>("auth_open_login");
    } catch (error) {
      setAuthState("error", error instanceof Error ? error.message : String(error));
    } finally {
      setAuthState("loading", false);
      emit();
    }
  }

  async function logout(): Promise<void> {
    await invoke<void>("auth_logout");
    setAuthState("authenticated", false);
    setAuthState("user", null);
    setAuthState("error", null);
    setAuthAuthorizations([]);
    emit();
  }

  async function refresh(): Promise<void> {
    await checkAuth();

    if (!authState.authenticated) {
      try {
        await loadAuthorizations();
      } catch (error) {
        setAuthState("error", getErrorMessage(error));
        emit();
      }
      return;
    }

    let refreshError: string | null = null;
    try {
      await invoke<void>("auth_refresh");
    } catch (error) {
      refreshError = getErrorMessage(error);
    }

    try {
      await Promise.all([checkAuth({ clearError: refreshError === null }), loadAuthorizations()]);
    } catch (error) {
      refreshError ??= getErrorMessage(error);
    }

    if (refreshError !== null) {
      setAuthState("error", refreshError);
      emit();
    }
  }

  async function authorizationHeaders(
    pluginId: string,
  ): Promise<Record<"Authorization", string> | null> {
    const headers = await invoke<Record<"Authorization", string> | null>(
      "auth_authorization_headers",
      { pluginId },
    );
    await loadAuthorizations();
    return headers;
  }

  async function requestAuthorization(pluginId: string): Promise<AuthAuthorizationResult> {
    const headers = await authorizationHeaders(pluginId);
    if (headers) {
      return { status: "granted", headers };
    }
    if (!isPluginAuthorized(pluginId)) {
      return { status: "permissionRequired", headers: null };
    }
    if (!authState.authenticated) {
      return { status: "loginRequired", headers: null };
    }
    return { status: "loginRequired", headers: null };
  }

  function snapshot(): AuthSnapshot {
    return snapshotAuthState();
  }

  function subscribe(listener: (snapshot: AuthSnapshot) => void): Disposer {
    listeners.add(listener);
    listener(snapshotAuthState());
    return () => listeners.delete(listener);
  }

  function isPluginAuthorized(pluginId: string): boolean {
    return authAuthorizations.some((item) => item.pluginId === pluginId && item.authorized);
  }

  async function setPluginAuthorized(pluginId: string, authorized: boolean): Promise<void> {
    await invoke<void>("auth_set_plugin_authorized", { pluginId, authorized });
    await loadAuthorizations();
  }

  function listPluginAuthorizations(): AuthPluginAuthorization[] {
    return unwrap(authAuthorizations);
  }

  function dispose(): void {
    for (const unlisten of unlistenFns) {
      unlisten();
    }
    unlistenFns.length = 0;
    listeners.clear();
    setAuthService(null);
  }

  unlistenFns.push(
    await listen("auth://success", () => {
      void checkAuth();
    }),
    await listen<{ message?: string }>("auth://error", (event) => {
      setAuthState("error", event.payload?.message ?? "Authentication failed.");
      setAuthState("loading", false);
      emit();
    }),
  );

  const service: AuthService = {
    login,
    logout,
    refresh,
    snapshot,
    subscribe,
    requestAuthorization,
    authorizationHeaders,
    isPluginAuthorized,
    setPluginAuthorized,
    listPluginAuthorizations,
    dispose,
  };

  setAuthService(service);
  await Promise.all([checkAuth(), loadAuthorizations()]);
  return service;
}

function snapshotAuthState(): AuthSnapshot {
  return {
    loading: authState.loading,
    authenticated: authState.authenticated,
    user: authState.user,
    error: authState.error,
  };
}

export {
  authAuthorizations,
  authState,
  createAuthService,
  getAuthService,
  resetAuthServiceState,
  setAuthService,
};
