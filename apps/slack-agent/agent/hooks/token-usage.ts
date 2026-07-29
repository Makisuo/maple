import { defineHook, type HookContext } from "eve/hooks"
import { trackStepUsage } from "#lib/token-usage.js"

/**
 * Reports the bot's Workers AI token spend to Maple, which bills it to the org
 * bound to the Slack workspace.
 *
 * `step.completed` is the only hook event eve gives usage on (one per model
 * call, carrying the provider's own counts); `turn.completed` has none. See
 * `agent/lib/token-usage.ts` for why this reports per step rather than
 * accumulating per turn.
 *
 * Fired without awaiting, exactly like the uninstall forward in
 * `agent/lib/uninstall-detection.ts`: hook handlers run inline in the turn, and
 * a billing round-trip must not sit between two model calls of a live Slack
 * reply. `trackStepUsage` never rejects, so the un-awaited promise cannot
 * become an unhandled rejection.
 */

function teamIdOf(ctx: HookContext): string | undefined {
	const team = ctx.session.auth.current?.attributes?.team_id
	return typeof team === "string" && team.length > 0 ? team : undefined
}

export default defineHook({
	events: {
		"step.completed"(event, ctx) {
			void trackStepUsage({
				sessionId: ctx.session.id,
				teamId: teamIdOf(ctx),
				turnId: event.data.turnId,
				stepIndex: event.data.stepIndex,
				inputTokens: event.data.usage?.inputTokens,
				outputTokens: event.data.usage?.outputTokens,
			})
		},
	},
})
