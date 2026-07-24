// @vitest-environment jsdom

import { Registry, RegistryContext } from "@/lib/effect-atom"
import { cleanup, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ReplayPlayerProvider } from "./replay-player-context"
import { ReplaySurface, ReplayTransport } from "./replay-player"

// What the surface says when there is nothing to play. Getting this wrong sends
// the reader to a scrubber that will never move, so each unplayable state must
// name its own cause — and the "never recorded" one must drop the transport
// entirely rather than offer dead controls.

vi.mock("@rrweb/replay", () => ({ Replayer: class {} }))
vi.mock("@rrweb/replay/dist/style.css", () => ({}))
vi.mock("@/hooks/use-replay-keyboard-shortcuts", () => ({
	useReplayKeyboardShortcuts: () => {},
}))

/** Render the surface + detached transport through the provider's preview path,
 *  which bypasses the warehouse fetch entirely. */
function renderSurface(props: { recorded?: boolean; sessionActive?: boolean }) {
	const registry = Registry.make()
	const Wrapper = ({ children }: { children: ReactNode }) => (
		<RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
	)
	return render(
		<Wrapper>
			<ReplayPlayerProvider
				sessionId="sess-1"
				previewEvents={[]}
				recorded={props.recorded}
				sessionActive={props.sessionActive ?? false}
			>
				<ReplaySurface url="https://app.example.com/dashboard" detachedTransport />
				<ReplayTransport />
			</ReplayPlayerProvider>
		</Wrapper>,
	)
}

describe("ReplaySurface unplayable states", () => {
	afterEach(cleanup)

	it("explains a session the SDK marked as never recorded", () => {
		const view = renderSurface({ recorded: false })
		expect(view.getByText(/wasn’t recorded/)).toBeTruthy()
		expect(view.queryByText(/Recording in progress/)).toBeNull()
	})

	it("drops the transport for a never-recorded session", () => {
		const view = renderSurface({ recorded: false })
		// The scrubber and the speed control both belong to the transport.
		expect(view.queryByLabelText("Seek")).toBeNull()
		expect(view.queryByText("Skip idle")).toBeNull()
	})

	it("says frames are still arriving while the session is open", () => {
		const view = renderSurface({ recorded: true, sessionActive: true })
		expect(view.getByText(/Recording in progress/)).toBeTruthy()
		expect(view.queryByText(/wasn’t recorded/)).toBeNull()
	})

	it("keeps the transport for a recording that is merely too short", () => {
		const view = renderSurface({ recorded: true, sessionActive: false })
		expect(view.getByText(/too short to play back/)).toBeTruthy()
		// A recording exists here, so the controls stay.
		expect(view.queryByLabelText("Seek")).not.toBeNull()
	})
})
