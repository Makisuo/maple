import { describe, expect, it } from "vitest"

import {
	compileFunnelStep,
	compileFunnelSteps,
	draftFromFunnelStep,
	formatFunnelStepFilter,
	formatProductEventsFilterClause,
	parseFunnelStepFilter,
	parseProductEventsFilterClause,
} from "./funnel-filters"

describe("parseFunnelStepFilter", () => {
	it("reads key = value clauses joined by AND, keeping key case", () => {
		expect(parseFunnelStepFilter('planTier = "pro" AND source = cli')).toEqual({
			ok: true,
			value: { planTier: "pro", source: "cli" },
		})
	})

	it("treats blank text as no filter and strips an attr. prefix", () => {
		expect(parseFunnelStepFilter("   ")).toEqual({ ok: true, value: {} })
		expect(parseFunnelStepFilter("attr.plan = 'pro'")).toEqual({ ok: true, value: { plan: "pro" } })
	})

	it("rejects operators the funnel query cannot run, OR, duplicates and empty values", () => {
		expect(parseFunnelStepFilter('plan != "pro"')).toMatchObject({ ok: false })
		expect(parseFunnelStepFilter("plan contains pro")).toMatchObject({ ok: false })
		expect(parseFunnelStepFilter('plan = "a" OR plan = "b"')).toMatchObject({ ok: false })
		expect(parseFunnelStepFilter('plan = "a" AND plan = "b"')).toMatchObject({ ok: false })
		expect(parseFunnelStepFilter('plan = ""')).toMatchObject({ ok: false })
		expect(parseFunnelStepFilter("plan")).toMatchObject({ ok: false })
	})
})

describe("step drafts", () => {
	it("round-trips a stored attributeEquals through the filter text", () => {
		const draft = draftFromFunnelStep({
			kind: "event",
			eventName: "signup_completed",
			attributeEquals: { plan: "pro", source: "cli" },
		})
		expect(draft).toEqual({
			kind: "event",
			eventName: "signup_completed",
			attributeEquals: { plan: "pro", source: "cli" },
			filterClause: 'plan = "pro" AND source = "cli"',
		})
		expect(compileFunnelStep(draft)).toEqual({
			ok: true,
			value: { kind: "event", eventName: "signup_completed", attributeEquals: { plan: "pro", source: "cli" } },
		})
	})

	it("compiles from the filter text, not the stored attributeEquals, and drops an emptied one", () => {
		expect(
			compileFunnelStep({
				kind: "event",
				eventName: "x",
				attributeEquals: { plan: "pro" },
				filterClause: "",
			}),
		).toEqual({ ok: true, value: { kind: "event", eventName: "x" } })
	})

	it("trims a page host and drops a blank one", () => {
		expect(compileFunnelStep({ kind: "page", pagePath: "/pricing", host: "  " })).toEqual({
			ok: true,
			value: { kind: "page", pagePath: "/pricing" },
		})
		expect(compileFunnelStep({ kind: "page", pagePath: "/pricing", host: " app.example.com " })).toEqual({
			ok: true,
			value: { kind: "page", pagePath: "/pricing", host: "app.example.com" },
		})
	})

	it("names the step whose filter does not compile", () => {
		expect(
			compileFunnelSteps([
				{ kind: "page", pagePath: "/" },
				{ kind: "event", eventName: "x", filterClause: "plan != pro" },
			]),
		).toMatchObject({ ok: false, error: expect.stringMatching(/^Step 2: /) })
	})

	it("formats nothing for a step without a filter", () => {
		expect(formatFunnelStepFilter(undefined)).toBe("")
	})
})

describe("population filter clause", () => {
	it("maps the where-clause vocabulary (and aliases) onto the filter fields", () => {
		expect(parseProductEventsFilterClause('country = "DE" AND utm.source = twitter AND referrer = "x.com"')).toEqual({
			ok: true,
			value: { country: "DE", utmSource: "twitter", referrerHost: "x.com" },
		})
		expect(parseProductEventsFilterClause("Visitor_Type = new")).toEqual({
			ok: true,
			value: { visitorType: "new" },
		})
	})

	it("rejects unknown keys, naming the vocabulary, and a bad visitor_type", () => {
		expect(parseProductEventsFilterClause('plan = "pro"')).toMatchObject({
			ok: false,
			error: expect.stringContaining("utm.source"),
		})
		expect(parseProductEventsFilterClause("visitor_type = vip")).toMatchObject({ ok: false })
	})

	it("prints stored filters in canonical key order and round-trips", () => {
		const text = formatProductEventsFilterClause({ utmSource: "twitter", country: "DE", visitorType: "returning" })
		expect(text).toBe('country = "DE" AND utm.source = "twitter" AND visitor_type = "returning"')
		expect(parseProductEventsFilterClause(text)).toEqual({
			ok: true,
			value: { country: "DE", utmSource: "twitter", visitorType: "returning" },
		})
		expect(formatProductEventsFilterClause(undefined)).toBe("")
	})
})
