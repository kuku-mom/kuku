import type { Disposer } from "~/plugins/types";

interface AuthUser {
  email: string;
}

interface AuthSnapshot {
  loading: boolean;
  authenticated: boolean;
  user: AuthUser | null;
  error: string | null;
}

interface AuthPluginAuthorization {
  pluginId: string;
  authorized: boolean;
}

interface AuthAuthorizationResult {
  status: "granted" | "loginRequired" | "permissionRequired";
  headers: Record<"Authorization", string> | null;
}

interface AuthService {
  login(): Promise<void>;
  logout(): Promise<void>;
  openAccountDashboard(): Promise<void>;
  refresh(): Promise<void>;
  snapshot(): AuthSnapshot;
  subscribe(listener: (snapshot: AuthSnapshot) => void): Disposer;
  requestAuthorization(pluginId: string): Promise<AuthAuthorizationResult>;
  authorizationHeaders(pluginId: string): Promise<Record<"Authorization", string> | null>;
  isPluginAuthorized(pluginId: string): boolean;
  setPluginAuthorized(pluginId: string, authorized: boolean): Promise<void>;
  listPluginAuthorizations(): AuthPluginAuthorization[];
  dispose(): void;
}

export type {
  AuthAuthorizationResult,
  AuthPluginAuthorization,
  AuthService,
  AuthSnapshot,
  AuthUser,
};
