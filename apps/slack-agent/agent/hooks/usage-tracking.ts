import { defineHook } from "eve/hooks"
import type { HookContext } from "eve/hooks"
import { teamIdOf } from "#lib/connection-search-failures.js"
import { reportMapleUsage } from "#lib/maple.js"
import { emitAgentLog } from "#lib/telemetry-log.js"
import { addStepUsage, takeTurnUsage } from "#lib/usage-report.js"

/**
 * Meters this agent's token consumption into the bound org's Maple AI usage
 * billing. Steps accumulate per turn (`lib/usage-report.ts`); the turn's
 * terminal event flushes one report to Maple's internal usage endpoint, which
 * resolves the org from the team binding and tracks it in Autumn.
 *
 * Fire-and-forget on purpose (the `void` below, same shape as the uninstall
 * forward in `channels/slack.ts`): billing must never delay or fail a reply.
 * A lost report under-bills one turn — the accepted failure mode, matching
 * the triage tracker's fire-and-forget semantics in apps/api.
 *
 * A turn with no resolvable team (single-workspace local dev, an unlinked
 * workspace) has no org to bill and is skipped silently.
 */

function flushTurnUsage(turnId: string, ctx: HookContext): void {
	const totals = takeTurnUsage(turnId)
	if (!totals) return

	const teamId = teamIdOf(ctx)
	if (!teamId || !process.env.MAPLE_INTERNAL_SERVICE_TOKEN) return

	void reportMapleUsage(teamId, {
		...totals,
		// Turn-stable: a duplicate flush (or a Maple-side retry) can never
		// double-bill — Autumn de-dupes on this key.
		idempotencyKey: `${ctx.session.id}:${turnId}`,
	}).catch((error: unknown) => {
		emitAgentLog("warn", "usage_report_failed", {
			"maple.agent.event": "usage_report_failed",
			"session.id": ctx.session.id,
			"maple.slack.team_id": teamId,
			"maple.agent.error_message": error instanceof Error ? error.message : String(error),
		})
	})
}

export default defineHook({
	events: {
		"step.completed"(event) {
			addStepUsage(event.data.turnId, event.data.usage)
		},
		"turn.completed"(event, ctx) {
			flushTurnUsage(event.data.turnId, ctx)
		},
		// Failed and cancelled turns still consumed their steps' tokens.
		"turn.failed"(event, ctx) {
			flushTurnUsage(event.data.turnId, ctx)
		},
		"turn.cancelled"(event, ctx) {
			flushTurnUsage(event.data.turnId, ctx)
		},
	},
})
