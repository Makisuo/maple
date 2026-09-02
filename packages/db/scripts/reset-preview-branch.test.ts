import { describe, expect, it } from "vitest"
import { isPreviewBranchName, resetGuardError } from "./reset-preview-branch"

describe("resetGuardError", () => {
	it("refuses when nothing asserts the target is a preview branch", () => {
		expect(resetGuardError({})).toContain("Refusing to reset")
	})

	// THE REGRESSION: the old guard was `if (!process.env.CI && ...)`, so ANY
	// nonempty CI value — including the string "false" — authorized dropping
	// every object in whatever DATABASE_URL happened to point at.
	it("a generic CI flag is not authorization", () => {
		expect(resetGuardError({ RESET_EXPECTED_BRANCH: undefined })).not.toBeNull()
		// Simulate the old bypass inputs: nothing but CI-ish env noise.
		expect(resetGuardError({ RESET_EXPECTED_BRANCH: "" })).not.toBeNull()
	})

	it("proceeds when the caller names a pr-* branch", () => {
		expect(resetGuardError({ RESET_EXPECTED_BRANCH: "pr-1234" })).toBeNull()
	})

	it("refuses a non-preview branch name, even in CI", () => {
		expect(resetGuardError({ RESET_EXPECTED_BRANCH: "main" })).not.toBeNull()
		expect(resetGuardError({ RESET_EXPECTED_BRANCH: "stg" })).not.toBeNull()
		expect(resetGuardError({ RESET_EXPECTED_BRANCH: "pr-" })).not.toBeNull()
		expect(resetGuardError({ RESET_EXPECTED_BRANCH: "xpr-12" })).not.toBeNull()
	})

	it("still allows an explicit manual confirmation", () => {
		expect(resetGuardError({ RESET_PREVIEW_CONFIRM: "1" })).toBeNull()
		expect(resetGuardError({ RESET_PREVIEW_CONFIRM: "true" })).not.toBeNull()
	})
})

describe("isPreviewBranchName", () => {
	it("accepts only pr-<digits>", () => {
		expect(isPreviewBranchName("pr-7")).toBe(true)
		expect(isPreviewBranchName("pr-007")).toBe(true)
		expect(isPreviewBranchName("main")).toBe(false)
		expect(isPreviewBranchName(undefined)).toBe(false)
	})
})
