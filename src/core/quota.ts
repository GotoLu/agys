import type { OAuthCredentials } from '../types.js';
import { ANTIGRAVITY_OAUTH_CLIENT_ID, ANTIGRAVITY_OAUTH_CLIENT_SECRET } from './oauth.js';

export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  remainingFraction: number;
  resetTime: string | null;
}

export interface QuotaGroup {
  displayName: string;
  buckets: QuotaBucket[];
}

export interface AccountQuotaSummary {
  fiveHourRemaining: number | null;
  fiveHourResetTime: string | null;
  weeklyRemaining: number | null;
  weeklyResetTime: string | null;
  groups: QuotaGroup[];
  error?: string;
}

const QUOTA_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
];

export async function refreshOAuthTokenIfNeeded(
  oauth: OAuthCredentials,
): Promise<{ oauth: OAuthCredentials; refreshed: boolean }> {
  // Refresh 60 seconds before expiry
  if (Date.now() < oauth.expiryDate - 60_000) {
    return { oauth, refreshed: false };
  }
  if (!oauth.refreshToken) {
    return { oauth, refreshed: false };
  }

  const body = new URLSearchParams({
    client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
    client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
    refresh_token: oauth.refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Token 刷新失败 (HTTP ${res.status})`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    id_token?: string;
  };
  if (!data.access_token) {
    throw new Error('Token 刷新响应缺少 access_token');
  }

  const updated: OAuthCredentials = {
    ...oauth,
    accessToken: data.access_token,
    idToken: data.id_token ?? oauth.idToken,
    expiryDate: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return { oauth: updated, refreshed: true };
}

export function parseQuotaResponse(raw: unknown): AccountQuotaSummary {
  const payload = raw as {
    groups?: Array<{
      displayName?: string;
      buckets?: Array<{
        bucketId?: string;
        displayName?: string;
        remainingFraction?: number;
        resetTime?: string;
      }>;
    }>;
  };

  const groups: QuotaGroup[] = (payload.groups ?? []).map((g) => ({
    displayName: g.displayName ?? 'Unknown',
    buckets: (g.buckets ?? []).map((b) => ({
      bucketId: b.bucketId ?? '',
      displayName: b.displayName ?? '',
      remainingFraction: typeof b.remainingFraction === 'number' ? b.remainingFraction : 0,
      resetTime: b.resetTime ?? null,
    })),
  }));

  // Prefer Gemini group buckets first; fall back to any matching 5h / weekly bucket.
  const geminiGroup =
    groups.find((g) => /gemini/i.test(g.displayName)) ??
    groups[0];

  const allBuckets = geminiGroup ? geminiGroup.buckets : groups.flatMap((g) => g.buckets);
  const fiveHour = allBuckets.find(
    (b) => /5h|five\s*hour/i.test(b.bucketId) || /5h|five\s*hour/i.test(b.displayName),
  );
  const weekly = allBuckets.find(
    (b) => /weekly|7d|week/i.test(b.bucketId) || /weekly|week/i.test(b.displayName),
  );

  return {
    fiveHourRemaining: fiveHour ? fiveHour.remainingFraction : null,
    fiveHourResetTime: fiveHour?.resetTime ?? null,
    weeklyRemaining: weekly ? weekly.remainingFraction : null,
    weeklyResetTime: weekly?.resetTime ?? null,
    groups,
  };
}

export async function fetchAccountQuota(accessToken: string): Promise<AccountQuotaSummary> {
  let lastErr = '未知错误';

  for (const endpoint of QUOTA_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/2.34.0 darwin/arm64',
        },
        body: '{}',
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }

      const json = (await res.json()) as unknown;
      return parseQuotaResponse(json);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    fiveHourRemaining: null,
    fiveHourResetTime: null,
    weeklyRemaining: null,
    weeklyResetTime: null,
    groups: [],
    error: lastErr,
  };
}

export function formatPercent(fraction: number | null): string {
  if (fraction === null) return '--';
  const clamped = Math.max(0, Math.min(1, fraction));
  return `${Math.round(clamped * 100)}%`;
}

export function formatResetCountdown(iso: string | null, nowMs = Date.now()): string | null {
  if (!iso) return null;
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return null;
  const diffMs = target - nowMs;
  if (diffMs <= 0) return '即将重置';
  const totalMin = Math.ceil(diffMs / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${mins}m`;
  return `${mins}m`;
}
