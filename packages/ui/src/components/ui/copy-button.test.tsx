import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { copyTooltipText, CopyButton } from "./copy-button"

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
	writeText = vi.fn().mockResolvedValue(undefined)
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
})

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

describe("CopyButton", () => {
	it("renders a labelled button whose status region is empty at rest", () => {
		render(<CopyButton value="maple" label="Trace ID" />)

		expect(screen.getByRole("button", { name: "Copy Trace ID" })).toBeDefined()
		expect(screen.getByRole("status").textContent).toBe("")
	})

	it("writes the value on click and announces the result", async () => {
		render(<CopyButton value={() => "maple"} label="Trace ID" />)

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Copy Trace ID" }))
		})

		expect(writeText).toHaveBeenCalledWith("maple")
		expect(screen.getByRole("status").textContent).toBe("Copied")
	})
})

// The wording is shared with `CopyableBadge`; pin it here so a change in one
// component can't quietly diverge from the other.
describe("copyTooltipText", () => {
	it("names the thing being copied while idle", () => {
		expect(copyTooltipText("idle", "trace ID")).toBe("Copy trace ID")
	})

	it("reports success and failure", () => {
		expect(copyTooltipText("copied", "trace ID")).toBe("Copied")
		expect(copyTooltipText("error", "trace ID")).toBe("Failed to copy")
	})

	it("lets a callsite override the outcome wording", () => {
		expect(copyTooltipText("copied", "link", { copiedLabel: "Link copied" })).toBe("Link copied")
		expect(copyTooltipText("error", "link", { errorLabel: "Nope" })).toBe("Nope")
	})
})
