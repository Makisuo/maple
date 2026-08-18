import { describe, expect, it } from "vitest"

import { pickDashboardControlParams, resolveRefreshIntervalSeconds } from "./search-params"

describe("pickDashboardControlParams", () => {
	it("retains every `var-*` selection", () => {
		expect(pickDashboardControlParams({ "var-service": "api", "var-env": "prod" })).toEqual({
			"var-service": "api",
			"var-env": "prod",
		})
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

	// The one numeric control param, so the string-only rule above would drop it.
	it("retains a numeric `refresh`", () => {
		expect(pickDashboardControlParams({ refresh: 30 })).toEqual({ refresh: 30 })
		expect(pickDashboardControlParams({ refresh: 0 })).toEqual({ refresh: 0 })
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

describe("resolveRefreshIntervalSeconds", () => {
	it("prefers the URL override over the board's saved default", () => {
		expect(resolveRefreshIntervalSeconds("30", 300)).toBe(30)
	})

	it("falls back to the saved default when there is no override", () => {
		expect(resolveRefreshIntervalSeconds(undefined, 60)).toBe(60)
	})

	it("is off when neither is set", () => {
		expect(resolveRefreshIntervalSeconds(undefined, undefined)).toBe(0)
	})

	// `0` is a real value, not "absent": a viewer must be able to silence a board
	// that auto-refreshes for everyone else.
	it("lets `?refresh=0` turn off a board whose default is on", () => {
		expect(resolveRefreshIntervalSeconds("0", 60)).toBe(0)
	})

	// TanStack JSON-parses search values, so the same URL can hand us either form.
	it("accepts a number as readily as a string", () => {
		expect(resolveRefreshIntervalSeconds(10, undefined)).toBe(10)
	})

	// A hand-edited URL must not ask the browser to re-query every 100ms, so
	// anything outside the closed set falls through to the saved default.
	it("ignores an override outside the allowed set", () => {
		expect(resolveRefreshIntervalSeconds("1", 60)).toBe(60)
		expect(resolveRefreshIntervalSeconds("abc", 60)).toBe(60)
		expect(resolveRefreshIntervalSeconds("", 60)).toBe(60)
		expect(resolveRefreshIntervalSeconds(null, 60)).toBe(60)
	})

	it("ignores a stored value outside the allowed set", () => {
		expect(resolveRefreshIntervalSeconds(undefined, 7)).toBe(0)
	})
})
