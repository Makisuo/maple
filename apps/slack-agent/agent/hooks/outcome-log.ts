import { defineHook } from "eve/hooks"
import { logConnectionSearchFailures, teamIdOf } from "#lib/connection-search-failures.js"
import { emitAgentLog } from "#lib/telemetry-log.js"

/**
 * Unconditional structured turn-outcome + tool-failure logging — the eve-native
 * port of chat-flue's `observe()` bridge in apps/api/src/chat/agent.ts. It stays
 * on whether or not the OTel export (agent/instrumentation.ts) is enabled:
 * these lines are the primary signal for the "agent did nothing" failure mode.
 *
 * Every line goes through `emitAgentLog`, so with an ingest key configured it
 * reaches Maple's `/v1/logs` (queryable, trace-correlated) and without one it
 * prints as a single JSON line. Interpolated `key=value` prose — the previous
 * shape — was queryable in neither place.
 */

export default defineHook({
	events: {
		"turn.completed"(_event, ctx) {
			emitAgentLog("info", "turn_end", {
				"maple.agent.event": "turn_end",
				"maple.agent.errored": false,
				"session.id": ctx.session.id,
				"maple.slack.team_id": teamIdOf(ctx),
			})
		},
		"turn.failed"(event, ctx) {
			emitAgentLog("error", "turn_end", {
				"maple.agent.event": "turn_end",
				"maple.agent.errored": true,
				"session.id": ctx.session.id,
				"maple.slack.team_id": teamIdOf(ctx),
				"maple.agent.error_code": event.data.code,
				"maple.agent.error_message": event.data.message,
			})
		},
		"action.result"(event, ctx) {
			const { result, status, error } = event.data
			logConnectionSearchFailures(result, ctx)

			const failed = status === "failed" || result.isError === true
			if (!failed) return
			const [kind, name] =
				result.kind === "tool-result"
					? (["tool", result.toolName] as const)
					: result.kind === "subagent-result"
						? (["subagent", result.subagentName] as const)
						: (["load_skill", undefined] as const)
			emitAgentLog("error", "action_failed", {
				"maple.agent.event": "action_failed",
				"maple.agent.action_kind": kind,
				"maple.agent.action_name": name,
				"session.id": ctx.session.id,
				"maple.slack.team_id": teamIdOf(ctx),
				"maple.agent.error_message":
					error === undefined ? undefined : error instanceof Error ? error.message : String(error),
			})
		},
	},
})
