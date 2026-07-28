import { resolveBotToken } from "./maple.js"

/**
 * Immediate "received" acknowledgement: reacts with :eyes: on the triggering
 * Slack message as soon as the webhook is verified, before eve schedules the
 * agent turn. The turn itself (workflow scheduling + model start) can take
 * seconds; the reaction is the user's instant signal that the bot has the
 * message and will work on it.
 *
 * Fired without awaiting from the `webhookVerifier` (same contract as
 * `forwardUninstallEvent`): it must never delay the webhook ack and it never
 * throws — a failed reaction is cosmetic, the turn still runs.
 *
 * It reacts exactly to the bodies eve will dispatch as agent work:
 *   - `app_mention` events (including thread follow-ups promoted to
 *     `app_mention` by `promoteThreadFollowUp` — call this on the PROMOTED
 *     body; the unpromoted twin does not qualify, so no double reaction);
 *   - user-authored DM `message` events (`channel_type: "im"`, no `bot_id`,
 *     no subtype except `file_share` — mirrors eve's own DM dispatch filter).
 *
 * Requires the Slack app's `reactions:write` scope.
 */

const ACK_REACTION_NAME = "eyes"

/** Injectable dependencies so tests never touch the network. */
export interface AckReactionDeps {
	resolveBotToken(context: { teamId?: string }): Promise<string>
	addReaction(options: {
		readonly botToken: string
		readonly channelId: string
		/** Slack ts of the message being reacted to. */
		readonly timestamp: string
		readonly name: string
	}): Promise<void>
}

const defaultDeps: AckReactionDeps = {
	resolveBotToken,
	addReaction: addReactionViaSlack,
}

export interface AckReactionTarget {
	readonly teamId?: string
	readonly channelId: string
	readonly messageTs: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Parses a verified inbound Slack webhook body and returns the message to
 * react to, or null when the event will not dispatch an agent turn. Never
 * throws on malformed input — anything unexpected simply doesn't qualify.
 */
export function parseAckReactionTarget(rawBody: string): AckReactionTarget | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(rawBody)
	} catch {
		return null
	}
	if (!isRecord(parsed) || parsed.type !== "event_callback") return null

	const event = parsed.event
	if (!isRecord(event)) return null

	const channelId = typeof event.channel === "string" ? event.channel : ""
	const ts = typeof event.ts === "string" ? event.ts : ""
	if (!channelId || !ts) return null

	if (event.type === "message") {
		// Only user-authored DMs dispatch; everything else `message` is dropped
		// by eve (or arrives separately as a real/promoted app_mention).
		if (event.channel_type !== "im") return null
		const subtype = event.subtype
		if (typeof subtype === "string" && subtype.length > 0 && subtype !== "file_share") return null
		if (typeof event.bot_id === "string" && event.bot_id.length > 0) return null
		if (typeof event.user !== "string" || event.user.length === 0) return null
	} else if (event.type !== "app_mention") {
		return null
	}

	return {
		teamId: typeof parsed.team_id === "string" ? parsed.team_id : undefined,
		channelId,
		messageTs: ts,
	}
}

/**
 * Inspects a verified inbound Slack webhook body and, if it is one eve will
 * dispatch as an agent turn, reacts with :eyes: on the triggering message.
 * Intended to be fired without awaiting — it never throws.
 */
export async function acknowledgeIncomingMessage(
	rawBody: string,
	deps: AckReactionDeps = defaultDeps,
): Promise<void> {
	try {
		const target = parseAckReactionTarget(rawBody)
		if (!target) return
		const botToken = await deps.resolveBotToken({ teamId: target.teamId })
		await deps.addReaction({
			botToken,
			channelId: target.channelId,
			timestamp: target.messageTs,
			name: ACK_REACTION_NAME,
		})
	} catch (error) {
		console.warn("[slack-webhook] Acknowledgement reaction failed — ignored.", error)
	}
}

/**
 * `reactions.add` via the Slack Web API. `already_reacted` is success: Slack
 * retries webhook delivery, and the second attempt finding the reaction in
 * place is exactly the desired end state.
 */
export async function addReactionViaSlack(options: {
	readonly botToken: string
	readonly channelId: string
	readonly timestamp: string
	readonly name: string
}): Promise<void> {
	const res = await fetch("https://slack.com/api/reactions.add", {
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
		throw new Error(`Slack reactions.add failed: HTTP ${res.status}`)
	}
	const payload = (await res.json()) as { ok: boolean; error?: string }
	if (!payload.ok && payload.error !== "already_reacted") {
		throw new Error(`Slack reactions.add failed: ${payload.error ?? "unknown_error"}`)
	}
}
