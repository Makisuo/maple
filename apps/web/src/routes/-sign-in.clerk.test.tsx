// @vitest-environment jsdom

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

		// SignInPage reads redirect_url via Route.useSearch(), which needs a live
		// router — stub it since this test renders the page standalone.
		vi.spyOn(module.Route, "useSearch").mockReturnValue({ redirect_url: undefined })

		render(<module.SignInPage />)

		expect(screen.getByText("Clerk Sign In")).toBeTruthy()
	})
})
