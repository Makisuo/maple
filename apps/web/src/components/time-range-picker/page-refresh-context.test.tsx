// @vitest-environment jsdom

import { Atom, Registry, RegistryContext, Result } from "@/lib/effect-atom"
import { Effect } from "effect"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"

import {
	LIVE_REFRESH_INTERVAL_MS,
	PageRefreshProvider,
	resolveRelativeRefreshRange,
	usePageRefreshContext,
} from "./page-refresh-context"

function createWrapper() {
	const registry = Registry.make()

	return function Wrapper({ children }: { children: ReactNode }) {
		return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
	}
}

function makeCounterAtom(counter: { current: number }) {
	return Atom.make(
		Effect.sync(() => {
			counter.current += 1
			return counter.current
		}),
	)
}

function Controls() {
	const { liveEnabled, reload, setLiveEnabled } = usePageRefreshContext()

	return (
		<div>
			<button onClick={reload}>reload</button>
			<button onClick={() => setLiveEnabled((current) => !current)}>
				{liveEnabled ? "live-on" : "live-off"}
			</button>
		</div>
	)
}

function Probe({ atom, label }: { atom: Atom.Atom<Result.Result<number, never>>; label: string }) {
	const value = useRefreshableAtomValue(atom)

	return (
		<div data-testid={label}>
			{Result.builder(value)
				.onSuccess((next) => String(next))
				.orElse(() => "initial")}
		</div>
	)
}

function Harness({
	timePreset,
	onRelativeRangeRefresh,
}: {
	timePreset?: string
	onRelativeRangeRefresh?: (range: { startTime: string; endTime: string; presetValue: string }) => void
}) {
	const counterA = { current: 0 }
	const counterB = { current: 0 }
	const atomA = makeCounterAtom(counterA)
	const atomB = makeCounterAtom(counterB)

	return (
		<PageRefreshProvider timePreset={timePreset} onRelativeRangeRefresh={onRelativeRangeRefresh}>
			<Controls />
			<Probe atom={atomA} label="a" />
			<Probe atom={atomB} label="b" />
		</PageRefreshProvider>
	)
}

function setVisibilityState(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => state,
	})

	document.dispatchEvent(new Event("visibilitychange"))
}

async function flushRefresh() {
	await act(async () => {
		await Promise.resolve()
	})
}

describe("page refresh controller", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"))
		setVisibilityState("visible")
	})

	afterEach(() => {
		cleanup()
		vi.useRealTimers()
		vi.restoreAllMocks()
		setVisibilityState("visible")
	})

	it("reloads multiple refresh-aware atoms on manual reload", async () => {
		render(<Harness />, { wrapper: createWrapper() })

		expect(screen.getByTestId("a").textContent).toBe("1")
		expect(screen.getByTestId("b").textContent).toBe("1")

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "reload" }))
		})

		await flushRefresh()

		expect(screen.getByTestId("a").textContent).toBe("2")
		expect(screen.getByTestId("b").textContent).toBe("2")
	})

	it("rebases relative presets on reload", () => {
		expect(resolveRelativeRefreshRange("15m")).toEqual({
			startTime: "2026-03-10 11:45:00",
			endTime: "2026-03-10 12:00:00",
			presetValue: "15m",
		})
	})

	it("does not invoke relative refresh callback for absolute ranges", async () => {
		const onRelativeRangeRefresh = vi.fn()

		render(<Harness onRelativeRangeRefresh={onRelativeRangeRefresh} />, {
			wrapper: createWrapper(),
		})

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "reload" }))
		})

		await flushRefresh()

		expect(screen.getByTestId("a").textContent).toBe("2")

		expect(onRelativeRangeRefresh).not.toHaveBeenCalled()
	})

	it("polls every 10 seconds in live mode, pauses when hidden, and refreshes on resume", async () => {
		render(<Harness timePreset="15m" />, { wrapper: createWrapper() })

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "live-off" }))
		})

		await act(async () => {
			vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS)
		})

		await flushRefresh()

		expect(screen.getByTestId("a").textContent).toBe("2")
		expect(screen.getByTestId("b").textContent).toBe("2")

		await act(async () => {
			setVisibilityState("hidden")
		})

		await flushRefresh()

		await act(async () => {
			vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS * 2)
		})

		await flushRefresh()

		expect(screen.getByTestId("a").textContent).toBe("2")
		expect(screen.getByTestId("b").textContent).toBe("2")

		await act(async () => {
			setVisibilityState("visible")
		})

		await flushRefresh()

		expect(screen.getByTestId("a").textContent).toBe("3")
		expect(screen.getByTestId("b").textContent).toBe("3")
	})
})
