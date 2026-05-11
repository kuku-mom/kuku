import { Plan, SubscriptionStatus } from "@kuku/contract/es/kuku/dashboard/v1/dashboard_pb";
import type { SyncAccountKey } from "@kuku/contract/es/kuku/sync/v1/sync_pb";

import { authClient, dashboardClient, syncClient } from "@/lib/api/client";

export type LoadState = "idle" | "loading" | "success" | "error";
export type DashboardRoute = "overview" | "billing" | "settings" | "downloads";
export type PlanName = "FREE" | "PRO" | "ULTRA";
export type SubscriptionState = "ACTIVE" | "CANCELED";
export type UsageDays = 1 | 7 | 30;

export interface UserProfile {
  email: string;
  name: string;
}

export interface SubscriptionInfo {
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date;
  currentPeriodStart: Date;
  plan: PlanName;
  status: SubscriptionState;
}

export interface CurrentUsage {
  aiRequestsLimit: number;
  aiRequestsUsed: number;
}

export interface DailyUsageData {
  aiRequests: number;
  date: Date;
  tokensK: number;
}

export interface EncryptionKeyInfo {
  accountKeyId: string;
  configured: boolean;
  cryptoVersion: string;
  updatedAt: Date | null;
}

function timestampToDate(timestamp?: { nanos: number; seconds: bigint }): Date {
  if (!timestamp) {
    return new Date();
  }

  const milliseconds = Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1_000_000);
  return new Date(milliseconds);
}

export function planToName(plan?: Plan): PlanName {
  switch (plan) {
    case Plan.PRO:
      return "PRO";
    case Plan.ULTRA:
      return "ULTRA";
    default:
      return "FREE";
  }
}

export function subscriptionStatusToName(status?: SubscriptionStatus): SubscriptionState {
  switch (status) {
    case SubscriptionStatus.CANCELED:
      return "CANCELED";
    default:
      return "ACTIVE";
  }
}

export async function getProfile(): Promise<UserProfile> {
  const response = await authClient.profile({});

  if (!response.user) {
    throw new Error("Profile is missing.");
  }

  return {
    email: response.user.email,
    name: response.user.name,
  };
}

export async function updateProfile(name: string): Promise<UserProfile> {
  const response = await authClient.profileUpdate({ name });

  if (!response.user) {
    throw new Error("Updated profile is missing.");
  }

  return {
    email: response.user.email,
    name: response.user.name,
  };
}

export async function signOut(): Promise<void> {
  await authClient.signOut({});
}

export async function deleteAccount(): Promise<void> {
  await authClient.accountDelete({});
}

export async function getSubscription(): Promise<SubscriptionInfo> {
  const response = await dashboardClient.subscription({});

  if (!response.subscription) {
    throw new Error("Subscription is missing.");
  }

  return {
    cancelAtPeriodEnd: response.subscription.cancelAtPeriodEnd,
    currentPeriodEnd: timestampToDate(response.subscription.currentPeriodEnd),
    currentPeriodStart: timestampToDate(response.subscription.currentPeriodStart),
    plan: planToName(response.subscription.plan),
    status: subscriptionStatusToName(response.subscription.status),
  };
}

export async function getCurrentUsage(): Promise<CurrentUsage> {
  const response = await dashboardClient.currentUsage({});

  return {
    aiRequestsLimit: response.aiRequestsLimit,
    aiRequestsUsed: response.aiRequestsUsed,
  };
}

export async function getUsageStats(days: UsageDays): Promise<DailyUsageData[]> {
  const response = await dashboardClient.usageStats({ days });

  return response.dailyUsage.map((usage) => ({
    aiRequests: usage.aiRequests,
    date: timestampToDate(usage.date),
    tokensK: usage.tokensK,
  }));
}

export function syncAccountKeyToEncryptionKeyInfo(accountKey?: SyncAccountKey): EncryptionKeyInfo {
  if (!accountKey) {
    return {
      accountKeyId: "",
      configured: false,
      cryptoVersion: "",
      updatedAt: null,
    };
  }

  return {
    accountKeyId: accountKey.accountKeyId,
    configured: true,
    cryptoVersion: accountKey.cryptoVersion,
    updatedAt: accountKey.updatedAt ? timestampToDate(accountKey.updatedAt) : null,
  };
}

export async function getEncryptionKeyInfo(): Promise<EncryptionKeyInfo> {
  const response = await syncClient.getAccountKeyState({});

  return syncAccountKeyToEncryptionKeyInfo(response.accountKey);
}
