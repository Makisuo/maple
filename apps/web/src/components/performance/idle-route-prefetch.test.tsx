// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({
	state: { location: { pathname: "/" } },
	routesByPath: {
		"/": { id: "/" },
		"/services/": { id: "/services/" },
		"/traces/": { id: "/traces/" },
		"/logs/": { id: "/logs/" },
	},
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
		expect(router.loadRouteChunk).toHaveBeenNthCalledWith(1, router.routesByPath["/services/"])

		await act(async () => vi.advanceTimersByTime(250))
		await act(async () => {
			idleCallbacks.shift()?.({ didTimeout: false, timeRemaining: () => 20 })
			await Promise.resolve()
		})
		expect(router.loadRouteChunk).toHaveBeenNthCalledWith(2, router.routesByPath["/traces/"])
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
