/**
 * Fire-and-forget Autumn usage tracking for every AI surface Maple bills:
 * autonomous triage, the Slack agent, and an attended chat turn. Small
 * imperative module rather than a service, because every caller reaches it from
 * a place where a failure must not propagate.
 *
 * The idempotency key carries the source, so two surfaces that legitimately key
 * on the same id can never collide — and a retry of any of them bills once.
 */

import { AUTUMN_API_VERSION, AUTUMN_TRACK_PATH } from "@/services/billing/autumn-api"

const DEFAULT_AUTUMN_API_URL = "https://api.useautumn.com"

/**
 * Ceiling on one track call.
 *
 * Every caller awaits this from somewhere that is holding something open — a chat
 * turn holds the session's turn slot until it resolves, so an unbounded stall would
 * leave a finished conversation unable to accept the next message. A dropped meter
 * event is the cheaper failure, and it is already the failure mode for a non-2xx.
 */
const TRACK_TIMEOUT_MS = 5_000

export interface TrackTokenUsageOptions {
	readonly orgId: string
	readonly inputTokens: number
	readonly outputTokens: number
	readonly idempotencyKey: string
	readonly source: "triage" | "slack" | "chat"
}

interface TrackEvent {
	readonly featureId: "ai_input_tokens" | "ai_output_tokens"
	readonly value: number
	readonly idempotencyKey: string
}

const postTrack = async (
	apiUrl: string,
	secretKey: string,
	customerId: string,
	event: TrackEvent,
): Promise<void> => {
	try {
		const response = await fetch(`${apiUrl}${AUTUMN_TRACK_PATH}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${secretKey}`,
				"Content-Type": "application/json",
				"x-api-version": AUTUMN_API_VERSION,
			},
			body: JSON.stringify({
				customer_id: customerId,
				feature_id: event.featureId,
				value: event.value,
				idempotency_key: event.idempotencyKey,
			}),
			signal: AbortSignal.timeout(TRACK_TIMEOUT_MS),
		})
		if (!response.ok) {
			const body = await response.text().catch(() => "")
			console.warn(
				`[autumn-tracker] track failed: ${response.status} feature=${event.featureId} body=${body}`,
			)
		}
	} catch (error) {
		console.warn(
			`[autumn-tracker] track error feature=${event.featureId}: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

export const trackTokenUsage = async (
	env: Record<string, unknown>,
	{ orgId, inputTokens, outputTokens, idempotencyKey, source }: TrackTokenUsageOptions,
): Promise<void> => {
	const secretKey = typeof env.AUTUMN_SECRET_KEY === "string" ? env.AUTUMN_SECRET_KEY : undefined
	if (!secretKey) return
	if (typeof env.MAPLE_DEFAULT_ORG_ID === "string" && orgId === env.MAPLE_DEFAULT_ORG_ID) return
	if (inputTokens <= 0 && outputTokens <= 0) return

	const apiUrl = (
		typeof env.AUTUMN_API_URL === "string" ? env.AUTUMN_API_URL : DEFAULT_AUTUMN_API_URL
	).replace(/\/+$/, "")
	const events: TrackEvent[] = []
	if (inputTokens > 0) {
		events.push({
			featureId: "ai_input_tokens",
			value: inputTokens,
			idempotencyKey: `${idempotencyKey}:${source}:input`,
		})
	}
	if (outputTokens > 0) {
		events.push({
			featureId: "ai_output_tokens",
			value: outputTokens,
			idempotencyKey: `${idempotencyKey}:${source}:output`,
		})
	}

	await Promise.allSettled(events.map((event) => postTrack(apiUrl, secretKey, orgId, event)))
}
