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
	serviceNames: ["maple-slack-agent"],
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

	it("explains the retention cap instead of paging further", () => {
		const view = render(<AgentSessionsList sessions={[session]} isCapped />)
		expect(MockIntersectionObserver.instances).toHaveLength(0)
		expect(view.getByText(/Showing the 1 most recent sessions/)).toBeTruthy()
	})
})
