// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AiSessionSpan } from "@maple/domain/http"
import type { AiSessionSpansPage } from "@/api/warehouse/ai-sessions"
import { Atom, Result } from "@/lib/effect-atom"
import type { QueryAtomFailure } from "@/lib/services/atoms/warehouse-query-atoms"
import { agentSpan, llmSpan, makeSpan } from "@/lib/agent-sessions/span-test-support"
import { buildSessionTurns } from "@/lib/agent-sessions/session-turns"

import { useSessionSpans, type SessionSpansReads } from "./use-session-spans"

const mocks = {
	firstPage: { data: [] as readonly AiSessionSpan[], nextCursor: undefined as { timestamp: string; spanId: string } | undefined },
}
/** Every page past the first goes through the injected fetcher. */
const fetchPage = vi.fn<SessionSpansReads["fetchPage"]>()
/** One atom per distinct input, the way the real family behaves. */
type FirstPageAtom = Atom.Atom<Result.Result<AiSessionSpansPage, QueryAtomFailure>>
const atoms = new Map<string, FirstPageAtom>()
const reads: SessionSpansReads = {
	firstPageAtom: (input) => {
		const key = JSON.stringify(input)
		let atom = atoms.get(key)
		if (atom === undefined) {
			atom = Atom.make(Result.success<AiSessionSpansPage, QueryAtomFailure>(mocks.firstPage))
			atoms.set(key, atom)
		}
		return atom
	},
	fetchPage,
}

const SECOND = 1000
const CURSOR = { timestamp: "2026-08-19 10:00:30.000000000", spanId: "llm-1" }

const firstPageSpans = [
	agentSpan({ spanId: "agent-1", startMs: 0, durationMs: 30 * SECOND }),
	llmSpan({ spanId: "llm-1", parentSpanId: "agent-1", startMs: SECOND, durationMs: 5 * SECOND }),
	makeSpan({ spanId: "http-1", parentSpanId: "agent-1", startMs: 2 * SECOND, durationMs: 100, spanName: "GET /x", isAiSpan: false }),
]
const secondPageSpans = [
	agentSpan({ spanId: "agent-2", startMs: 60 * SECOND, durationMs: 30 * SECOND }),
	llmSpan({ spanId: "llm-2", parentSpanId: "agent-2", startMs: 61 * SECOND, durationMs: 5 * SECOND }),
]

afterEach(() => {
	fetchPage.mockReset()
	atoms.clear()
	mocks.firstPage = { data: [], nextCursor: undefined }
})

