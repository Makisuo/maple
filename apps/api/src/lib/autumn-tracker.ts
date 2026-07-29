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
	/**
	 * Namespaces the idempotency key per producer, so a triage run and a Slack
	 * bot turn can never collide on a shared id. `slack-agent` is the
	 * Railway-hosted bot (apps/slack-agent), which reports its own Workers AI
	 * usage through `POST /internal/slack/workspaces/:teamId/usage`.
	 */
	readonly source: "triage" | "slack-agent"
}

interface TrackEvent {
	readonly featureId: "ai_input_tokens" | "ai_output_tokens"
	readonly value: number
	readonly idempotencyKey: string
}

/**
 * Why a call reported nothing. Callers that care about billing coverage (the
 * Slack usage endpoint) turn anything other than `tracked` into a log line and
 * a span annotation; callers that don't (triage, investigations) ignore it.
 *
 * `no-credentials` is the dangerous one: `AUTUMN_SECRET_KEY` is bound with
 * `optionalSecret()`, so a key missing from an Infisical environment silently
 * disables billing with no CI error at all.
 */
export type TrackTokenUsageOutcome =
	| "tracked"
	| "partial"
	| "failed"
	| "no-credentials"
	| "excluded-org"
	| "no-tokens"

export interface TrackTokenUsageResult {
	readonly outcome: TrackTokenUsageOutcome
	/** Events posted to Autumn (0 when nothing was attempted). */
	readonly attempted: number
	readonly succeeded: number
	/** First failure reason, for the caller's log line. Absent when nothing failed. */
	readonly failureReason?: string
}

/**
 * Hard ceiling on one Autumn round-trip. `trackTokenUsage` is awaited inline by
 * the Slack usage endpoint, and at one request per model step a stalled Autumn
 * would otherwise tie up a Worker request per step indefinitely. Billing is
 * best-effort by contract, so giving up beats hanging.
 */
const AUTUMN_TIMEOUT_MS = 5_000

interface PostResult {
	readonly ok: boolean
	readonly reason?: string
}

const postTrack = async (
	apiUrl: string,
	secretKey: string,
	customerId: string,
	event: TrackEvent,
): Promise<PostResult> => {
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
			signal: AbortSignal.timeout(AUTUMN_TIMEOUT_MS),
		})
		if (!response.ok) {
			const body = await response.text().catch(() => "")
			const reason = `${event.featureId}: HTTP ${response.status} ${body.slice(0, 200)}`.trim()
			console.warn(`[autumn-tracker] track failed: ${reason}`)
			return { ok: false, reason }
		}
		return { ok: true }
	} catch (error) {
		const reason = `${event.featureId}: ${error instanceof Error ? error.message : String(error)}`
		console.warn(`[autumn-tracker] track error ${reason}`)
		return { ok: false, reason }
	}
}

/**
 * Never rejects — billing is best-effort and must not fail the work that
 * produced the tokens. It DOES report what happened, so a caller can tell
 * "billed" from "silently billed nothing for a week"; callers that predate the
 * return value can keep ignoring it.
 */
export const trackTokenUsage = async (
	env: Record<string, unknown>,
	{ orgId, inputTokens, outputTokens, idempotencyKey, source }: TrackTokenUsageOptions,
): Promise<TrackTokenUsageResult> => {
	const secretKey = typeof env.AUTUMN_SECRET_KEY === "string" ? env.AUTUMN_SECRET_KEY : undefined
	if (!secretKey) return { outcome: "no-credentials", attempted: 0, succeeded: 0 }
	if (typeof env.MAPLE_DEFAULT_ORG_ID === "string" && orgId === env.MAPLE_DEFAULT_ORG_ID) {
		return { outcome: "excluded-org", attempted: 0, succeeded: 0 }
	}
	if (inputTokens <= 0 && outputTokens <= 0) {
		return { outcome: "no-tokens", attempted: 0, succeeded: 0 }
	}

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

	// `postTrack` resolves with an outcome rather than throwing, so `allSettled`
	// here is belt-and-braces against a future throw path — not the error handling.
	const settled = await Promise.allSettled(
		events.map((event) => postTrack(apiUrl, secretKey, orgId, event)),
	)
	const results: PostResult[] = settled.map((entry) =>
		entry.status === "fulfilled" ? entry.value : { ok: false, reason: String(entry.reason) },
	)
	const succeeded = results.filter((result) => result.ok).length
	const failureReason = results.find((result) => !result.ok)?.reason
	const outcome: TrackTokenUsageOutcome =
		succeeded === results.length ? "tracked" : succeeded === 0 ? "failed" : "partial"

	return {
		outcome,
		attempted: results.length,
		succeeded,
		...(failureReason === undefined ? {} : { failureReason }),
	}
}
