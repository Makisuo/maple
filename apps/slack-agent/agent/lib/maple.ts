import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Maple API integration for the multi-workspace Slack agent.
 *
 * This module owns three concerns:
 *   1. Resolving per-Slack-team install credentials from Maple's internal
 *      resolve endpoint, with an in-memory TTL cache (`resolveWorkspace`).
 *   2. Verifying inbound Slack webhook signatures (`verifySlackV0Signature`)
 *      and extracting the `team_id` (`parseSlackTeamId`).
 *   3. Bridging "which Slack team is this?" to eve's *arg-less* `botToken`
 *      credential function (`resolveBotToken`), which receives no request
 *      context of its own. See the "Team-context bridging" note below.
 */

// ── Env ─────────────────────────────────────────────────────────────────────

/**
 * Local-dev default for the Maple API base. Overridden by MAPLE_API_BASE_URL.
 */
const MAPLE_API_BASE_URL_DEFAULT = "https://api.localhost";

/**
 * Base URL of the Maple API (e.g. https://api.maple.dev). No trailing slash.
 *
 * NOTE: the Maple MCP connection's `url` is built from this and is **baked into
 * eve's compiled manifest at build time** (like `EVE_WORKFLOW_WORLD`). So
 * `MAPLE_API_BASE_URL` must be set when `eve build` runs for the production URL
 * to bake correctly — a runtime-only value is too late for the connection URL.
 * This helper never throws (it falls back to the local-dev default) so `eve
 * build` / `eve dev` work out of the box; the runtime `fetch` path still fails
 * loudly on a genuinely-missing service token.
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

// ── resolveWorkspace: TTL-cached team → credentials ─────────────────────────

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

// ── Team-context bridging (verifier → arg-less botToken) ─────────────────────
//
// eve's `botToken` credential is `() => Promise<string> | string` — arg-less,
// so it cannot be told which Slack team the current outbound call is for.
//
// What we verified in eve@0.25.3 (node_modules/eve/dist/src):
//   * The webhook route reads the raw body, runs our `webhookVerifier`, then
//     dispatches the mention via `waitUntil(dispatchInboundMessage(...))`
//     (slackChannel.js). `botToken` is resolved lazily *inside* that detached
//     dispatch (api.js `resolveSlackBotToken`), and again later inside durable
//     workflow steps when the reply is posted.
//   * We tested whether an AsyncLocalStorage established in the verifier via
//     `enterWith` survives into that detached dispatch. It does NOT: `await`
//     restores the caller's context snapshot, so a store entered inside the
//     awaited verifier is lost by the time `waitUntil` runs. (Reproduced with a
//     faithful enterWith→await→waitUntil harness — the token read returned the
//     fallback.)
//   * eve's own `runtimeSessionStorage` ALS carries only bundle-cache state
//     (RuntimeSession), not the Slack `team_id`, so it can't carry it either.
//
// Therefore the arg-less `botToken` cannot see `team_id` through any ambient
// eve channel. We bridge with a module-level record populated at verify time:
//   * `enterTeam` is still called (via ALS) as the most-precise signal — it is
//     harmless when it doesn't survive, and makes this forward-compatible if a
//     future eve version preserves context into dispatch.
//   * `recordTeam` sets a module-level most-recently-verified team as the
//     fallback read by `currentTeamId`.
//
// Caveat (documented in the README): under genuinely concurrent inbound events
// from *different* teams, the module fallback can name the wrong team for a
// given outbound call. This fails *closed*, not silently cross-tenant: a bot
// token for team A cannot post to team B's channel — Slack rejects it
// (`channel_not_found` / `invalid_auth`) — so a mis-resolution drops a reply
// rather than leaking one workspace's messages into another. `resolveWorkspace`
// itself is fully keyed by team and always correct. The clean fix belongs
// upstream (eve threading `team_id` into the credential resolver).

interface TeamStore {
  readonly teamId: string;
}

const teamStorage = new AsyncLocalStorage<TeamStore>();
let lastVerifiedTeamId: string | undefined;

/** Best-effort ALS marker for the current team (see note above). */
export function enterTeam(teamId: string): void {
  teamStorage.enterWith({ teamId });
}

/** Module-level fallback record of the most-recently-verified team. */
export function recordTeam(teamId: string): void {
  lastVerifiedTeamId = teamId;
}

/** The team for the current outbound call: ALS first, then module fallback. */
export function currentTeamId(): string | undefined {
  return teamStorage.getStore()?.teamId ?? lastVerifiedTeamId;
}

/**
 * Resolves the Slack bot token for eve's arg-less `botToken` credential.
 *
 * Order: current team's install token → `SLACK_BOT_TOKEN` env (single-workspace
 * dev fallback) → throw.
 */
export async function resolveBotToken(): Promise<string> {
  const teamId = currentTeamId();
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

/**
 * Extracts the Slack `team_id` from a raw webhook body. Handles the standard
 * event-callback top-level field, the `authorizations[]` fallback (Enterprise
 * Grid), and the `event.team` fallback. Returns undefined for payloads without
 * one (e.g. `url_verification`).
 */
export function parseSlackTeamId(rawBody: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;

  if (typeof p.team_id === "string" && p.team_id.length > 0) return p.team_id;

  const auths = p.authorizations;
  if (Array.isArray(auths) && auths.length > 0) {
    const first = auths[0] as Record<string, unknown> | undefined;
    if (first && typeof first.team_id === "string" && first.team_id.length > 0) {
      return first.team_id;
    }
  }

  const event = p.event;
  if (typeof event === "object" && event !== null) {
    const team = (event as Record<string, unknown>).team;
    if (typeof team === "string" && team.length > 0) return team;
  }
  return undefined;
}
