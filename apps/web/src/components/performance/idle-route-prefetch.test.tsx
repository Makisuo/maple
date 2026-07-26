// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mirrors the real router: `routesById` is keyed by route id, which keeps the
// trailing slash. (`routesByPath` trims it — indexing that with "/services/"
// is what silently returned undefined in production.)
const allRoutesById = (): Record<string, { id: string }> => ({
	"/": { id: "/" },
	"/services/": { id: "/services/" },
	"/traces/": { id: "/traces/" },
	"/logs/": { id: "/logs/" },
})

const router = vi.hoisted(() => ({
	state: { location: { pathname: "/" } },
	routesById: {} as Record<string, { id: string }>,
	loadRouteChunk: vi.fn(() => Promise.resolve()),
}))

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => router,
}))

import { IdleRoutePrefetch } from "./idle-route-prefetch"

describe("IdleRoutePrefetch", () => {
	const idleCallbacks: IdleRequestCallback[] = []

	beforeEach(() => {
		vi.useFakeTimers()
		router.loadRouteChunk.mockClear()
		router.routesById = allRoutesById()
		idleCallbacks.length = 0
		Object.defineProperty(window, "requestIdleCallback", {
			configurable: true,
			value: vi.fn((callback: IdleRequestCallback) => {
				idleCallbacks.push(callback)
				return idleCallbacks.length
			}),
		})
		Object.defineProperty(window, "cancelIdleCallback", {
			configurable: true,
			value: vi.fn(),
		})
		Object.defineProperty(navigator, "connection", {
			configurable: true,
			value: undefined,
		})
	})

	afterEach(() => {
		cleanup()
		vi.useRealTimers()
	})

	it("warms one inactive component chunk per idle window", async () => {
		render(<IdleRoutePrefetch />)

		await act(async () => vi.advanceTimersByTime(1_199))
		expect(router.loadRouteChunk).not.toHaveBeenCalled()

		await act(async () => vi.advanceTimersByTime(1))
		expect(idleCallbacks).toHaveLength(1)
		await act(async () => {
			idleCallbacks.shift()?.({ didTimeout: false, timeRemaining: () => 20 })
			await Promise.resolve()
		})
		expect(router.loadRouteChunk).toHaveBeenNthCalledWith(1, router.routesById["/services/"])

		await act(async () => vi.advanceTimersByTime(250))
		await act(async () => {
			idleCallbacks.shift()?.({ didTimeout: false, timeRemaining: () => 20 })
			await Promise.resolve()
		})
		expect(router.loadRouteChunk).toHaveBeenNthCalledWith(2, router.routesById["/traces/"])
	})

	it("keeps draining the queue when a route id no longer resolves", async () => {
		delete router.routesById["/services/"]
		render(<IdleRoutePrefetch />)

		await act(async () => vi.advanceTimersByTime(1_200))
		await act(async () => {
			idleCallbacks.shift()?.({ didTimeout: false, timeRemaining: () => 20 })
			await Promise.resolve()
		})
		expect(router.loadRouteChunk).not.toHaveBeenCalled()

		// The miss must reschedule, so the next route still gets warmed.
		await act(async () => vi.advanceTimersByTime(250))
		await act(async () => {
			idleCallbacks.shift()?.({ didTimeout: false, timeRemaining: () => 20 })
			await Promise.resolve()
		})
		expect(router.loadRouteChunk).toHaveBeenCalledExactlyOnceWith(router.routesById["/traces/"])
	})

	it("does no background work when Save-Data is enabled", async () => {
		Object.defineProperty(navigator, "connection", {
			configurable: true,
			value: { saveData: true },
		})
		render(<IdleRoutePrefetch />)

		await act(async () => vi.advanceTimersByTime(5_000))
		expect(window.requestIdleCallback).not.toHaveBeenCalled()
		expect(router.loadRouteChunk).not.toHaveBeenCalled()
	})
})
