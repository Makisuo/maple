// Relative, not `#lib/*.js`: bun's test runner does not rewrite the package
// `imports` map onto .ts sources, and this module is under test.
import { workersAiModelId } from "./model.js"
import { reportTokenUsage, type TokenUsageReport } from "./maple.js"
import { emitAgentLog } from "./telemetry-log.js"

/**
 * AI-usage capture for the Slack bot.
 *
 * The bot runs its own model (Cloudflare Workers AI on Railway) outside every
 * path Maple's API already meters, so without this its spend is invisible to
 * billing entirely. eve surfaces provider-reported token counts on exactly one
 * hook event — `step.completed`, one per model call — so that is where usage is
 * read; `turn.completed` carries only `{ sequence, turnId }`.
 *
 * **Reported per step, not accumulated per turn.** Per-turn batching would mean
 * fewer HTTP calls but holding mutable state keyed by turn id, which leaks on
 * any turn that never terminates and silently drops the whole turn's spend if
 * the process dies mid-turn. Per-step is stateless.
 */

import { randomUUID } from "node:crypto"

/**
 * Unique-per-process suffix source for the idempotency key.
 *
 * `<sessionId>:<turnId>:<stepIndex>` is NOT unique per model call, which cost
 * real revenue: eve derives `turnId` as `turn_${sequence}` and only advances
 * `sequence` in `emitTurnEpilogue` / `emitRecoverableFailedTurn`. A **terminal**
 * model failure (provider 400, context-length, model-config error) runs
 * `emitFailedStep`, which advances nothing — so when the user re-asks, the next
 * turn is minted with the SAME `turn_${sequence}` and `stepIndex` back at 0, and
 * that retry's step 0 (usually the largest input step) reuses a key the billing
 * provider has already seen. It is dropped silently: no log, no 4xx, just
 * under-billing. eve's park-and-resume branches (`setPendingRuntimeActionBatch`,
 * `setPendingAuthorization`) return emission state unchanged and have the same
 * shape.
 *
 * The trade-off, taken deliberately: appending a per-process unique component
 * means a genuine duplicate DELIVERY of one call would be billed twice. That is
 * near-impossible here — `reportTokenUsage` issues a single `fetch` with no
 * retry (its `AbortSignal.timeout` throws and is swallowed) — whereas the
 * collision above is a live path. Under-billing silently is worse than a
 * theoretical double-count, so uniqueness wins. The readable
 * `<sessionId>:<turnId>:<stepIndex>` prefix is kept so a key still says which
 * call it came from.
 */
const REPORT_BOOT_ID = randomUUID().slice(0, 8)
let reportSequence = 0

/** The subset of eve's `step.completed` event this module needs. */
export interface StepUsageInput {
	readonly sessionId: string
	/**
	 * Slack workspace the turn belongs to. Absent for a session with no Slack
	 * auth context (local dev against a single-workspace token), where there is
	 * no org to bill.
	 */
	readonly teamId: string | undefined
	readonly turnId: string
	readonly stepIndex: number
	readonly inputTokens: number | undefined
	readonly outputTokens: number | undefined
}

/** A report ready to send, paired with the team it bills to. */
export interface PreparedUsageReport {
	readonly teamId: string
	readonly report: TokenUsageReport
}

/** Maple's endpoint takes non-negative integers; providers are trusted but not verified. */
function toTokenCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0
	return Math.max(0, Math.trunc(value))
}

/**
 * Why a step is not billable, or `"billable"` when it is.
 *
 * Two skip cases, both routine rather than exceptional:
 *  - **No team.** Nothing maps the session to an org, so the usage has no payer.
 *  - **Zero tokens.** `workers-ai-provider` reports all-zero usage when a stream
 *    is truncated before the provider sends its usage chunk, so zero-token steps
 *    are expected noise — and Maple would drop the report anyway.
 */
export type StepUsageClass = "billable" | "no-team" | "zero-tokens"

