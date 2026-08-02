import { resolveBotToken, type SlackTokenContext } from "./maple.js"
import { createTtlCache, type TtlCacheEntry } from "./ttl-cache.js"

/**
 * Implementation behind `agent/tools/add_reaction.ts` (see render-chart.ts for
 * why behaviour lives under lib/ and the tool file stays a thin adapter).
 *
 * Two cooperating halves:
 *
 *   1. The instant `:eyes:` ack (lib/ack-reaction.ts) registers the triggering
 *      message here, keyed by its thread, before the agent turn even starts.
 *   2. The agent's `add_reaction` tool swaps that ack for a contextual emoji:
 *      it looks the triggering message up by the session's thread, adds the
 *      chosen reaction, then best-effort removes the `:eyes:`.
 *
 * The registry is needed because eve's session attributes carry `thread_ts`
 * but not the triggering message's own `ts` — for thread follow-ups those
 * differ, and reacting to the thread root instead of the message the user just
 * sent would look broken. The registry is in-process (this service is a single
 * deployment); on a miss — process restart, Slack redelivery race — the tool
 * degrades to reacting to the thread root, which for unthreaded messages IS
 * the triggering message (Slack sets `thread_ts` = `ts` there).
 */

export const ACK_REACTION_NAME = "eyes"

/**
 * The emoji the agent may react with. Standard Slack emoji only — every name
 * must exist in every workspace, because `reactions.add` hard-fails on unknown
 * names and a curated list is also the containment boundary: injected text in
 * telemetry can at worst pick a different emoji from this list, never spell
 * an arbitrary one.
 */
export const ALLOWED_REACTION_EMOJIS = [
	"thumbsup",
	"ok_hand",
	"wave",
	"raised_hands",
	"clap",
	"pray",
	"muscle",
	"tada",
	"rocket",
	"fire",
	"100",
	"white_check_mark",
	"bulb",
	"mag",
	"thinking_face",
	"bug",
	"warning",
	"rotating_light",
	"chart_with_upwards_trend",
	"chart_with_downwards_trend",
	"hourglass_flowing_sand",
	"sweat_smile",
	"saluting_face",
	"heart",
] as const

export type AllowedReactionEmoji = (typeof ALLOWED_REACTION_EMOJIS)[number]

// ---------------------------------------------------------------------------
// Triggering-message registry
// ---------------------------------------------------------------------------

interface AckedMessageEntry extends TtlCacheEntry {
	readonly messageTs: string
}

/**
 * 30 min covers any realistic turn (scheduling + model + tools take seconds
 * to minutes); after that the ack'd `:eyes:` is stale history, not something
 * a reaction should still be replacing.
 */
const ACKED_MESSAGE_TTL_MS = 30 * 60 * 1000

const ackedMessages = createTtlCache<AckedMessageEntry>({
	maxEntries: 4096,
	sweepIntervalMs: 60_000,
})

function ackRegistryKey(teamId: string | undefined, channelId: string, threadKey: string): string {
	return `${teamId ?? "-"}:${channelId}:${threadKey}`
}

/**
 * Records the message the `:eyes:` ack targeted, keyed by its thread, so the
 * agent's `add_reaction` tool can later find it from session attributes alone.
 * `threadTs` is the enclosing thread's root ts when the message is a thread
 * reply; omitted for top-level messages (whose own ts names the thread).
 */
export function registerAckedTriggeringMessage(target: {
	readonly teamId?: string
	readonly channelId: string
	readonly messageTs: string
	readonly threadTs?: string
}): void {
	ackedMessages.set(ackRegistryKey(target.teamId, target.channelId, target.threadTs ?? target.messageTs), {
		messageTs: target.messageTs,
		expiresAt: Date.now() + ACKED_MESSAGE_TTL_MS,
	})
}

export function lookupAckedTriggeringMessage(context: {
	readonly teamId?: string
	readonly channelId: string
	readonly threadTs?: string
}): string | undefined {
	if (!context.threadTs) return undefined
	return ackedMessages.get(ackRegistryKey(context.teamId, context.channelId, context.threadTs))?.messageTs
}

/** Test seam: drops every registered message and stops the cache's sweep. */
export function clearAckedTriggeringMessages(): void {
	ackedMessages.clear()
}

// ---------------------------------------------------------------------------
// Slack Web API calls
// ---------------------------------------------------------------------------

export interface SlackReactionCall {
	readonly botToken: string
	readonly channelId: string
	/** Slack ts of the message being (un)reacted. */
	readonly timestamp: string
	readonly name: string
}

/**
 * `reactions.add` via the Slack Web API. `already_reacted` is success: Slack
 * retries webhook delivery, and the second attempt finding the reaction in
 * place is exactly the desired end state.
 */
