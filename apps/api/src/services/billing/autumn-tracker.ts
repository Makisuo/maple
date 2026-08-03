/**
 * Fire-and-forget Autumn usage tracking for headless AI runs. Small imperative
 * copy of apps/chat-agent/src/lib/autumn-tracker.ts (which is app-internal and
 * not exported); the idempotency key carries the source so a chat message and
 * a triage run can never collide.
 */

const DEFAULT_AUTUMN_API_URL = "https://api.useautumn.com"

export interface TrackTokenUsageOptions {
	readonly orgId: string
	readonly inputTokens: number
	readonly outputTokens: number
	readonly idempotencyKey: string
	readonly source: "triage"
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
		const response = await fetch(`${apiUrl}/v1/track`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${secretKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				customer_id: customerId,
				feature_id: event.featureId,
				value: event.value,
				idempotency_key: event.idempotencyKey,
			}),
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
