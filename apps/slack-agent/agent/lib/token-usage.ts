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
 * the process dies mid-turn. Per-step is stateless, and `<sessionId>:<turnId>:
 * <stepIndex>` is naturally unique, so Maple can hand it straight to the
 * billing provider as an idempotency key and let a replayed durable step
 * de-duplicate itself.
 */

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
 * Turns one `step.completed` into a billable report, or `null` when there is
 * nothing to bill.
 *
 * Two skip cases, both routine rather than exceptional:
 *  - **No team.** Nothing maps the session to an org, so the usage has no payer.
 *  - **Zero tokens.** `workers-ai-provider` reports all-zero usage when a stream
 *    is truncated before the provider sends its usage chunk, so zero-token steps
 *    are expected noise — and Maple would drop the report anyway.
 */
export function prepareUsageReport(input: StepUsageInput): PreparedUsageReport | null {
	if (input.teamId === undefined || input.teamId.length === 0) return null
	const inputTokens = toTokenCount(input.inputTokens)
	const outputTokens = toTokenCount(input.outputTokens)
	if (inputTokens === 0 && outputTokens === 0) return null
	return {
		teamId: input.teamId,
		report: {
			idempotencyKey: `${input.sessionId}:${input.turnId}:${input.stepIndex}`,
			inputTokens,
			outputTokens,
			model: workersAiModelId(),
		},
	}
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
