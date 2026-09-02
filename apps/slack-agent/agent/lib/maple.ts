import { createHmac, timingSafeEqual } from "node:crypto"
// Relative, not `#lib/env.js`: bun's test runner does not rewrite the package
// `imports` map onto .ts sources, and this module is under test.
import { isDeployedEnvironment } from "./env.js"
import { createTtlCache } from "./ttl-cache.js"

const MAPLE_API_BASE_URL_DEFAULT = "https://api.localhost"

/**
 * Hard ceiling on the resolve round-trip. Without it a stalled Maple API keeps
 * a turn (and, via `resolveBotToken`, an inbound webhook) hanging forever, and
 * the in-flight de-dupe map pins every caller for the same team behind it.
 */
const RESOLVE_TIMEOUT_MS = 5_000

/**
 * Base URL of the Maple API (e.g. https://api.maple.dev). No trailing slash.
 */
export function mapleApiBaseUrl(): string {
	const raw = process.env.MAPLE_API_BASE_URL
	return (raw && raw.length > 0 ? raw : MAPLE_API_BASE_URL_DEFAULT).replace(/\/+$/u, "")
}

const MAPLE_APP_BASE_URL_DEFAULT = "https://app.maple.dev"

/**
 * Base URL of the Maple web app (e.g. https://app.maple.dev), used for deep
 * links in Slack replies. No trailing slash.
 */
export function mapleAppBaseUrl(): string {
	const raw = process.env.MAPLE_APP_BASE_URL
	return (raw && raw.length > 0 ? raw : MAPLE_APP_BASE_URL_DEFAULT).replace(/\/+$/u, "")
}

function mapleServiceToken(): string {
	const raw = process.env.MAPLE_INTERNAL_SERVICE_TOKEN
	if (!raw) throw new Error("MAPLE_INTERNAL_SERVICE_TOKEN is not set.")
	return raw
}

/** A resolved Maple workspace install for one Slack team. */
export interface MapleWorkspace {
	readonly orgId: string
	readonly teamId: string
	readonly teamName: string | null
	/** Slack bot token (xoxb-…) for outbound Web API calls to this team. */
	readonly botToken: string
	/** Maple API key (maple_ak_…) authorizing MCP calls for this org. */
	readonly mapleApiKey: string
}

interface CacheEntry {
	/** Resolved workspace, or null for a negative (404) result. */
	readonly value: MapleWorkspace | null
	readonly expiresAt: number
}

const POSITIVE_TTL_MS = 5 * 60_000 // 5 minutes
const NEGATIVE_TTL_MS = 30_000 // 30 seconds

/**
 * Every cached entry holds a decrypted Slack bot token and a full-access Maple
 * API key, so an expired one must be *dropped*, not merely not served — see
 * `createTtlCache`. The entry count is naturally bounded by the number of
 * workspaces that ever sent an event, which is exactly why a size threshold
 * alone would never fire here: the sweep has to be time-driven.
 */
const WORKSPACE_CACHE_MAX_ENTRIES = 500
const WORKSPACE_CACHE_SWEEP_INTERVAL_MS = 60_000

const cache = createTtlCache<CacheEntry>({
	maxEntries: WORKSPACE_CACHE_MAX_ENTRIES,
	sweepIntervalMs: WORKSPACE_CACHE_SWEEP_INTERVAL_MS,
})
/** De-dupe concurrent resolves for the same team into one in-flight request. */
const inFlight = new Map<string, Promise<MapleWorkspace | null>>()

/**
 * Test-only: clears the module-level TTL cache and in-flight de-dupe map so
 * each test starts from a cold cache. Not used by production code.
 */
export function resetWorkspaceCacheForTests(): void {
	cache.clear()
	inFlight.clear()
}

