// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

import { Registry, RegistryContext } from "@/lib/effect-atom"
import { cleanup, fireEvent, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ReplayPlayerProvider } from "./replay-player-context"
import { ReplaySurface } from "./replay-player"

const REPLAY_EVENTS = [{ timestamp: 1_000 }, { timestamp: 31_000 }]

// The offset the transport hands rrweb's `play()`.
//
// rrweb's player context starts at `baselineTime: 0`, so `getCurrentTime()`
// reports `-events[0].timestamp` — a negative epoch, roughly -55 years — until
// something drives the engine. Passing that straight back into `play()` re-bases
// the whole stream decades into the future, so no event ever casts: the button
// flips to "pause", the frame never moves, and only a scrub (which clamps into
// [0, total]) un-sticks it. `FakeReplayer` reproduces that clock exactly so the
// regression can't come back.

interface TimedEvent {
	timestamp: number
}

// Hoisted alongside `vi.mock` so the factory below can reach it.
const { FakeReplayer } = vi.hoisted(() => {
	class FakeReplayer {
		static instances: FakeReplayer[] = []

		readonly events: ReadonlyArray<TimedEvent>
		/** Mirrors rrweb: only `play(offset)` / `pause(offset)` ever assign this. */
		baselineTime = 0
		/** Mirrors rrweb's `Timer.timeOffset`, advanced by its rAF loop. */
		timerOffset = 0
		readonly playCalls: number[] = []
		readonly pauseCalls: Array<number | undefined> = []
		readonly iframe: null = null
		readonly wrapper = { style: {} as Record<string, string> }

		constructor(events: ReadonlyArray<TimedEvent>) {
			this.events = events
			FakeReplayer.instances.push(this)
		}

		getMetaData() {
			const first = this.events[0].timestamp
			const last = this.events[this.events.length - 1].timestamp
			return { startTime: first, endTime: last, totalTime: last - first }
		}

		getCurrentTime(): number {
			return this.timerOffset + (this.baselineTime - this.events[0].timestamp)
		}

		play(offset = 0): void {
			this.playCalls.push(offset)
			this.baselineTime = this.events[0].timestamp + offset
			this.timerOffset = 0
		}

		pause(offset?: number): void {
			this.pauseCalls.push(offset)
			if (typeof offset === "number") {
				this.baselineTime = this.events[0].timestamp + offset
				this.timerOffset = 0
			}
		}

		on(): this {
			return this
		}
		setConfig(): void {}
		destroy(): void {}

		/** Test-only: advance the engine clock the way rrweb's timer rAF does. */
		advance(ms: number): void {
			this.timerOffset += ms
		}
	}
	return { FakeReplayer }
})

vi.mock("@rrweb/replay", () => ({ Replayer: FakeReplayer }))
vi.mock("@rrweb/replay/dist/style.css", () => ({}))
vi.mock("@/hooks/use-replay-keyboard-shortcuts", () => ({
	useReplayKeyboardShortcuts: () => {},
}))

function renderPlayer() {
	const registry = Registry.make()
	const Wrapper = ({ children }: { children: ReactNode }) => (
		<RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
	)
	const view = render(
		<Wrapper>
			<ReplayPlayerProvider sessionId="sess-1" eventsOverride={REPLAY_EVENTS} recorded>
				<ReplaySurface url="https://app.acme.dev/dashboard" />
			</ReplayPlayerProvider>
		</Wrapper>,
	)
	const engine = FakeReplayer.instances[FakeReplayer.instances.length - 1]
	return { view, engine }
}

describe("replay transport", () => {
	beforeEach(() => {
		FakeReplayer.instances.length = 0
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
		// The provider polls the engine clock on rAF while playing. Silencing the
		// loop keeps `playCalls` to exactly what the transport issued.
		vi.stubGlobal("requestAnimationFrame", () => 0)
		vi.stubGlobal("cancelAnimationFrame", () => {})
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		cleanup()
	})

	it("starts the first press at the top of the recording", () => {
		const { view, engine } = renderPlayer()

		fireEvent.click(view.getByLabelText("Play"))

		// Not `-events[0].timestamp`: the engine has never been driven, so there is
		// no position to resume from.
		expect(engine.playCalls).toEqual([0])
	})

	it("never hands rrweb an offset outside the recording", () => {
		const { view, engine } = renderPlayer()
		const { totalTime } = engine.getMetaData()

		fireEvent.click(view.getByLabelText("Play"))

		for (const offset of engine.playCalls) {
			expect(offset).toBeGreaterThanOrEqual(0)
			expect(offset).toBeLessThanOrEqual(totalTime)
		}
	})

	it("resumes from where it was paused", () => {
		const { view, engine } = renderPlayer()

		fireEvent.click(view.getByLabelText("Play"))
		engine.advance(8_000)
		fireEvent.click(view.getByLabelText("Pause"))
		fireEvent.click(view.getByLabelText("Play"))

		expect(engine.playCalls).toEqual([0, 8_000])
	})
})
