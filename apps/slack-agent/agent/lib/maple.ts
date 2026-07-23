import { createHmac, timingSafeEqual } from "node:crypto";

const MAPLE_API_BASE_URL_DEFAULT = "https://api.localhost";

/**
 * Base URL of the Maple API (e.g. https://api.maple.dev). No trailing slash.
 */
export function mapleApiBaseUrl(): string {
  const raw = process.env.MAPLE_API_BASE_URL;
  return (raw && raw.length > 0 ? raw : MAPLE_API_BASE_URL_DEFAULT).replace(
    /\/+$/u,
    "",
  );
}

function mapleServiceToken(): string {
  const raw = process.env.MAPLE_INTERNAL_SERVICE_TOKEN;
  if (!raw) throw new Error("MAPLE_INTERNAL_SERVICE_TOKEN is not set.");
  return raw;
}

/** A resolved Maple workspace install for one Slack team. */
export interface MapleWorkspace {
  readonly orgId: string;
  readonly teamId: string;
  readonly teamName: string | null;
  /** Slack bot token (xoxb-…) for outbound Web API calls to this team. */
  readonly botToken: string;
  /** Maple API key (maple_ak_…) authorizing MCP calls for this org. */
  readonly mapleApiKey: string;
}

interface CacheEntry {
  /** Resolved workspace, or null for a negative (404) result. */
  readonly value: MapleWorkspace | null;
  readonly expiresAt: number;
}

const POSITIVE_TTL_MS = 5 * 60_000; // 5 minutes
const NEGATIVE_TTL_MS = 30_000; // 30 seconds

const cache = new Map<string, CacheEntry>();
/** De-dupe concurrent resolves for the same team into one in-flight request. */
const inFlight = new Map<string, Promise<MapleWorkspace | null>>();

/**
 * Test-only: clears the module-level TTL cache and in-flight de-dupe map so
 * each test starts from a cold cache. Not used by production code.
 */
export function resetWorkspaceCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Resolves the Maple install for a Slack team, cached in-memory.
 *
 * Returns `null` when the team is not installed / has been revoked (the
 * endpoint returns 404). Positive results are cached for 5 minutes, negative
 * results for 30 seconds so a fresh install is picked up quickly.
 *
 * Throws only on transport / server errors (5xx, network) so a transient Maple
 * outage surfaces rather than being cached as "not installed".
 */
export async function resolveWorkspace(
  teamId: string,
): Promise<MapleWorkspace | null> {
  const cached = cache.get(teamId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const existing = inFlight.get(teamId);
  if (existing) return existing;

  const promise = fetchWorkspace(teamId)
    .then((value) => {
      cache.set(teamId, {
        value,
        expiresAt:
          Date.now() + (value === null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS),
      });
      return value;
    })
    .finally(() => {
      inFlight.delete(teamId);
    });

  inFlight.set(teamId, promise);
  return promise;
}

async function fetchWorkspace(teamId: string): Promise<MapleWorkspace | null> {
  const url = `${mapleApiBaseUrl()}/internal/slack/workspaces/${encodeURIComponent(teamId)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer maple_svc_${mapleServiceToken()}` },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    // Do not cache transport/server errors as "not installed".
    throw new Error(
      `Maple workspace resolve failed for team ${teamId}: HTTP ${res.status}`,
    );
  }

  const body = (await res.json()) as Partial<MapleWorkspace>;
  if (!body.botToken || !body.mapleApiKey || !body.orgId) {
    throw new Error(
      `Maple workspace resolve for team ${teamId} returned an incomplete payload.`,
    );
  }
  return {
    orgId: body.orgId,
    teamId: body.teamId ?? teamId,
    teamName: body.teamName ?? null,
    botToken: body.botToken,
    mapleApiKey: body.mapleApiKey,
  };
}

// ── Bot token resolution ────────────────────────────────────────────────────

/**
 * Context our patched eve (patches/eve@0.25.3.patch) passes to the `botToken`
 * credential. All fields are optional: the one unpatched eve path (the
 * inbound-attachment file fetch) calls the credential with no argument, which
 * is why the env fallback in `resolveBotToken` exists.
 */
export interface SlackTokenContext {
  readonly teamId?: string;
  readonly channelId?: string;
  readonly threadTs?: string;
}

/**
 * Resolves the Slack bot token for eve's `botToken` credential.
 *
 * Order: `context.teamId` via `resolveWorkspace` → `SLACK_BOT_TOKEN` env
 * (single-workspace dev / context-less paths) → throw.
 */
export async function resolveBotToken(
  context?: SlackTokenContext,
): Promise<string> {
  const teamId = context?.teamId;
  if (teamId) {
    const ws = await resolveWorkspace(teamId);
    if (ws) return ws.botToken;
  }
  const envToken = process.env.SLACK_BOT_TOKEN;
  if (envToken) return envToken;
  throw new Error(
    teamId
      ? `Slack team ${teamId} is not linked to a Maple workspace, and SLACK_BOT_TOKEN is not set.`
      : `No current Slack team context and SLACK_BOT_TOKEN is not set.`,
  );
}

// ── Inbound webhook verification ────────────────────────────────────────────

const MAX_SKEW_SECONDS = 60 * 5; // reject timestamps older than 5 minutes

/**
 * Verifies a Slack request signature (v0 scheme) against a static signing
 * secret. Returns true on success, false on any failure (missing headers,
 * stale timestamp, mismatch). The signing secret stays per-app/static — only
 * the *bot token* is per-workspace.
 */
export function verifySlackV0Signature(
  rawBody: string,
  headers: Headers,
  signingSecret: string,
): boolean {
  const signature = headers.get("x-slack-signature");
  const timestamp = headers.get("x-slack-request-timestamp");
  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) return false;

  const expected =
    "v0=" +
    createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex");

  // Constant-time compare; length guard first (timingSafeEqual throws on
  // differing lengths).
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
