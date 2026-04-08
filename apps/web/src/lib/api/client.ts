import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { AuthService } from "@kuku/contract/es/kuku/auth/v1/auth_pb";
import { DashboardService } from "@kuku/contract/es/kuku/dashboard/v1/dashboard_pb";

import { env } from "@/config/env";
import { createMockTransport } from "@/mocks/transport";

const excludedAuthRedirectEndpoints = [
  "AuthService/Profile",
  "AuthService/SignOut",
  "AuthService/CreateDesktopToken",
];

function getRequestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

const fetchWithCredentials: typeof globalThis.fetch = async (input, init) => {
  const response = await globalThis.fetch(input, {
    ...init,
    credentials: "include",
  });

  if (response.status === 401 && typeof window !== "undefined") {
    const url = getRequestUrl(input);
    const isExcluded = excludedAuthRedirectEndpoints.some((endpoint) => url.includes(endpoint));

    if (!isExcluded) {
      window.location.href = "/auth/signin";
    }
  }

  return response;
};

const transport = env.mocking.enabled
  ? createMockTransport()
  : createConnectTransport({
      baseUrl: env.api.baseUrl,
      fetch: fetchWithCredentials,
    });

export const authClient = createClient(AuthService, transport);
export const dashboardClient = createClient(DashboardService, transport);
