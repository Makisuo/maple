import { describe, expect, it } from "vitest"

import { applyAttributeFilterAction, attributeFilterParam } from "./attribute-filter-actions"

describe("attributeFilterParam", () => {
	it("routes each scope to its own search param", () => {
		expect(attributeFilterParam("span")).toBe("attributeFilters")
		expect(attributeFilterParam("resource")).toBe("resourceAttributeFilters")
	})
})

describe("applyAttributeFilterAction", () => {
	it("adds a negated entry for exclude", () => {
		const next = applyAttributeFilterAction(
			{},
			{ scope: "span", attrKey: "http.route", value: "/health", action: "exclude" },
		)
		expect(next.attributeFilters).toEqual([{ key: "http.route", value: "/health", negated: true }])
	})

	it("omits `negated` entirely for include, rather than writing false", () => {
		// The search schema treats the key as optional; a literal `false` would ride in the URL for
		// no reason and make two equivalent queries look different.
		const next = applyAttributeFilterAction(
			{},
			{ scope: "span", attrKey: "http.route", value: "/health", action: "include" },
		)
		expect(next.attributeFilters).toEqual([{ key: "http.route", value: "/health", negated: undefined }])
	})

	it("treats `only` as include — one key/value pair is already 'only'", () => {
		const only = applyAttributeFilterAction(
			{},
			{ scope: "span", attrKey: "http.route", value: "/x", action: "only" },
		)
		const include = applyAttributeFilterAction(
			{},
			{ scope: "span", attrKey: "http.route", value: "/x", action: "include" },
		)
		expect(only).toEqual(include)
	})

	it("flips polarity in place instead of stacking = x AND != x", () => {
		const included = applyAttributeFilterAction(
			{},
			{ scope: "span", attrKey: "http.route", value: "/health", action: "include" },
		)
		const flipped = applyAttributeFilterAction(included, {
			scope: "span",
			attrKey: "http.route",
			value: "/health",
			action: "exclude",
		})
		expect(flipped.attributeFilters).toHaveLength(1)
		expect(flipped.attributeFilters?.[0]?.negated).toBe(true)
	})

	it("keeps filters on other keys", () => {
		const first = applyAttributeFilterAction(
			{},
			{ scope: "span", attrKey: "http.route", value: "/a", action: "exclude" },
		)
		const second = applyAttributeFilterAction(first, {
			scope: "span",
			attrKey: "http.method",
			value: "GET",
			action: "include",
		})
		expect(second.attributeFilters?.map((f) => f.key)).toEqual(["http.route", "http.method"])
	})

	it("keeps span and resource scopes in separate params", () => {
		const span = applyAttributeFilterAction(
			{},
			{ scope: "span", attrKey: "http.route", value: "/a", action: "exclude" },
		)
		const both = applyAttributeFilterAction(span, {
			scope: "resource",
			attrKey: "host.name",
			value: "box-1",
			action: "exclude",
		})
		expect(both.attributeFilters).toHaveLength(1)
		expect(both.resourceAttributeFilters).toHaveLength(1)
	})
})