describe("useSessionSpans", () => {
	it("is complete after one page when the session fits", () => {
		mocks.firstPage = { data: firstPageSpans, nextCursor: undefined }
		const { result } = renderHook(() => useSessionSpans("s1", undefined, reads))

		expect(result.current.partial).toBe(false)
		expect(result.current.hasMore).toBe(false)
		expect(result.current.spans.map((span) => span.spanId)).toEqual(["agent-1", "llm-1", "http-1"])
	})

	it("continues past the first page with the agent's spans alone, after the cursor", async () => {
		mocks.firstPage = { data: firstPageSpans, nextCursor: CURSOR }
		fetchPage.mockResolvedValueOnce({ data: secondPageSpans, nextCursor: undefined })
		const { result } = renderHook(() =>
			useSessionSpans("s1", { startTime: "2026-08-19 09:00:00", endTime: "2026-08-19 11:00:00" }, reads),
		)

		expect(result.current.partial).toBe(true)
		expect(result.current.hasMore).toBe(true)
		act(() => result.current.loadMore())
		await waitFor(() => expect(result.current.hasMore).toBe(false))

		expect(fetchPage).toHaveBeenCalledWith({
			sessionId: "s1",
			startTime: "2026-08-19 09:00:00",
			endTime: "2026-08-19 11:00:00",
			scope: "ai",
			after: CURSOR,
			limit: 2000,
		})
		expect(result.current.spans.map((span) => span.spanId)).toEqual(["agent-1", "llm-1", "http-1", "agent-2", "llm-2"])
		// The session stays partial: the later turns hold agent spans alone.
		expect(result.current.partial).toBe(true)
	})

	it("loads a turn's app spans by its traces and bounds, and drops repeats", async () => {
		mocks.firstPage = { data: firstPageSpans, nextCursor: CURSOR }
		const appSpan = makeSpan({ spanId: "http-2", parentSpanId: "agent-1", startMs: 3 * SECOND, durationMs: 100, spanName: "GET /y", isAiSpan: false })
		// `http-1` comes back too — the first page already had it.
		fetchPage.mockResolvedValueOnce({ data: [firstPageSpans[2]!, appSpan], nextCursor: undefined })
		const { result } = renderHook(() => useSessionSpans("s1", undefined, reads))
		const turn = buildSessionTurns(firstPageSpans)[0]!

		expect(result.current.appSpans.of(turn)).toBeUndefined()
		act(() => result.current.appSpans.load(turn))
		expect(result.current.appSpans.of(turn)?.loading).toBe(true)
		await waitFor(() => expect(result.current.appSpans.of(turn)?.complete).toBe(true))

		const call = fetchPage.mock.calls[0]![0]
		expect(call).toMatchObject({ sessionId: "s1", scope: "app", traceIds: turn.traceIds, limit: 2000 })
		// A minute either side: the trace's opening span, parent of the turn's
		// root, started before the turn's first agent span.
		expect(call.startTime).toBe("2026-08-19 09:59:00")
		expect(call.endTime).toBe("2026-08-19 10:01:30")
		expect(result.current.appSpans.of(turn)?.loaded).toBe(2)
		expect(result.current.spans.map((span) => span.spanId)).toEqual(["agent-1", "llm-1", "http-1", "http-2"])
	})

	it("keeps a turn loadable when a page of its app spans failed", async () => {
		mocks.firstPage = { data: firstPageSpans, nextCursor: CURSOR }
		fetchPage.mockRejectedValueOnce(new Error("boom"))
		const { result } = renderHook(() => useSessionSpans("s1", undefined, reads))
		const turn = buildSessionTurns(firstPageSpans)[0]!

		act(() => result.current.appSpans.load(turn))
		await waitFor(() => expect(result.current.appSpans.of(turn)?.failed).toBe(true))
		expect(result.current.appSpans.of(turn)?.loading).toBe(false)
	})

	it("drops the pages of a read the window moved on from, and a response landing late", async () => {
		mocks.firstPage = { data: firstPageSpans, nextCursor: CURSOR }
		let resolveLate: (page: { data: readonly AiSessionSpan[]; nextCursor: undefined }) => void = () => undefined
		fetchPage
			.mockResolvedValueOnce({ data: secondPageSpans, nextCursor: CURSOR })
			.mockImplementationOnce(() => new Promise((resolve) => { resolveLate = resolve }))
		const early = { startTime: "2026-08-19 09:00:00", endTime: "2026-08-19 11:00:00" }
		const { result, rerender } = renderHook(({ window }) => useSessionSpans("s1", window, reads), {
			initialProps: { window: early },
		})

		act(() => result.current.loadMore())
		await waitFor(() => expect(result.current.spans).toHaveLength(5))
		// A second page is in flight when the window changes.
		act(() => result.current.loadMore())
		expect(result.current.loadingMore).toBe(true)
		rerender({ window: { startTime: "2026-08-19 08:00:00", endTime: "2026-08-19 12:00:00" } })

		expect(result.current.spans).toHaveLength(3)
		expect(result.current.loadingMore).toBe(false)
		await act(async () => {
			resolveLate({ data: [agentSpan({ spanId: "late", startMs: 0, durationMs: SECOND })], nextCursor: undefined })
		})
		expect(result.current.spans.map((span) => span.spanId)).not.toContain("late")
		expect(result.current.hasMore).toBe(true)
	})
})
