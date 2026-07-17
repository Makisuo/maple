// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionsList, type SessionRow } from "./sessions-list"

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }))

const session: SessionRow = {
	sessionId: "session-1",
	startTime: "2026-07-17 12:00:00",
	durationMs: 1000,
	status: "ended",
	userId: null,
	urlInitial: "https://example.com",
	browserName: "Chrome",
	osName: "macOS",
	deviceType: "desktop",
	country: "DE",
	serviceName: "web",
	pageViews: 1,
	clickCount: 1,
	errorCount: 0,
	traceCount: 1,
}

class MockIntersectionObserver {
	static instances: MockIntersectionObserver[] = []
	readonly observe = vi.fn()
	readonly disconnect = vi.fn()

	constructor(readonly callback: IntersectionObserverCallback) {
		MockIntersectionObserver.instances.push(this)
	}
}

describe("SessionsList pagination observer", () => {
	beforeEach(() => {
		MockIntersectionObserver.instances = []
		vi.stubGlobal("IntersectionObserver", MockIntersectionObserver)
	})

	afterEach(() => {
		cleanup()
		vi.unstubAllGlobals()
	})

	it("disconnects and replaces the observer when pagination state changes", () => {
		const onReachEnd = vi.fn()
		const view = render(
			<SessionsList sessions={[session]} hasMore onReachEnd={onReachEnd} loadingMore={false} />,
		)

		const first = MockIntersectionObserver.instances[0]!
		expect(first.observe).toHaveBeenCalledOnce()
		first.callback([{ isIntersecting: true } as IntersectionObserverEntry], first as never)
		expect(onReachEnd).toHaveBeenCalledOnce()

		view.rerender(<SessionsList sessions={[session]} hasMore onReachEnd={onReachEnd} loadingMore />)
		expect(first.disconnect).toHaveBeenCalledOnce()

		const second = MockIntersectionObserver.instances[1]!
		second.callback([{ isIntersecting: true } as IntersectionObserverEntry], second as never)
		expect(onReachEnd).toHaveBeenCalledOnce()

		view.unmount()
		expect(second.disconnect).toHaveBeenCalledOnce()
	})
})
