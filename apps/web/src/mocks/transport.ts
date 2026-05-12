import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import { AuthService } from "@kuku/contract/es/kuku/auth/v1/auth_pb";
import { DashboardService } from "@kuku/contract/es/kuku/dashboard/v1/dashboard_pb";

import {
  createMockDailyUsage,
  getMockUser,
  isMockSignedIn,
  mockCurrentUsage,
  mockSubscription,
  setMockEmail,
  setMockSignedIn,
} from "@/mocks/data";

function toUsageDays(days: number | undefined): 1 | 7 | 30 {
  if (days === 1 || days === 7 || days === 30) {
    return days;
  }

  return 7;
}

function assertSignedIn() {
  if (!isMockSignedIn()) {
    throw new ConnectError("Mock user is not signed in.", Code.Unauthenticated);
  }
}

export function createMockTransport(): Transport {
  return createRouterTransport((router) => {
    router.service(AuthService, {
      accountDelete: () => {
        setMockSignedIn(false);
        return {};
      },
      emailAuth: (request) => {
        setMockEmail(request.email);
        return {};
      },
      emailResend: () => ({}),
      emailVerify: (request) => {
        if (request.code.length !== 6) {
          throw new ConnectError("Invalid code.", Code.InvalidArgument);
        }

        setMockSignedIn(true);
        return {};
      },
      githubAuthURL: () => {
        setMockSignedIn(true);
        return { authUrl: "/dashboard?github=done" };
      },
      googleAuthURL: () => {
        setMockSignedIn(true);
        return { authUrl: "/dashboard?google=done" };
      },
      profile: () => {
        assertSignedIn();

        return {
          user: getMockUser(),
        };
      },
      profileUpdate: (request) => {
        assertSignedIn();
        getMockUser().name = request.name.trim() || getMockUser().name;

        return {
          user: getMockUser(),
        };
      },
      signOut: () => {
        setMockSignedIn(false);
        return {};
      },
    });

    router.service(DashboardService, {
      currentUsage: () => {
        assertSignedIn();
        return mockCurrentUsage;
      },
      subscription: () => {
        assertSignedIn();
        return {
          subscription: mockSubscription,
        };
      },
      usageStats: (request) => {
        assertSignedIn();
        return {
          dailyUsage: createMockDailyUsage(toUsageDays(request.days)),
        };
      },
    });
  });
}
