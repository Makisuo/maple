import { describe, expect, it } from "vitest"
import { isRegression } from "./error-tick-persistence"

const HOUR = 60 * 60 * 1000
const resolvedAt = new Date("2026-08-18T12:00:00Z")

const priorRow = (
	overrides: {
		workflowState?: "done" | "triage" | "in_progress"
		resolvedAt?: Date | null
		resolvedVersionsJson?: ReadonlyArray<string>
	} = {},
) => ({
	workflowState: overrides.workflowState ?? ("done" as const),
	resolvedAt: overrides.resolvedAt === undefined ? resolvedAt : overrides.resolvedAt,
	resolvedVersionsJson: overrides.resolvedVersionsJson ?? [],
})

const occurrence = (afterHours: number, serviceVersion = "") => ({
	lastSeenMs: resolvedAt.getTime() + afterHours * HOUR,
	serviceVersion,
})

describe("isRegression", () => {
	it("ignores issues that were never resolved", () => {
		expect(isRegression(priorRow({ workflowState: "triage" }), occurrence(99))).toBe(false)
		expect(isRegression(priorRow({ workflowState: "in_progress" }), occurrence(99))).toBe(false)
	})

	it("holds off during the rollout grace window", () => {
		// A fix marked done is not live everywhere the same second; stragglers from
		// the pre-fix build used to reopen the issue immediately.
		expect(isRegression(priorRow(), occurrence(0.5))).toBe(false)
		expect(isRegression(priorRow(), occurrence(2))).toBe(true)
	})

	it("does not reopen for a build that was already running when the fix landed", () => {
		// The maple-cli case: every binary already installed keeps reporting the bug
		// for as long as it is in use, which is why these issues could never stay
		// fixed and agents kept re-fixing the same bug.
		const prior = priorRow({ resolvedVersionsJson: ["0.0.14", "0.0.15", "0.0.18"] })

		expect(isRegression(prior, occurrence(99, "0.0.14"))).toBe(false)
		expect(isRegression(prior, occurrence(99, "0.0.18"))).toBe(false)
	})

	it("reopens for a build that had not been seen when the fix landed", () => {
		const prior = priorRow({ resolvedVersionsJson: ["0.0.14", "0.0.18"] })

		expect(isRegression(prior, occurrence(99, "0.0.19"))).toBe(true)
	})

	it("compares builds by membership, not by order", () => {
		// maple-cli reports semver while the Workers report git SHAs, so "newer than
		// the fix" is not a question these strings can answer. An unseen SHA is a
		// regression even though it does not sort after the resolved one.
		const prior = priorRow({ resolvedVersionsJson: ["f77a6e6ca7b0534d6d9dc62461e54071413c44fc"] })

		expect(isRegression(prior, occurrence(99, "21c42a638529c04a540b11a93089ddc087e79b23"))).toBe(true)
		expect(isRegression(prior, occurrence(99, "f77a6e6ca7b0534d6d9dc62461e54071413c44fc"))).toBe(false)
	})

	it("treats an unknown build as a regression", () => {
		// A service that reports no version cannot be ruled out, so it stays a
		// regression rather than being silently suppressed.
		expect(isRegression(priorRow({ resolvedVersionsJson: ["0.0.18"] }), occurrence(99, ""))).toBe(true)
	})

	it("reopens when the resolution recorded no builds at all", () => {
		// Issues resolved before build tracking existed have an empty set; they must
		// still be able to regress.
		expect(isRegression(priorRow(), occurrence(99, "0.0.19"))).toBe(true)
	})

	it("applies the grace window even to an unseen build", () => {
		const prior = priorRow({ resolvedVersionsJson: ["0.0.18"] })

		expect(isRegression(prior, occurrence(0.5, "0.0.19"))).toBe(false)
	})
})
