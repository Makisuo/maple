/**
 * Two severity scales, and the translation between them.
 *
 * The bug this guards was silent in the worst way: the investigation snapshot
 * decoded `context.severity` against the four-value issue scale, so a `warning`
 * alert failed the decode, was read as "absent", and arrived as an unclassified
 * incident. Nothing logged, nothing threw.
 */
import { describe, expect, it } from "vitest"
import { issueSeverityFromAlert } from "./severity-map"

describe("issueSeverityFromAlert", () => {
	it("maps critical straight through", () => {
		expect(issueSeverityFromAlert("critical")).toBe("critical")
	})

	/**
	 * `medium`, not `low`. A rule someone authored and that then fired is not the
	 * noise floor, and `low` is what sizes the thinnest investigations.
	 */
	it("maps warning to medium, which is a value the issue scale actually has", () => {
		expect(issueSeverityFromAlert("warning")).toBe("medium")
	})
})
