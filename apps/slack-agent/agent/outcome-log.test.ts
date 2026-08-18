// SAFETY-FILE: the JSON parsed below is emitted by the unit under test.
// BOUNDARY: eve's stream-event and hook-context shapes are constructed by the
// runtime; the fixtures below carry only the fields this hook reads.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { HookContext, HookEvent } from "eve/hooks"
import outcomeLog from "./hooks/outcome-log.js"

/**
 * Wiring canary for hooks/outcome-log.ts's connection-failure branch: without
 * telemetry active `emitAgentLog` prints one JSON line per record, so the
 * console is a faithful stand-in for what would otherwise be exported to
 * Maple's `/v1/logs`.
 *
 * This is the half that fails silently — the extractor is unit-tested in
 * lib/connection-search-failures.test.ts, but a wrong tool name or a changed
 * `action.result` payload shape would simply stop producing records with no
 * signal anywhere.
 *
 * It lives here rather than beside the hook because eve's discovery treats
 * every file under agent/hooks/ as a hook and rejects the name outright:
 * `Hook path segment "outcome-log.test" is not a legal hook name`.
 */

const handleActionResult = outcomeLog.events?.["action.result"]

/**
 * The real `HookContext` also carries `agent`, `channel`, `getSandbox`, and
 * `getSkill` — none of which the connection-failure branch under test reads,
 * only `session.id` and `session.auth.current.attributes.team_id` — so this
 * fixture is deliberately incomplete. TypeScript's own excess/insufficient
 * overlap check rejects a single-step cast for that reason (it wants proof
 * this is intentional, not a typo), hence the `unknown` step; kept to this
 * one factory rather than repeated per test.
 */
function fakeHookContext(teamId: string): HookContext {
	return {
		session: { id: "session-1", auth: { current: { attributes: { team_id: teamId } } } },
	} as unknown as HookContext
}

const ctx = fakeHookContext("T123")

function actionResultEvent(data: {
	output: unknown
	status?: "completed" | "failed"
	toolName: string
}): HookEvent<"action.result"> {
	return {
		type: "action.result",
		data: {
			result: {
				callId: "call-1",
				kind: "tool-result",
				output: data.output,
				toolName: data.toolName,
			},
			sequence: 1,
			status: data.status ?? "completed",
			stepIndex: 0,
			turnId: "turn-1",
		},
	} as HookEvent<"action.result">
}

let errorSpy: ReturnType<typeof spyOn<Console, "error">>

beforeEach(() => {
	errorSpy = spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
	errorSpy.mockRestore()
})

/** The JSON lines `emitAgentLog` printed, parsed. */
function loggedRecords(): Array<Record<string, unknown>> {
	return errorSpy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
}

describe("outcome-log connection failures", () => {
	test("logs an error for a connection that could not load its tools", async () => {
		await handleActionResult?.(
			actionResultEvent({
				toolName: "connection_search",
				output: [
					{
						connection: "maple",
						description: "Maple observability platform",
						error: 'Failed to load tools for "maple": MCPClientError: MCP SSE Transport Error: 405 Method Not Allowed.',
					},
				],
			}),
			ctx,
		)

		expect(loggedRecords()).toEqual([
			{
				severity: "error",
				body: "connection_unavailable",
				"maple.agent.event": "connection_unavailable",
				"maple.agent.connection": "maple",
				"maple.agent.error_message":
					'Failed to load tools for "maple": MCPClientError: MCP SSE Transport Error: 405 Method Not Allowed.',
				"session.id": "session-1",
				"maple.slack.team_id": "T123",
			},
		])
	})

	test("stays quiet for a connection_search that found tools", async () => {
		await handleActionResult?.(
			actionResultEvent({
				toolName: "connection_search",
				output: [
					{
						connection: "maple",
						description: "List services",
						qualifiedName: "maple__list_services",
						tool: "list_services",
					},
				],
			}),
			ctx,
		)

		expect(loggedRecords()).toEqual([])
	})

	test("leaves ordinary tool results to the existing failure path", async () => {
		// Same payload shape, different tool: nothing is scanned for embedded
		// errors, and a completed result logs nothing at all.
		await handleActionResult?.(
			actionResultEvent({
				toolName: "render_chart",
				output: [{ connection: "maple", error: "boom" }],
			}),
			ctx,
		)

		expect(loggedRecords()).toEqual([])
	})
})
