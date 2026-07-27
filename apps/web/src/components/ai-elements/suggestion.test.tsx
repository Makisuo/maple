// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { Suggestion } from "./suggestion"

afterEach(() => {
	cleanup()
})

const LONG =
	"Diagnose subscriptions-api public endpoints (GET /public/v1/users/:appUserIdOrDeviceId/entitlements)"

/**
 * A class-contract test, not a layout one — jsdom applies no stylesheet, so it
 * cannot measure the overflow this guards against (the browser pass does that).
 * What it can pin is the combination that caused it: `whitespace-normal` lets
 * text wrap, `buttonVariants({size:"sm"})` pins the pill to `sm:h-7`, and
 * `twMerge` cannot reconcile the two because they are different modifier groups.
 * Reintroducing either half fails here.
 */
describe("Suggestion", () => {
	it("never lets its text wrap", () => {
		render(<Suggestion suggestion={LONG} />)
		const pill = screen.getByRole("button")
		expect(pill.className).not.toContain("whitespace-normal")
		expect(pill.className).not.toContain("h-auto")
	})

	it("truncates the label rather than growing the pill", () => {
		render(<Suggestion suggestion={LONG} />)
		const label = screen.getByText(LONG)
		expect(label.className).toContain("truncate")
		expect(label.className).toContain("min-w-0")
	})

	it("keeps the full text reachable when it truncates", () => {
		render(<Suggestion suggestion={LONG} />)
		expect(screen.getByRole("button").getAttribute("title")).toBe(LONG)
	})

	it("leaves the title off when the caller supplies its own label", () => {
		render(<Suggestion suggestion={LONG}>Short label</Suggestion>)
		expect(screen.getByRole("button").getAttribute("title")).toBeNull()
	})
})
