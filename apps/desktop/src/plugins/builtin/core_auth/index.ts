import { lazy } from "solid-js";

import type { KukuPlugin } from "~/plugins/types";

import { createAuthService, resetAuthServiceState } from "./auth_service";

const AuthSettingsView = lazy(() =>
  import("./auth_settings").then((module) => ({ default: module.AuthSettings })),
);

const coreAuthPlugin: KukuPlugin = {
  id: "core-auth",
  name: "Auth",
  version: "0.1.0",
  description: "Kuku account session and plugin authorization service",
  canDisable: false,

  views: [
    {
      id: "core-auth.settings",
      label: "Account",
      location: { slot: "settingsSection" },
      order: 10,
      component: AuthSettingsView,
    },
  ],

  reset() {
    resetAuthServiceState();
  },

  async activate(ctx) {
    const service = await createAuthService();
    ctx.services.register("auth", service);
    ctx.track(() => service.dispose());
  },
};

export { coreAuthPlugin };
export type {
  AuthAuthorizationResult,
  AuthPluginAuthorization,
  AuthService,
  AuthSnapshot,
  AuthUser,
} from "./types";
