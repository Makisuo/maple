// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AgentSessionsList, type AgentSessionRow } from "./agent-sessions-list"

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
		<a {...(props as Record<string, string>)}>{children}</a>
	),
}))

const session: AgentSessionRow = {
	sessionId: "wrun_01M0CSAEW96BH2W9185XZPRPKH",
	vendorId: "eve",
	vendorVersion: "1",
	traceCount: 2,
	spanCount: 12,
	errorSpanCount: 0,
	toolErrorCount: 0,
	turnErrorCount: 0,
	serviceNames: ["maple-slack-agent"],
	models: ["claude-sonnet-5"],
	agentNames: ["slack-agent"],
	llmCalls: 4,
	toolCalls: 2,
	totalTokens: 18_400,
	inputTokens: 12_000,
	cacheReadTokens: 4_000,
	cacheWriteTokens: 0,
	outputTokens: 2_000,
	reasoningTokens: 400,
	cost: 0.12,
	startTime: "2026-08-19 10:33:25.825000000",
	endTime: "2026-08-19 10:34:25.825000000",
	durationMs: 60_000,
}

class MockIntersectionObserver {
	static instances: MockIntersectionObserver[] = []
	readonly observe = vi.fn()
	readonly disconnect = vi.fn()

	constructor(readonly callback: IntersectionObserverCallback) {
		MockIntersectionObserver.instances.push(this)
	}
}

describe("AgentSessionsList pagination observer", () => {
	beforeEach(() => {
		MockIntersectionObserver.instances = []
		vi.stubGlobal("IntersectionObserver", MockIntersectionObserver)
	})

	afterEach(() => {
		cleanup()
		vi.unstubAllGlobals()
	})

	it("asks for the next page when the sentinel comes into view, but not while one is in flight", () => {
		const onReachEnd = vi.fn()
		const view = render(
			<AgentSessionsList sessions={[session]} hasMore onReachEnd={onReachEnd} loadingMore={false} />,
		)

		const first = MockIntersectionObserver.instances[0]!
		expect(first.observe).toHaveBeenCalledOnce()
		first.callback([{ isIntersecting: true } as IntersectionObserverEntry], first as never)
		expect(onReachEnd).toHaveBeenCalledOnce()

		view.rerender(<AgentSessionsList sessions={[session]} hasMore onReachEnd={onReachEnd} loadingMore />)
		expect(first.disconnect).toHaveBeenCalledOnce()
		expect(view.getByText("Loading more sessions…")).toBeTruthy()

		const second = MockIntersectionObserver.instances[1]!
		second.callback([{ isIntersecting: true } as IntersectionObserverEntry], second as never)
		expect(onReachEnd).toHaveBeenCalledOnce()

		view.unmount()
		expect(second.disconnect).toHaveBeenCalledOnce()
	})

	it("renders no sentinel once the backend has no more pages", () => {
		render(<AgentSessionsList sessions={[session]} hasMore={false} />)
		expect(MockIntersectionObserver.instances).toHaveLength(0)
	})

	it("names the framework by its mark alone, and splits the failures by kind", () => {
		const view = render(
			<AgentSessionsList
				sessions={[
					{
						...session,
						vendorVersion: "2.4.0",
						errorSpanCount: 5,
						toolErrorCount: 2,
						turnErrorCount: 1,
					},
				]}
			/>,
		)
		// The version is the only text under the id; the name lives in the title.
		expect(view.getAllByText("v2.4.0")).toHaveLength(1)
		expect(view.queryByText(/^eve/)).toBeNull()
		expect(view.getByTitle("eve v2.4.0")).toBeTruthy()
		// Two chips in two tones — one per lane that shows them (phone + desktop).
		expect(view.getAllByText("2 tool errors")).toHaveLength(2)
		expect(view.getAllByText("1 turn error")).toHaveLength(2)
		// The buckets are the bar's title (one per line; the matcher collapses
		// whitespace), the total the text beside it.
		expect(view.getByTitle(/18,400 tokens Input: 12,000 Cache read: 4,000/)).toBeTruthy()
		expect(view.getByText("18.4k tok")).toBeTruthy()
	})

	it("explains the retention cap instead of paging further", () => {
		const view = render(<AgentSessionsList sessions={[session]} isCapped />)
		expect(MockIntersectionObserver.instances).toHaveLength(0)
		expect(view.getByText(/Showing the 1 most recent sessions/)).toBeTruthy()
	})
})
