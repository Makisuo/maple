// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const address = (id: string, emailAddress: string, status: string) => ({
	id,
	emailAddress,
	verification: { status },
	destroy: vi.fn().mockResolvedValue(undefined),
	prepareVerification: vi.fn().mockResolvedValue(undefined),
	attemptVerification: vi.fn().mockResolvedValue(undefined),
})

async function mount(user: Record<string, unknown>) {
	vi.doMock("@clerk/clerk-react", () => ({
		useUser: () => ({ user, isLoaded: true }),
		useReverification: (fetcher: unknown) => fetcher,
	}))
	const { EmailAddressesSection } = await import("./email-addresses-section")
	render(<EmailAddressesSection />)
}

describe("EmailAddressesSection", () => {
	afterEach(() => {
		cleanup()
		vi.restoreAllMocks()
		vi.resetModules()
	})

	it("sets the primary address on the user, not on the address resource", async () => {
		const primary = address("idn_1", "ada@example.com", "verified")
		const secondary = address("idn_2", "grace@example.com", "verified")
		const user = {
			id: "user_1",
			primaryEmailAddressId: "idn_1",
			emailAddresses: [primary, secondary],
			update: vi.fn().mockResolvedValue({}),
		}
		await mount(user)

		// Only the non-primary verified row offers the action, so this is unambiguous.
		fireEvent.click(screen.getAllByRole("button", { name: "" }).at(-1) ?? document.body)
		fireEvent.click(await screen.findByText("Set as primary"))

		// Clerk has no `emailAddress.setPrimary()`; the id goes up to `user.update`.
		await waitFor(() => expect(user.update).toHaveBeenCalledWith({ primaryEmailAddressId: "idn_2" }))
	}, 30_000)

	it("never offers to remove the only verified address", async () => {
		const only = address("idn_1", "ada@example.com", "verified")
		await mount({
			id: "user_1",
			primaryEmailAddressId: "idn_1",
			emailAddresses: [only],
			update: vi.fn(),
		})

		fireEvent.click(screen.getAllByRole("button", { name: "" })[0] ?? document.body)
		const remove = await screen.findByText("Remove")
		// Clerk requires one verified address; an enabled control here would only ever 4xx.
		expect(remove.closest("[data-disabled], [aria-disabled='true']")).not.toBeNull()
	}, 30_000)
})
