import { Plan, SubscriptionStatus } from "@kuku/contract/es/kuku/dashboard/v1/dashboard_pb";

import type { UsageDays } from "@/lib/api/dashboard";

function timestamp(value: string) {
  return {
    nanos: 0,
    seconds: BigInt(Math.floor(Date.parse(value) / 1000)),
  };
}

export const mockUser = {
  email: "dev@kuku.mom",
  id: "mock-user-01",
  name: "Mock User",
};

export const mockSubscription = {
  cancelAtPeriodEnd: false,
  currentPeriodEnd: timestamp("2026-05-01T00:00:00Z"),
  currentPeriodStart: timestamp("2026-04-01T00:00:00Z"),
  plan: Plan.PRO,
  status: SubscriptionStatus.ACTIVE,
};

export const mockCurrentUsage = {
  aiRequestsLimit: 500,
  aiRequestsUsed: 214,
};

export function createMockDailyUsage(days: UsageDays) {
  const baseDate = new Date("2026-04-08T00:00:00Z");

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(baseDate);
    date.setUTCDate(baseDate.getUTCDate() - (days - index - 1));

    return {
      aiRequests: 12 + ((index * 17) % 48),
      date: timestamp(date.toISOString()),
      tokensK: Number((1.2 + ((index * 9) % 23) / 10).toFixed(1)),
    };
  });
}
