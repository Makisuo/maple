// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import {
	LOCKED_NAV_IDS,
	applySidebarPrefs,
	defaultSidebarPrefs,
	mergeOrder,
	type SidebarPrefs,
} from "./sidebar-preferences-atoms"
import { visibleSignalsNavItems } from "@/components/dashboard/nav-items"

const prefs = (overrides: Partial<SidebarPrefs>): SidebarPrefs => ({ ...defaultSidebarPrefs, ...overrides })

describe("mergeOrder", () => {
	it("returns defaults when nothing is stored", () => {
		expect(mergeOrder(["a", "b", "c"], [])).toEqual(["a", "b", "c"])
	})

	it("round-trips a full permutation", () => {
		expect(mergeOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"])
	})

	it("drops stored ids that no longer exist", () => {
		expect(mergeOrder(["a", "b"], ["b", "gone", "a"])).toEqual(["b", "a"])
	})

	it("inserts new default ids after their nearest preceding default sibling", () => {
		// b is new; its default predecessor a is present, so b lands right after a
		expect(mergeOrder(["a", "b", "c"], ["c", "a"])).toEqual(["c", "a", "b"])
	})

	it("inserts a new head-of-defaults id at the front", () => {
		expect(mergeOrder(["new", "a", "b"], ["b", "a"])).toEqual(["new", "b", "a"])
	})
})

describe("applySidebarPrefs", () => {
	const items = [
		{ id: "overview", title: "Overview" },
		{ id: "chat", title: "Chat" },
	]

	it("flags hidden items but keeps them in order", () => {
		const rows = applySidebarPrefs("main", items, prefs({ hidden: ["chat"] }))
		expect(rows.map((r) => [r.item.id, r.hidden])).toEqual([
			["overview", false],
			["chat", true],
		])
	})

	it("never hides locked items even when stored as hidden", () => {
		const rows = applySidebarPrefs("main", items, prefs({ hidden: ["overview"] }))
		expect(rows[0]).toMatchObject({ item: { id: "overview" }, hidden: false })
	})

	it("pins locked items back to their default index", () => {
		const rows = applySidebarPrefs("main", items, prefs({ order: { main: ["chat", "overview"] } }))
		expect(rows.map((r) => r.item.id)).toEqual(["overview", "chat"])
	})

	it("keeps gated-out items absent even if present in stored order", () => {
		const gated = [{ id: "traces", title: "Traces" }]
		const rows = applySidebarPrefs("signals", gated, prefs({ order: { signals: ["metrics", "traces"] } }))
		expect(rows.map((r) => r.item.id)).toEqual(["traces"])
	})

	it("orders and hides infra-gated signals items by stable id", () => {
		const gatedItems = visibleSignalsNavItems({ infraEnabled: false })
		const infra = gatedItems.find((item) => item.id === "infrastructure")
		expect(infra?.href).toBe("/infra/cloudflare")

		const rows = applySidebarPrefs(
			"signals",
			gatedItems,
			prefs({
				order: { signals: ["infrastructure", "logs", "traces", "metrics", "replays"] },
				hidden: ["replays"],
			}),
		)
		expect(rows.map((r) => r.item.id)).toEqual(["infrastructure", "logs", "traces", "metrics", "replays"])
		expect(rows.find((r) => r.item.id === "replays")?.hidden).toBe(true)
		expect(rows.find((r) => r.item.id === "infrastructure")?.item.href).toBe("/infra/cloudflare")
	})

	it("locks overview", () => {
		expect(LOCKED_NAV_IDS.has("overview")).toBe(true)
	})
})
