// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

describe("SignInPage (clerk mode)", () => {
	afterEach(() => {
		cleanup()
		vi.restoreAllMocks()
		vi.resetModules()
	})

	it("renders Clerk sign-in when Clerk auth mode is enabled", async () => {
		vi.doMock("@/lib/services/common/auth-mode", () => ({
			isClerkAuthEnabled: true,
		}))
		vi.doMock("@clerk/clerk-react", () => ({
			SignIn: () => <div>Clerk Sign In</div>,
		}))

		const module = await import("./sign-in")
		const { component: SignInPage } = await import("./sign-in?tsr-split=component")

		// SignInPage reads redirect_url via Route.useSearch(), which needs a live
		// router — stub it since this test renders the page standalone.
		vi.spyOn(module.Route, "useSearch").mockReturnValue({ redirect_url: undefined })

		render(<SignInPage />)

		expect(screen.getByText("Clerk Sign In")).toBeTruthy()
		// The two dynamic imports pull the route's whole module graph in cold, which
		// overruns the 5s default when the suite shares the machine with turbo's
		// typecheck/build tasks.
	}, 30_000)
})
