import { describe, expect, it } from "vitest"

import { MAX_SEARCH_RESULTS, visibleFilterOptions } from "@maple/ui/components/filters/filter-section"

// Facets arrive ranked by traffic, so the collapsed section shows the five busiest values. That is
// the right default and the wrong one for a value you just picked: tick a path ranked #40 and the
// next facet refresh buries it behind "Show 195 more", with no way to untick it from the section it
// was ticked in. Selected options are pinned for that reason, not for tidiness.

const option = (name: string, count: number) => ({ name, count })

const ranked = [
	option("/api/users", 900),
	option("/health", 800),
	option("/static/app.js", 700),
	option("/static/app.css", 600),
	option("/login", 500),
	option("/api/orders", 400),
	option("/admin/deep", 300),
]

const base = { search: "", showAll: false, maxVisible: 5 }

describe("visibleFilterOptions", () => {
	it("keeps traffic rank when nothing is selected", () => {
		const { visible, hasMore } = visibleFilterOptions({ ...base, options: ranked, selected: [] })
		expect(visible.map((o) => o.name)).toEqual([
			"/api/users",
			"/health",
			"/static/app.js",
			"/static/app.css",
			"/login",
		])
		expect(hasMore).toBe(2)
	})

	it("pins a selected option that ranks below the fold", () => {
		const { visible } = visibleFilterOptions({
			...base,
			options: ranked,
			selected: ["/admin/deep"],
		})
		expect(visible[0]?.name).toBe("/admin/deep")
		// Everything else keeps its order behind it — pinning reorders one value, not the list.
		expect(visible.slice(1).map((o) => o.name)).toEqual([
			"/api/users",
			"/health",
			"/static/app.js",
			"/static/app.css",
		])
	})

	it("pins several selections in traffic order among themselves", () => {
		const { visible } = visibleFilterOptions({
			...base,
			options: ranked,
			selected: ["/admin/deep", "/login"],
		})
		expect(visible.slice(0, 2).map((o) => o.name)).toEqual(["/login", "/admin/deep"])
	})

	it("shows every option once expanded", () => {
		const { visible, hasMore } = visibleFilterOptions({
			...base,
			options: ranked,
			selected: [],
			showAll: true,
		})
		expect(visible).toHaveLength(ranked.length)
		// Still reports the count so the toggle can read "Show less".
		expect(hasMore).toBe(2)
	})

	it("caps search matches and reports what it dropped", () => {
		const many = Array.from({ length: MAX_SEARCH_RESULTS + 12 }, (_, i) =>
			option(`/api/v1/users/${i}/entitlements`, 100 - i),
		)
		const { visible, overflowingMatches, hasMore } = visibleFilterOptions({
			...base,
			options: many,
			selected: [],
			search: "entitlements",
		})
		expect(visible).toHaveLength(MAX_SEARCH_RESULTS)
		expect(overflowingMatches).toBe(12)
		// A capped search is not a collapsed list — "Show N more" would lie about what expanding does.
		expect(hasMore).toBe(0)
	})

	it("ignores maxVisible while searching, so a match is never hidden behind Show more", () => {
		const { visible, overflowingMatches } = visibleFilterOptions({
			...base,
			options: ranked,
			selected: [],
			search: "static",
		})
		expect(visible.map((o) => o.name)).toEqual(["/static/app.js", "/static/app.css"])
		expect(overflowingMatches).toBe(0)
	})

	it("matches on the display label, not the stored value", () => {
		// Protocol renders "HTTP/2" for the stored "2"; searching what you can read has to work.
		const { visible } = visibleFilterOptions({
			...base,
			options: [option("2", 10), option("3", 5), option("unknown", 1)],
			selected: [],
			search: "http/3",
			getOptionLabel: (name) => (name === "unknown" ? name : `HTTP/${name}`),
		})
		expect(visible.map((o) => o.name)).toEqual(["3"])
	})

	it("is case-insensitive", () => {
		const { visible } = visibleFilterOptions({
			...base,
			options: [option("/API/Users", 10), option("/health", 5)],
			selected: [],
			search: "api/users",
		})
		expect(visible.map((o) => o.name)).toEqual(["/API/Users"])
	})
})
