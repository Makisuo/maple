// @vitest-environment jsdom

import { Atom, Registry, RegistryContext, Result } from "@/lib/effect-atom"
import { Effect } from "effect"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useMountEffect } from "@/hooks/use-mount-effect"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"

import {
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
	const { reload } = usePageRefreshContext()

	return (
		<div>
			<button onClick={reload}>reload</button>
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
	// Atoms must be created once per Harness instance, not on every render —
	// calling `makeCounterAtom` (which calls `Atom.make`) in the component body
	// would mint a fresh atom each render and lose its state. `useState`'s lazy
	// initializer runs exactly once per mount, giving each Harness stable atoms.
	const [atomA] = useState(() => makeCounterAtom({ current: 0 }))
	const [atomB] = useState(() => makeCounterAtom({ current: 0 }))

	return (
		<PageRefreshProvider timePreset={timePreset} onRelativeRangeRefresh={onRelativeRangeRefresh}>
			<Controls />
			<Probe atom={atomA} label="a" />
			<Probe atom={atomB} label="b" />
		</PageRefreshProvider>
	)
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
	})

	afterEach(() => {
		cleanup()
		vi.useRealTimers()
		vi.restoreAllMocks()
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
})

/**
 * Stands in for a widget: every tile subscribes through
 * `useRefreshableAtomValue`, so counting listener calls counts canvas refreshes.
 */
function Subscriber({ onReload }: { onReload: () => void }) {
	const { subscribeReload } = usePageRefreshContext()
	// Mount-scoped rather than render-time: subscribing during render would
	// double-add under StrictMode with no matching cleanup.
	useMountEffect(() => subscribeReload(onReload))
	return null
}

function AutoRefreshHarness({
	onReload,
	autoRefreshMs,
	autoRefreshPaused,
}: {
	onReload: () => void
	autoRefreshMs?: number
	autoRefreshPaused?: boolean
}) {
	return (
		<PageRefreshProvider autoRefreshMs={autoRefreshMs} autoRefreshPaused={autoRefreshPaused}>
			<Subscriber onReload={onReload} />
		</PageRefreshProvider>
	)
}

describe("page refresh auto-refresh", () => {
	beforeEach(() => vi.useFakeTimers())

	afterEach(() => {
		cleanup()
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("fans a tick out to every subscriber on the configured cadence", () => {
		const onReload = vi.fn()
		render(<AutoRefreshHarness onReload={onReload} autoRefreshMs={5_000} />)

		act(() => vi.advanceTimersByTime(5_000))
		expect(onReload).toHaveBeenCalledTimes(1)

		act(() => vi.advanceTimersByTime(10_000))
		expect(onReload).toHaveBeenCalledTimes(3)
	})

	// `0`/absent is the off sentinel every non-dashboard page relies on; it must
	// register no interval at all rather than a `setInterval(…, 0)` hot loop.
	it("registers no timer when the cadence is absent or zero", () => {
		const onReload = vi.fn()
		render(<AutoRefreshHarness onReload={onReload} />)
		act(() => vi.advanceTimersByTime(60_000))
		expect(onReload).not.toHaveBeenCalled()

		cleanup()
		render(<AutoRefreshHarness onReload={onReload} autoRefreshMs={0} />)
		act(() => vi.advanceTimersByTime(60_000))
		expect(onReload).not.toHaveBeenCalled()
	})

	// Editing a dashboard or previewing a version suspends the timer without
	// forgetting the cadence, so leaving that state resumes at the same interval.
	it("suspends while paused and resumes on the same cadence", () => {
		const onReload = vi.fn()
		const view = render(
			<AutoRefreshHarness onReload={onReload} autoRefreshMs={5_000} autoRefreshPaused />,
		)

		act(() => vi.advanceTimersByTime(20_000))
		expect(onReload).not.toHaveBeenCalled()

		view.rerender(
			<AutoRefreshHarness onReload={onReload} autoRefreshMs={5_000} autoRefreshPaused={false} />,
		)
		act(() => vi.advanceTimersByTime(5_000))
		expect(onReload).toHaveBeenCalledTimes(1)
	})
})
