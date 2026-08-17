// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

import { Registry, RegistryContext } from "@/lib/effect-atom"
import { cleanup, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ReplayPlayerProvider } from "./replay-player-context"
import { ReplaySurface } from "./replay-player"

// The engine is mounted in an effect keyed on the seed `events` array, so that
// array's IDENTITY is load-bearing, not just its contents: a fresh array tears
// the engine down and builds a new one.
//
// The status memo that produces `events` depends on the manifest result, which
// changes on every refetch. Building the array inside that memo — a
// `normalizeEvents(...)` call, or a `[...loader.seedEvents]` spread — therefore
// rebuilds the engine every few seconds on a live session. On rrweb that showed
// up as an iframe flash and the playhead snapping to 0; on the video engine it
// killed playback outright (verified in a real browser: `VideoEngine.destroy`
// fired ~1.3s into playback and the recording never resumed).
//
// `sessionActive` stands in for that churn here: it is a dependency of the same
// memo but cannot change the outcome, so a rebuild triggered by flipping it is
// unambiguously an identity bug rather than a real seed change.

const REPLAY_EVENTS = [{ timestamp: 1_000 }, { timestamp: 31_000 }]

const { FakeReplayer } = vi.hoisted(() => {
	class FakeReplayer {
		static instances: FakeReplayer[] = []
		readonly iframe: null = null
		readonly wrapper = { style: {} as Record<string, string> }
		constructor() {
			FakeReplayer.instances.push(this)
		}
		getMetaData() {
			return { startTime: 0, endTime: 30_000, totalTime: 30_000 }
		}
		getCurrentTime() {
			return 0
		}
		play() {}
		pause() {}
		addEvent() {}
		on() {
			return this
		}
		setConfig() {}
		destroy() {}
	}
	return { FakeReplayer }
})

vi.mock("@rrweb/replay", () => ({ Replayer: FakeReplayer }))
vi.mock("@rrweb/replay/dist/style.css", () => ({}))
vi.mock("@/hooks/use-replay-keyboard-shortcuts", () => ({ useReplayKeyboardShortcuts: () => {} }))

function Harness({ sessionActive }: { sessionActive: boolean }) {
	return (
		<ReplayPlayerProvider
			sessionId="sess-1"
			eventsOverride={REPLAY_EVENTS}
			recorded
			sessionActive={sessionActive}
		>
			<ReplaySurface url="https://app.acme.dev/dashboard" />
		</ReplayPlayerProvider>
	)
}

describe("replay engine mount stability", () => {
	beforeEach(() => {
		FakeReplayer.instances.length = 0
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
		vi.stubGlobal("requestAnimationFrame", () => 0)
		vi.stubGlobal("cancelAnimationFrame", () => {})
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		cleanup()
	})

	it("builds the engine once and keeps it across unrelated re-renders", () => {
		const registry = Registry.make()
		const Wrapper = ({ children }: { children: ReactNode }) => (
			<RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
		)

		const view = render(
			<Wrapper>
				<Harness sessionActive={false} />
			</Wrapper>,
		)
		expect(FakeReplayer.instances).toHaveLength(1)

		// Recompute the status memo without changing what it resolves to. The seed
		// is the same events array, so the engine must survive.
		view.rerender(
			<Wrapper>
				<Harness sessionActive />
			</Wrapper>,
		)
		expect(FakeReplayer.instances).toHaveLength(1)

		view.rerender(
			<Wrapper>
				<Harness sessionActive={false} />
			</Wrapper>,
		)
		expect(FakeReplayer.instances).toHaveLength(1)
	})
})
