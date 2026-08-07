import { describe, expect, it } from "vitest"
import {
	accountNavSections,
	accountTabLabels,
	accountTabValues,
	DEFAULT_ACCOUNT_TAB,
	resolveActiveAccountTab,
} from "./account-nav"

describe("resolveActiveAccountTab", () => {
	it("honours every real tab", () => {
		for (const tab of accountTabValues) {
			expect(resolveActiveAccountTab(tab)).toBe(tab)
		}
	})

	it("falls back to the default with no tab requested", () => {
		expect(resolveActiveAccountTab(undefined)).toBe(DEFAULT_ACCOUNT_TAB)
	})

	it("ignores an unknown tab value", () => {
		expect(resolveActiveAccountTab("nonsense")).toBe(DEFAULT_ACCOUNT_TAB)
		expect(resolveActiveAccountTab("")).toBe(DEFAULT_ACCOUNT_TAB)
		// A `/settings` tab is not an `/account` tab; the two unions are deliberately disjoint.
		expect(resolveActiveAccountTab("billing")).toBe(DEFAULT_ACCOUNT_TAB)
	})
})

describe("accountNavSections", () => {
	it("renders a row for every tab, and no row that is not a tab", () => {
		// Catches both halves of the same mistake: adding a tab without a nav row (unreachable
		// except by URL) and leaving a nav row for a tab the page no longer renders (dead row).
		const rowIds = accountNavSections.flatMap((section) => section.items.map((item) => item.id))
		expect([...rowIds].sort()).toEqual([...accountTabValues].sort())
	})

	it("has a unique id per section", () => {
		const sectionIds = accountNavSections.map((section) => section.id)
		expect(new Set(sectionIds).size).toBe(sectionIds.length)
	})

	it("labels each row with its tab label", () => {
		for (const section of accountNavSections) {
			for (const item of section.items) {
				expect(item.label).toBe(accountTabLabels[item.id])
			}
		}
	})
})

describe("DEFAULT_ACCOUNT_TAB", () => {
	it("is a real tab", () => {
		expect(accountTabValues).toContain(DEFAULT_ACCOUNT_TAB)
	})

	it("never lands users on a tab that does work on mount", () => {
		// `sessions` fetches the user's sessions from Clerk when it mounts. It must stay an
		// explicit navigation, never the landing tab.
		expect(DEFAULT_ACCOUNT_TAB).not.toBe("sessions")
	})
})
