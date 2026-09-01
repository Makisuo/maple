// BOUNDARY: eve's stream-event and hook-context shapes are constructed by the
// runtime; the fixtures below carry only the fields this hook reads.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { HookContext, HookEvent } from "eve/hooks"
import usageTracking from "./hooks/usage-tracking.js"
import { installFetchStub, type FetchStub } from "./lib/fetch-stub.js"
import { resetTurnUsageForTests } from "./lib/usage-report.js"

/**
 * Wiring canary for hooks/usage-tracking.ts: steps accumulate, the turn's
 * terminal event posts ONE usage report to Maple's internal endpoint, and a
 * duplicate terminal event stays silent. Lives at agent/ root because eve's
 * discovery rejects non-hook filenames under agent/hooks/ (see
 * outcome-log.test.ts).
 */

const onStepCompleted = usageTracking.events?.["step.completed"]
const onTurnCompleted = usageTracking.events?.["turn.completed"]
const onTurnFailed = usageTracking.events?.["turn.failed"]

/** Mirrors outcome-log.test.ts's fake — only fields the hook reads matter. */
function fakeHookContext(teamId: string | undefined): HookContext {
	return {
		session: {
			id: "session-1",
			auth: {
				current: {
					attributes: teamId === undefined ? {} : { team_id: teamId },
					authenticator: "test",
					principalId: "test-principal",
					principalType: "test",
				},
				initiator: null,
			},
			turn: { id: "turn-1", sequence: 0 },
		},
		agent: { name: "test-agent" },
		channel: {},
		getSandbox() {
			throw new Error("fakeHookContext: getSandbox is not implemented")
		},
		getSkill() {
			throw new Error("fakeHookContext: getSkill is not implemented")
		},
	}
}

function stepCompletedEvent(
	turnId: string,
	usage: { inputTokens?: number; outputTokens?: number } | undefined,
): HookEvent<"step.completed"> {
	return {
		type: "step.completed",
		data: { finishReason: "stop", sequence: 0, stepIndex: 0, turnId, usage },
	}
}

function turnCompletedEvent(turnId: string): HookEvent<"turn.completed"> {
	return { type: "turn.completed", data: { sequence: 1, turnId } }
}

function turnFailedEvent(turnId: string): HookEvent<"turn.failed"> {
	return {
		type: "turn.failed",
		data: { code: "boom", message: "boom", sequence: 1, turnId },
	}
}

let stub: FetchStub

describe("usage-tracking hook", () => {
	beforeAll(() => {
		process.env.MAPLE_API_BASE_URL = "https://maple-api.test"
		process.env.MAPLE_INTERNAL_SERVICE_TOKEN = "test-service-token"
	})

	beforeEach(() => {
		resetTurnUsageForTests()
		stub = installFetchStub(() => Response.json({ tracked: true }))
	})

	afterEach(() => {
		stub.restore()
	})

	test("accumulates steps and reports once on turn.completed", () => {
		const ctx = fakeHookContext("T123")
		onStepCompleted?.(stepCompletedEvent("turn-1", { inputTokens: 100, outputTokens: 20 }), ctx)
		onStepCompleted?.(stepCompletedEvent("turn-1", { inputTokens: 50, outputTokens: 5 }), ctx)
		expect(stub.calls.length).toBe(0)

		onTurnCompleted?.(turnCompletedEvent("turn-1"), ctx)

		expect(stub.calls.length).toBe(1)
		const call = stub.calls[0]
		expect(call?.url).toBe("https://maple-api.test/internal/slack/workspaces/T123/usage")
		expect(call?.method).toBe("POST")
		expect(call?.headers.authorization).toBe("Bearer maple_svc_test-service-token")
		expect(JSON.parse(String(call?.body))).toEqual({
			inputTokens: 150,
			outputTokens: 25,
			idempotencyKey: "session-1:turn-1",
		})
	})

	test("a failed turn still reports its consumed tokens", () => {
		const ctx = fakeHookContext("T123")
		onStepCompleted?.(stepCompletedEvent("turn-1", { inputTokens: 30, outputTokens: 4 }), ctx)

		onTurnFailed?.(turnFailedEvent("turn-1"), ctx)

		expect(stub.calls.length).toBe(1)
		expect(JSON.parse(String(stub.calls[0]?.body))).toEqual({
			inputTokens: 30,
			outputTokens: 4,
			idempotencyKey: "session-1:turn-1",
		})
	})

	test("a duplicate terminal event does not report twice", () => {
		const ctx = fakeHookContext("T123")
		onStepCompleted?.(stepCompletedEvent("turn-1", { inputTokens: 10, outputTokens: 2 }), ctx)

		onTurnCompleted?.(turnCompletedEvent("turn-1"), ctx)
		onTurnCompleted?.(turnCompletedEvent("turn-1"), ctx)

		expect(stub.calls.length).toBe(1)
	})

	test("stays silent for a turn with no usage or no team binding", () => {
		const withTeam = fakeHookContext("T123")
		onTurnCompleted?.(turnCompletedEvent("turn-no-usage"), withTeam)

		const withoutTeam = fakeHookContext(undefined)
		onStepCompleted?.(stepCompletedEvent("turn-1", { inputTokens: 10, outputTokens: 2 }), withoutTeam)
		onTurnCompleted?.(turnCompletedEvent("turn-1"), withoutTeam)

		expect(stub.calls.length).toBe(0)
	})
})
