import { describe, expect, it } from "vitest"

import { pickDashboardControlParams } from "./search-params"

describe("pickDashboardControlParams", () => {
	it("retains every `var-*` selection", () => {
		expect(
			pickDashboardControlParams({ "var-service": "api", "var-env": "prod" }),
		).toEqual({ "var-service": "api", "var-env": "prod" })
	})

	it("retains every view param", () => {
		const search = {
			filter: 'service.name = "api"',
			collapsed: "a,b",
			expanded: "c",
			tab: "a:overview",
			widget: "w1",
		}
		expect(pickDashboardControlParams(search)).toEqual(search)
	})

	// `mode` is set explicitly by whichever caller wants edit mode. Folding it in
	// here would make every navigation sticky in edit — including the one that
	// exists to leave it.
	it("drops `mode` so toggling edit stays a deliberate act", () => {
		expect(pickDashboardControlParams({ mode: "edit", "var-service": "api" })).toEqual({
			"var-service": "api",
		})
	})

	it("drops unrelated params", () => {
		expect(pickDashboardControlParams({ startTime: "123", foo: "bar" })).toEqual({})
	})

	// A hand-edited `?collapsed=5` is a typo, and reading it as the section id
	// "5" is worse than ignoring it.
	it("drops non-string view params rather than coercing them", () => {
		expect(pickDashboardControlParams({ collapsed: 5, widget: null, tab: true })).toEqual({})
	})

	// `var-*` values keep the looser handling they already had: the variables
	// context coerces numbers and booleans at read time.
	it("keeps non-string `var-*` values for the variables context to coerce", () => {
		expect(pickDashboardControlParams({ "var-port": 8080 })).toEqual({ "var-port": 8080 })
	})

	it("distinguishes an explicitly-cleared filter from an absent one", () => {
		// `?filter=` means the viewer cleared it, and must not be re-seeded from
		// the dashboard's saved default.
		expect(pickDashboardControlParams({ filter: "" })).toEqual({ filter: "" })
		expect(pickDashboardControlParams({})).toEqual({})
	})

	it("returns a fresh object rather than aliasing the input", () => {
		const search = { "var-service": "api" }
		const picked = pickDashboardControlParams(search)
		expect(picked).not.toBe(search)
	})
})
