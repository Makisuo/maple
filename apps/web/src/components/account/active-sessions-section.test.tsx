// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const session = (id: string, isMobile: boolean) => ({
	id,
	status: "active",
	lastActiveAt: new Date("2026-08-07T12:00:00Z"),
	latestActivity: {
		id: `act_${id}`,
		browserName: "Chrome",
		browserVersion: "140",
		deviceType: isMobile ? "iPhone" : "Macbook Pro",
		city: "Berlin",
		country: "DE",
		isMobile,
	},
	revoke: vi.fn().mockResolvedValue(undefined),
})

describe("ActiveSessionsSection", () => {
	afterEach(() => {
		cleanup()
		vi.restoreAllMocks()
		vi.resetModules()
	})

	it("marks the current session and gives it no Sign out control", async () => {
		const current = session("sess_current", false)
		const other = session("sess_other", true)
		vi.doMock("@clerk/clerk-react", () => ({
			useUser: () => ({
				user: { id: "user_1", getSessions: vi.fn().mockResolvedValue([current, other]) },
				isLoaded: true,
			}),
			useSession: () => ({ session: { id: "sess_current" } }),
			useReverification: (fetcher: unknown) => fetcher,
		}))

		const { ActiveSessionsSection } = await import("./active-sessions-section")
		render(<ActiveSessionsSection />)

		expect(await screen.findByText("This device")).toBeTruthy()
		// Exactly one row is revocable: revoking the current session from inside the page would
		// sign the user out of the very tab they are using.
		expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(1)
	}, 30_000)
})