export function classifyStep(input: StepUsageInput): StepUsageClass {
	if (input.teamId === undefined || input.teamId.length === 0) return "no-team"
	if (toTokenCount(input.inputTokens) === 0 && toTokenCount(input.outputTokens) === 0) {
		return "zero-tokens"
	}
	return "billable"
}

/**
 * Turns one `step.completed` into a billable report, or `null` when there is
 * nothing to bill (see {@link classifyStep}).
 */
export function prepareUsageReport(input: StepUsageInput): PreparedUsageReport | null {
	if (classifyStep(input) !== "billable") return null
	reportSequence += 1
	return {
		// `classifyStep` already rejected an absent team.
		teamId: input.teamId as string,
		report: {
			idempotencyKey: `${input.sessionId}:${input.turnId}:${input.stepIndex}:${REPORT_BOOT_ID}-${reportSequence}`,
			inputTokens: toTokenCount(input.inputTokens),
			outputTokens: toTokenCount(input.outputTokens),
			model: workersAiModelId(),
		},
	}
}

/**
 * Zero-token steps are skipped as truncation noise, which hides a total
 * failure mode: if `workers-ai-provider` never surfaces usage for the
 * configured model — it calls `/ai/run/{model}` with `{stream:true}` and never
 * sets `stream_options.include_usage`, leaving its reducer's all-zero
 * initializer intact when no chunk carries usage — then EVERY step is skipped
 * and the feature bills exactly nothing, with no error anywhere.
 *
 * So the skip is counted and surfaced: the first one, then at most one line per
 * window, carrying the cumulative count. Deliberately not a per-step log (a
 * genuinely truncated stream is routine) and deliberately not "bill the zeros".
 */
const ZERO_TOKEN_LOG_INTERVAL_MS = 5 * 60_000
let zeroTokenSkips = 0
let zeroTokenLastLoggedAt: number | undefined

/** Test-only: resets the zero-token skip throttle. */
export function resetZeroTokenDiagnosticsForTests(): void {
	zeroTokenSkips = 0
	zeroTokenLastLoggedAt = undefined
}

function noteZeroTokenSkip(input: StepUsageInput): void {
	zeroTokenSkips += 1
	const now = Date.now()
	if (zeroTokenLastLoggedAt !== undefined && now - zeroTokenLastLoggedAt < ZERO_TOKEN_LOG_INTERVAL_MS) {
		return
	}
	zeroTokenLastLoggedAt = now
	emitAgentLog("warn", "usage_report_zero_tokens", {
		"maple.agent.event": "usage_report_zero_tokens",
		"session.id": input.sessionId,
		"maple.ai.model": workersAiModelId(),
		"maple.ai.zero_token_steps": zeroTokenSkips,
	})
}

export interface TokenUsageDeps {
	reportTokenUsage(teamId: string, usage: TokenUsageReport): Promise<void>
}

const defaultDeps: TokenUsageDeps = { reportTokenUsage }

/**
 * Reports one completed model step's usage to Maple. Never throws and never
 * rejects: it is fired without awaiting from a hook, and a failed billing write
 * must not surface as a failed turn. Failures are logged (queryable, unlike a
 * bare console line) and dropped — there is no local retry, because the Slack
 * reply has already gone out and cannot be held for it.
 */
export async function trackStepUsage(
	input: StepUsageInput,
	deps: TokenUsageDeps = defaultDeps,
): Promise<void> {
	if (classifyStep(input) === "zero-tokens") noteZeroTokenSkip(input)
	const prepared = prepareUsageReport(input)
	if (prepared === null) return
	try {
		await deps.reportTokenUsage(prepared.teamId, prepared.report)
	} catch (error) {
		emitAgentLog("warn", "usage_report_failed", {
			"maple.agent.event": "usage_report_failed",
			"session.id": input.sessionId,
			"maple.slack.team_id": prepared.teamId,
			"maple.ai.model": prepared.report.model,
			"maple.ai.input_tokens": prepared.report.inputTokens,
			"maple.ai.output_tokens": prepared.report.outputTokens,
			"maple.agent.error_message": error instanceof Error ? error.message : String(error),
		})
	}
}
