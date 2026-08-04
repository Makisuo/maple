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
	userName: "",
	userEmail: "",
	groupId: "",
	groupName: "",
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
	recorded: "true",
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

// The list is virtualized against a scroll ancestor that jsdom gives zero
// height, so the real `useVirtualizer` yields no rows and nothing renders.
// Stub it to emit one row per session — that keeps the assertions on the
// component's actual row markup rather than an extracted helper.
vi.mock("@tanstack/react-virtual", () => ({
	useVirtualizer: ({ count }: { count: number }) => ({
		getVirtualItems: () =>
			Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 78 })),
		getTotalSize: () => count * 78,
		measureElement: () => {},
		options: { scrollMargin: 0 },
	}),
}))

describe("SessionsList recording badge", () => {
	afterEach(cleanup)

	it("flags a session the SDK marked as unrecorded", () => {
		const view = render(<SessionsList sessions={[{ ...session, recorded: "false" }]} />)
		// Rendered twice — the row carries a narrow-column badge strip and a wide
		// one, with CSS container queries picking which is visible.
		expect(view.getAllByText("Transcript only")).toHaveLength(2)
	})

	it("stays silent for a recorded session", () => {
		const view = render(<SessionsList sessions={[session]} />)
		expect(view.queryAllByText("Transcript only")).toHaveLength(0)
	})

	// Sessions written before the SDK stamped the marker read `""`. That is
	// "unknown", not "not recorded" — badging them would be a guess.
	it("stays silent when the marker is absent", () => {
		const view = render(<SessionsList sessions={[{ ...session, recorded: "" }]} />)
		expect(view.queryAllByText("Transcript only")).toHaveLength(0)
	})
})

// The browser SDK's identify() fills UserName / UserEmail / GroupId / GroupName.
// Sessions recorded before it existed carry "" in all four and must keep the
// original rendering — an opaque id over a mono session-id/host line.
describe("SessionsList identity", () => {
	afterEach(cleanup)

	const identified = {
		...session,
		userId: "user_42",
		userName: "Ada Lovelace",
		userEmail: "ada@acme.com",
		groupId: "acme",
		groupName: "Acme Inc",
	}

	it("prefers the name over the raw user id", () => {
		const view = render(<SessionsList sessions={[identified]} />)
		expect(view.getByText("Ada Lovelace")).toBeTruthy()
		expect(view.queryByText("user_42")).toBeNull()
	})

	it("puts email and group on the second line, keeping the session id on hover", () => {
		const view = render(<SessionsList sessions={[identified]} />)
		const line = view.getByText("ada@acme.com · Acme Inc")
		// Prose, not the mono session-id line it replaces.
		expect(line.className).not.toContain("font-mono")
		expect(line.getAttribute("title")).toBe("session- · example.com")
	})

	it("falls back to the email when there is no name", () => {
		const view = render(<SessionsList sessions={[{ ...identified, userName: "" }]} />)
		expect(view.getByText("ada@acme.com")).toBeTruthy()
		// Don't repeat the label directly beneath itself.
		expect(view.getByText("Acme Inc")).toBeTruthy()
	})

	it("renders a pre-identify session exactly as before", () => {
		const view = render(<SessionsList sessions={[{ ...session, userId: "user_42" }]} />)
		expect(view.getByText("user_42")).toBeTruthy()
		const line = view.getByText("session- · example.com")
		expect(line.className).toContain("font-mono")
		expect(line.getAttribute("title")).toBeNull()
	})

	it("still says Anonymous when nothing identifies the session", () => {
		const view = render(<SessionsList sessions={[session]} />)
		expect(view.getByText("Anonymous")).toBeTruthy()
	})
})
