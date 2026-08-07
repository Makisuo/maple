// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const BACKUP_CODES = ["11112222", "33334444", "55556666"]

async function mount(user: Record<string, unknown>) {
	vi.doMock("@clerk/clerk-react", () => ({
		useUser: () => ({ user, isLoaded: true }),
		useReverification: (fetcher: unknown) => fetcher,
	}))
	const { TwoFactorSection } = await import("./two-factor-section")
	render(<TwoFactorSection />)
}

describe("TwoFactorSection", () => {
	afterEach(() => {
		cleanup()
		vi.restoreAllMocks()
		vi.resetModules()
	})

	it("shows every backup code returned by verifyTOTP", async () => {
		const user = {
			id: "user_1",
			totpEnabled: false,
			backupCodeEnabled: false,
			createTOTP: vi.fn().mockResolvedValue({
				uri: "otpauth://totp/Maple:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Maple",
				secret: "JBSWY3DPEHPK3PXP",
			}),
			verifyTOTP: vi.fn().mockResolvedValue({ verified: true, backupCodes: BACKUP_CODES }),
		}
		await mount(user)

		fireEvent.click(screen.getByRole("button", { name: /Set up authenticator/ }))
		await screen.findByText("Scan this code")
		fireEvent.click(screen.getByRole("button", { name: "Continue" }))
		await screen.findByText("Enter the code")

		const inputs = screen.getAllByLabelText(/Digit \d of 6/)
		fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: "123456" } })

		await waitFor(() => expect(user.verifyTOTP).toHaveBeenCalledWith({ code: "123456" }))

		// Backup codes are shown exactly once and are never retrievable again, so dropping even
		// one of them is unrecoverable for the user.
		await screen.findByText("Save your backup codes")
		for (const code of BACKUP_CODES) {
			expect(screen.getByText(code)).toBeTruthy()
		}
	}, 30_000)

	it("offers backup-code regeneration only once TOTP is enabled", async () => {
		await mount({
			id: "user_1",
			totpEnabled: false,
			backupCodeEnabled: false,
			createTOTP: vi.fn(),
			verifyTOTP: vi.fn(),
		})
		expect(screen.queryByText("Backup Codes")).toBeNull()

		cleanup()
		vi.resetModules()

		await mount({
			id: "user_1",
			totpEnabled: true,
			backupCodeEnabled: true,
			createTOTP: vi.fn(),
			verifyTOTP: vi.fn(),
		})
		expect(screen.getByText("Backup Codes")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Regenerate codes" })).toBeTruthy()
	}, 30_000)
})
