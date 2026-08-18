// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const EMAIL = "ada@example.com"

function makeUser(overrides: Record<string, unknown> = {}) {
	return {
		id: "user_1",
		firstName: "Ada",
		lastName: "Lovelace",
		fullName: "Ada Lovelace",
		imageUrl: "",
		hasImage: false,
		deleteSelfEnabled: true,
		primaryEmailAddress: { emailAddress: EMAIL },
		update: vi.fn().mockResolvedValue({}),
		setProfileImage: vi.fn().mockResolvedValue({}),
		delete: vi.fn().mockResolvedValue(undefined),
		...overrides,
	}
}

const signOut = vi.fn().mockResolvedValue(undefined)

async function mount(user: ReturnType<typeof makeUser>) {
	vi.doMock("@clerk/clerk-react", () => ({
		useUser: () => ({ user, isLoaded: true }),
		useClerk: () => ({ signOut }),
		// Production pass-through when the instance does not require reverification.
		useReverification: (fetcher: unknown) => fetcher,
	}))
	const { ProfileSection } = await import("./profile-section")
	render(<ProfileSection />)
}

describe("ProfileSection", () => {
	afterEach(() => {
		cleanup()
		vi.restoreAllMocks()
		vi.resetModules()
		signOut.mockClear()
	})

	it("keeps Save disabled until a name field is dirty", async () => {
		const user = makeUser()
		await mount(user)

		const save = screen.getByRole("button", { name: "Save" })
		expect(save.hasAttribute("disabled")).toBe(true)

		fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Grace" } })
		expect(save.hasAttribute("disabled")).toBe(false)
	}, 30_000)

	it("sends only the name fields to user.update", async () => {
		const user = makeUser()
		await mount(user)

		fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Grace" } })
		fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Hopper" } })
		fireEvent.click(screen.getByRole("button", { name: "Save" }))

		// Not the whole form: sending `primaryEmailAddressId` or an unrelated key here would
		// silently clobber state this section does not own.
		await waitFor(() =>
			expect(user.update).toHaveBeenCalledWith({ firstName: "Grace", lastName: "Hopper" }),
		)
	}, 30_000)

	it("holds account deletion until the confirm text matches the primary email", async () => {
		const user = makeUser()
		await mount(user)

		fireEvent.click(screen.getByRole("button", { name: "Delete account" }))

		const confirm = await screen.findByLabelText(/to confirm/)
		const action = screen.getAllByRole("button", { name: "Delete account" }).at(-1)
		if (!action) throw new Error("confirm button not rendered")

		expect(action.hasAttribute("disabled")).toBe(true)

		fireEvent.change(confirm, { target: { value: "not-the-email" } })
		expect(action.hasAttribute("disabled")).toBe(true)
		fireEvent.click(action)
		expect(user.delete).not.toHaveBeenCalled()

		fireEvent.change(confirm, { target: { value: EMAIL } })
		expect(action.hasAttribute("disabled")).toBe(false)
		fireEvent.click(action)
		await waitFor(() => expect(user.delete).toHaveBeenCalledTimes(1))
		// The session dies with the user; leaving it live would strand the app on a dead token.
		await waitFor(() => expect(signOut).toHaveBeenCalled())
	}, 30_000)

	it("hides the danger zone when the instance forbids self-deletion", async () => {
		await mount(makeUser({ deleteSelfEnabled: false }))
		expect(screen.queryByRole("button", { name: "Delete account" })).toBeNull()
	}, 30_000)
})
