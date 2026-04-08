import { createRouterTransport, type Transport } from "@connectrpc/connect";
import { AuthService } from "@kuku/contract/es/kuku/auth/v1/auth_pb";
import { DashboardService } from "@kuku/contract/es/kuku/dashboard/v1/dashboard_pb";

import { createMockDailyUsage, mockCurrentUsage, mockSubscription, mockUser } from "@/mocks/data";

function toUsageDays(days: number | undefined): 1 | 7 | 30 {
  if (days === 1 || days === 7 || days === 30) {
    return days;
  }

  return 7;
}

export function createMockTransport(): Transport {
  return createRouterTransport((router) => {
    router.service(AuthService, {
      accountDelete: () => ({}),
      profile: () => ({
        user: mockUser,
      }),
      profileUpdate: (request) => {
        mockUser.name = request.name.trim() || mockUser.name;

        return {
          user: mockUser,
        };
      },
      signOut: () => ({}),
    });

    router.service(DashboardService, {
      currentUsage: () => mockCurrentUsage,
      subscription: () => ({
        subscription: mockSubscription,
      }),
      usageStats: (request) => ({
        dailyUsage: createMockDailyUsage(toUsageDays(request.days)),
      }),
    });
  });
}