/** Test-only: how many workspace entries are still retained in memory. */
export function workspaceCacheSizeForTests(): number {
	return cache.size
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
export async function resolveWorkspace(teamId: string): Promise<MapleWorkspace | null> {
	const cached = cache.get(teamId)
	if (cached) return cached.value

	const existing = inFlight.get(teamId)
	if (existing) return existing

	const promise = fetchWorkspace(teamId)
		.then((value) => {
			cache.set(teamId, {
				value,
				expiresAt: Date.now() + (value === null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS),
			})
			return value
		})
		.finally(() => {
			inFlight.delete(teamId)
		})

	inFlight.set(teamId, promise)
	return promise
}

/**
 * Fired without awaiting from the webhook handler (`void forwardUninstallEvent(...)`
 * in `channels/slack.ts`), so — unlike `RESOLVE_TIMEOUT_MS` — this is NOT inside
 * Slack's webhook ack budget; nothing downstream is waiting on it. Generous on
 * purpose: a cold Cloudflare Worker isolate dialing a fresh Hyperdrive/Postgres
 * connection (this endpoint does several sequential `database.execute` calls)
 * can comfortably exceed a couple of seconds, and this was observed timing out
 * in production at 2s.
 */
const NOTIFY_REVOCATION_TIMEOUT_MS = 10_000

/**
 * Tells Maple's API that a Slack team's install is dead, so the bound org's
 * `slack_workspaces` row and minted API key are revoked immediately instead of
 * only via Maple's own reconciliation cron (a ~6h-late backstop). Called from
 * the webhook handler (`agent/lib/uninstall-detection.ts`) when the inbound
 * event is `app_uninstalled` or `tokens_revoked` — Slack allows only one
 * Events API Request URL per app, and it is already pointed at this bot, not
 * directly at Maple's API.
 *
 * Also evicts any cached `resolveWorkspace` entry for the team: otherwise a
 * positive resolution could keep serving the now-dead bot token for up to
 * `POSITIVE_TTL_MS` after Maple has already revoked it.
 *
 * Throws on transport/server errors (mirrors `fetchWorkspace`) — the caller
 * (`agent/lib/uninstall-detection.ts`) catches and logs rather than failing
 * the webhook ack on it. Maple's reconciliation cron is the backstop for a
 * notify that never lands.
 */
export async function notifyMapleRevocation(
	teamId: string,
	reason: "app_uninstalled" | "tokens_revoked",
): Promise<void> {
	cache.delete(teamId)
	const url = `${mapleApiBaseUrl()}/internal/slack/workspaces/${encodeURIComponent(teamId)}/revoke`
	const res = await fetch(url, {
		method: "POST",
		headers: {
			authorization: `Bearer maple_svc_${mapleServiceToken()}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ reason }),
		signal: AbortSignal.timeout(NOTIFY_REVOCATION_TIMEOUT_MS),
	})
	if (!res.ok) {
		throw new Error(`Maple revoke notify failed for team ${teamId} (${reason}): HTTP ${res.status}`)
	}
}

/**
 * Not inside any webhook ack budget (fired without awaiting from the usage
 * hook, like `notifyMapleRevocation` from the uninstall path), and the same
 * cold-Worker considerations apply.
 */
const REPORT_USAGE_TIMEOUT_MS = 10_000

/** One turn's token totals, as Maple's usage endpoint expects them. */
export interface MapleUsageReport {
	readonly inputTokens: number
	readonly outputTokens: number
	/** De-dupe key for Autumn — stable across retries of the same turn. */
	readonly idempotencyKey: string
}

/**
 * Reports one completed turn's token usage to Maple, which meters it into the
 * bound org's AI usage billing. The org is resolved server-side from the team
 * binding — this bot never names an orgId. Throws on transport/server errors;
 * the caller (`agent/hooks/usage-tracking.ts`) catches and logs rather than
 * letting a billing hiccup surface anywhere near the conversation.
 */
export async function reportMapleUsage(teamId: string, usage: MapleUsageReport): Promise<void> {
	const url = `${mapleApiBaseUrl()}/internal/slack/workspaces/${encodeURIComponent(teamId)}/usage`
	const res = await fetch(url, {
		method: "POST",
		headers: {
			authorization: `Bearer maple_svc_${mapleServiceToken()}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(usage),
		signal: AbortSignal.timeout(REPORT_USAGE_TIMEOUT_MS),
	})
	if (!res.ok) {
		throw new Error(`Maple usage report failed for team ${teamId}: HTTP ${res.status}`)
	}
}

async function fetchWorkspace(teamId: string): Promise<MapleWorkspace | null> {
	const url = `${mapleApiBaseUrl()}/internal/slack/workspaces/${encodeURIComponent(teamId)}`
	const res = await fetch(url, {
		headers: { authorization: `Bearer maple_svc_${mapleServiceToken()}` },
		signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
	})

	if (res.status === 404) return null
	if (!res.ok) {
		// Do not cache transport/server errors as "not installed".
		throw new Error(`Maple workspace resolve failed for team ${teamId}: HTTP ${res.status}`)
	}

	const body = (await res.json()) as Partial<MapleWorkspace> | null
	// Type checks, not just truthiness: a contract slip (nested object, number)
	// would otherwise flow into `Bearer ${...}` headers as "[object Object]" and
	// fail far from here. An incomplete payload must fail loudly at the boundary.
	if (
		body === null ||
		typeof body !== "object" ||
		typeof body.orgId !== "string" ||
		body.orgId.length === 0 ||
		typeof body.botToken !== "string" ||
		body.botToken.length === 0 ||
		typeof body.mapleApiKey !== "string" ||
		body.mapleApiKey.length === 0
	) {
		throw new Error(`Maple workspace resolve for team ${teamId} returned an incomplete payload.`)
	}
	return {
		orgId: body.orgId,
		teamId: typeof body.teamId === "string" && body.teamId.length > 0 ? body.teamId : teamId,
		teamName: typeof body.teamName === "string" ? body.teamName : null,
		botToken: body.botToken,
		mapleApiKey: body.mapleApiKey,
	}
}

// ── Bot token resolution ────────────────────────────────────────────────────

/**
 * Context our patched eve (patches/eve@0.25.3.patch) passes to the `botToken`
 * credential. All fields are optional: the one unpatched eve path (the
 * inbound-attachment file fetch) calls the credential with no argument, which
 * is why the env fallback in `resolveBotToken` exists.
 */
export interface SlackTokenContext {
	readonly teamId?: string
	readonly channelId?: string
	readonly threadTs?: string
}

/**
 * Whether the `SLACK_BOT_TOKEN` env fallback may be used.
 *
 * The Slack app is publicly distributed: ANY workspace can install it, and an
 * unlinked workspace's events would otherwise resolve to whatever single token
 * happens to sit in the environment — i.e. outbound calls signed with ANOTHER
 * tenant's credential. So the fallback is confined to non-deployed
 * environments (single-workspace local dev), with
 * `SLACK_ALLOW_ENV_BOT_TOKEN=true` as an explicit, deliberate opt-in for the
 * one legitimate deployed case: a private single-workspace install.
 */
function envBotTokenAllowed(): boolean {
	if (process.env.SLACK_ALLOW_ENV_BOT_TOKEN === "true") return true
	return !isDeployedEnvironment()
}

/**
 * Resolves the Slack bot token for eve's `botToken` credential.
 *
 * Order: `context.teamId` via `resolveWorkspace` → `SLACK_BOT_TOKEN` env
 * (single-workspace dev / context-less paths, gated by `envBotTokenAllowed`)
 * → throw. Failing closed here is deliberate: a missing token drops one reply,
 * whereas a cross-tenant token posts one workspace's data into another's.
 */
export async function resolveBotToken(context?: SlackTokenContext): Promise<string> {
	const teamId = context?.teamId
	if (teamId) {
		const ws = await resolveWorkspace(teamId)
		if (ws) return ws.botToken
	}
	const envToken = process.env.SLACK_BOT_TOKEN
	if (envToken && envBotTokenAllowed()) return envToken
	if (envToken) {
		throw new Error(
			teamId
				? `Slack team ${teamId} is not linked to a Maple workspace. SLACK_BOT_TOKEN is set but ignored in a deployed environment — it belongs to a different workspace. Set SLACK_ALLOW_ENV_BOT_TOKEN=true only for a private single-workspace install.`
				: `No current Slack team context. SLACK_BOT_TOKEN is set but ignored in a deployed environment — it belongs to a different workspace. Set SLACK_ALLOW_ENV_BOT_TOKEN=true only for a private single-workspace install.`,
		)
	}
	throw new Error(
		teamId
			? `Slack team ${teamId} is not linked to a Maple workspace, and SLACK_BOT_TOKEN is not set.`
			: `No current Slack team context and SLACK_BOT_TOKEN is not set.`,
	)
}

// ── Inbound webhook verification ────────────────────────────────────────────

const MAX_SKEW_SECONDS = 60 * 5 // reject timestamps older than 5 minutes

/**
 * Verifies a Slack request signature (v0 scheme) against a static signing
 * secret. Returns true on success, false on any failure (missing headers,
 * stale timestamp, mismatch). The signing secret stays per-app/static — only
 * the *bot token* is per-workspace.
 */
export function verifySlackV0Signature(rawBody: string, headers: Headers, signingSecret: string): boolean {
	const signature = headers.get("x-slack-signature")
	const timestamp = headers.get("x-slack-request-timestamp")
	if (!signature || !timestamp) return false

	const ts = Number(timestamp)
	if (!Number.isFinite(ts)) return false
	if (Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) return false

	const expected =
		"v0=" + createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")

	// Constant-time compare; length guard first (timingSafeEqual throws on
	// differing lengths).
	const a = Buffer.from(signature)
	const b = Buffer.from(expected)
	if (a.length !== b.length) return false
	return timingSafeEqual(a, b)
}
