/**
 * Per-workspace bot user id, learned from inbound webhook envelopes.
 *
 * Every `event_callback` Slack delivers names the app's own bot user under
 * `authorizations[].user_id`, so the id is free — no `auth.test` round-trip and
 * no extra secret. The webhook verifier records it (`rememberBotUserId`) and
 * later stages read it back per team (`botUserIdForTeam`).
 *
 * Why it is needed at all: eve marks a thread message as the agent's own with
 * `isMe = bot_id !== undefined`, i.e. *any* bot. In a channel that also hosts a
 * CI or GitHub app, that mislabels a stranger's post as something this agent
 * said. Thread context (`#lib/thread-context.js`) attributes speakers with this
 * id instead.
 *
 * The cache is process-global and keyed by team id, which is the only
 * multi-tenant-safe key here: this app serves every workspace that installed
 * the Slack app.
 */

import { createTtlCache } from "./ttl-cache.js"

// A workspace's bot user id is stable for the life of the installation, so the
// TTL only bounds how long an uninstalled workspace lingers in memory.
const BOT_USER_ID_TTL_MS = 24 * 60 * 60_000
const CACHE_MAX_ENTRIES = 500
const CACHE_SWEEP_INTERVAL_MS = 60 * 60_000

interface BotUserIdEntry {
	readonly botUserId: string
	readonly expiresAt: number
}

const botUserIds = createTtlCache<BotUserIdEntry>({
	maxEntries: CACHE_MAX_ENTRIES,
	sweepIntervalMs: CACHE_SWEEP_INTERVAL_MS,
})

/** Test-only: clears the cache so each test starts cold. */
export function resetBotUserIdCacheForTests(): void {
	botUserIds.clear()
}

/**
 * The event envelope's `authorizations` names the app's bot user — no
 * `auth.test` round-trip needed. Returns null when the envelope carries none.
 */
export function botUserIdFromEnvelope(envelope: Record<string, unknown>): string | null {
	const authorizations = envelope.authorizations
	if (!Array.isArray(authorizations)) return null
	for (const auth of authorizations) {
		if (isRecord(auth) && typeof auth.user_id === "string" && auth.user_id.length > 0) {
			return auth.user_id
		}
	}
	return null
}

/**
 * Records the bot user id carried by a verified inbound webhook body. Never
 * throws — a body we cannot read simply teaches us nothing.
 */
export function rememberBotUserId(rawBody: string): void {
	let parsed: unknown
	try {
		parsed = JSON.parse(rawBody)
	} catch {
		return
	}
	if (!isRecord(parsed)) return
	const teamId = typeof parsed.team_id === "string" ? parsed.team_id : ""
	const botUserId = botUserIdFromEnvelope(parsed)
	if (!teamId || !botUserId) return
	botUserIds.set(teamId, { botUserId, expiresAt: Date.now() + BOT_USER_ID_TTL_MS })
}

/**
 * The bot user id for a workspace, or undefined when no webhook has taught us
 * one yet. Callers must degrade gracefully rather than block on it: the id is
 * an attribution refinement, never a gate.
 */
export function botUserIdForTeam(teamId: string | undefined): string | undefined {
	if (!teamId) return undefined
	return botUserIds.get(teamId)?.botUserId
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
