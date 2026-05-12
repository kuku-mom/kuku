import { Plan, SubscriptionStatus } from "@kuku/contract/es/kuku/dashboard/v1/dashboard_pb";

import type { UsageDays } from "@/lib/api/dashboard";

const mockSignedInKey = "kuku_mock_signed_in";
const mockEmailKey = "kuku_mock_email";

let fallbackSignedIn = false;
let fallbackEmail = "dev@kuku.mom";

function timestamp(value: string) {
  return {
    nanos: 0,
    seconds: BigInt(Math.floor(Date.parse(value) / 1000)),
  };
}

export const mockUser = {
  email: fallbackEmail,
  id: "mock-user-01",
  name: "Mock User",
};

function canUseSessionStorage(): boolean {
  return typeof window !== "undefined" && "sessionStorage" in window;
}

function readStoredEmail(): string {
  if (!canUseSessionStorage()) {
    return fallbackEmail;
  }

  return window.sessionStorage.getItem(mockEmailKey) ?? fallbackEmail;
}

export function isMockSignedIn(): boolean {
  if (!canUseSessionStorage()) {
    return fallbackSignedIn;
  }

  return window.sessionStorage.getItem(mockSignedInKey) === "1";
}

export function setMockSignedIn(value: boolean) {
  fallbackSignedIn = value;

  if (!canUseSessionStorage()) {
    return;
  }

  if (value) {
    window.sessionStorage.setItem(mockSignedInKey, "1");
  } else {
    window.sessionStorage.removeItem(mockSignedInKey);
  }
}

export function setMockEmail(email: string) {
  fallbackEmail = email;
  mockUser.email = email;
  mockUser.name = email.split("@")[0] || "Mock User";

  if (canUseSessionStorage()) {
    window.sessionStorage.setItem(mockEmailKey, email);
  }
}

export function getMockUser() {
  mockUser.email = readStoredEmail();
  return mockUser;
}

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