export async function addReactionViaSlack(options: SlackReactionCall): Promise<void> {
	await callReactionEndpoint("reactions.add", options, "already_reacted")
}

/**
 * `reactions.remove`. `no_reaction` is success: the goal state is "this
 * reaction is not on the message", and it never having been added (an earlier
 * ack failure, a redelivery skip) already satisfies that.
 */
export async function removeReactionViaSlack(options: SlackReactionCall): Promise<void> {
	await callReactionEndpoint("reactions.remove", options, "no_reaction")
}

async function callReactionEndpoint(
	method: "reactions.add" | "reactions.remove",
	options: SlackReactionCall,
	tolerated: string,
): Promise<void> {
	const res = await fetch(`https://slack.com/api/${method}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${options.botToken}`,
			"content-type": "application/json; charset=utf-8",
		},
		body: JSON.stringify({
			channel: options.channelId,
			timestamp: options.timestamp,
			name: options.name,
		}),
	})
	if (!res.ok) {
		throw new Error(`Slack ${method} failed: HTTP ${res.status}`)
	}
	const payload = (await res.json()) as { ok: boolean; error?: string }
	if (!payload.ok && payload.error !== tolerated) {
		throw new Error(`Slack ${method} failed: ${payload.error ?? "unknown_error"}`)
	}
}

// ---------------------------------------------------------------------------
// The tool behaviour
// ---------------------------------------------------------------------------

/** The slice of eve's session context this tool actually reads. */
export interface ReactionSession {
	readonly id: string
	/** Slack auth attributes: `team_id`, `channel_id`, `thread_ts`. */
	readonly attributes: Readonly<Record<string, unknown>>
}

export type ReactionResult =
	| { readonly reacted: true; readonly emoji: string; readonly note: string }
	| { readonly reacted: false; readonly note: string }

/** Injectable dependencies so tests never touch the network. */
export interface ReactionDeps {
	resolveBotToken(context: SlackTokenContext): Promise<string>
	addReaction(options: SlackReactionCall): Promise<void>
	removeReaction(options: SlackReactionCall): Promise<void>
	lookupAckedMessage(context: {
		readonly teamId?: string
		readonly channelId: string
		readonly threadTs?: string
	}): string | undefined
}

export const defaultReactionDeps: ReactionDeps = {
	resolveBotToken,
	addReaction: addReactionViaSlack,
	removeReaction: removeReactionViaSlack,
	lookupAckedMessage: lookupAckedTriggeringMessage,
}

const slackString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined

/**
 * Reacts to the message that triggered this agent turn with `emoji`, then
 * best-effort removes the automatic `:eyes:` ack so the message ends up with
 * one meaningful reaction instead of two. Never throws — a failed reaction is
 * cosmetic and must not cost the model its turn.
 */
export async function reactToTriggeringMessage(
	emoji: AllowedReactionEmoji,
	session: ReactionSession,
	deps: ReactionDeps = defaultReactionDeps,
): Promise<ReactionResult> {
	const teamId = slackString(session.attributes.team_id)
	const channelId = slackString(session.attributes.channel_id)
	const threadTs = slackString(session.attributes.thread_ts)
	const skipped = (why: string): ReactionResult => ({
		reacted: false,
		note: `${why} No reaction was added — continue your reply as normal and do not retry.`,
	})
	if (!channelId) return skipped("This session has no Slack channel.")

	// The registry knows the exact triggering message; the thread root (which
	// for unthreaded messages IS the triggering message) is the degrade path.
	const targetTs = deps.lookupAckedMessage({ teamId, channelId, threadTs }) ?? threadTs
	if (!targetTs) return skipped("The triggering message could not be identified.")

	try {
		const botToken = await deps.resolveBotToken({ teamId, channelId, threadTs })
		await deps.addReaction({ botToken, channelId, timestamp: targetTs, name: emoji })
		// Widened: the allowlist excludes the ack emoji today, but this guard is
		// what keeps a future overlap from removing the reaction just added.
		if ((emoji as string) !== ACK_REACTION_NAME) {
			// Best effort: the new reaction is already in place, and the `:eyes:`
			// may legitimately be absent (ack failure, redelivery skip).
			await deps
				.removeReaction({ botToken, channelId, timestamp: targetTs, name: ACK_REACTION_NAME })
				.catch(() => {})
		}
		return {
			reacted: true,
			emoji,
			note: "Reaction added to the user's message. Do not mention or describe it in your reply.",
		}
	} catch (error) {
		console.warn(`[slack-agent] add_reaction failed session=${session.id}`, error)
		return skipped("Adding the reaction failed.")
	}
}
