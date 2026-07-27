import { describe, expect, it } from "vitest"
import { GearIcon, ServerIcon, type IconComponent } from "@/components/icons"
import {
	DEFAULT_SETTINGS_TAB_ORDER,
	resolveActiveSettingsTab,
	settingsTabValues,
	type SettingsTab,
} from "./settings-nav"

const item = (id: SettingsTab, icon: IconComponent = GearIcon) => ({ id, label: id, icon })

/** Workspace items other than `setup-audit` are Clerk-gated, so self-hosted keeps only that one. */
const SELF_HOSTED = [
	item("setup-audit"),
	item("ingestion", ServerIcon),
	item("api-keys"),
	item("developer"),
	item("mcp"),
	item("automation"),
]

const CLERK = [
	item("organization"),
	item("members"),
	item("setup-audit"),
	item("billing"),
	item("ingestion", ServerIcon),
	item("api-keys"),
]

describe("resolveActiveSettingsTab", () => {
	it("honours an explicitly requested tab that is visible", () => {
		expect(resolveActiveSettingsTab("api-keys", CLERK)).toBe("api-keys")
		expect(resolveActiveSettingsTab("setup-audit", SELF_HOSTED)).toBe("setup-audit")
	})

	it("ignores a requested tab the current account cannot see", () => {
		expect(resolveActiveSettingsTab("billing", SELF_HOSTED)).toBe("ingestion")
	})

	it("ignores an unknown tab value", () => {
		expect(resolveActiveSettingsTab("nonsense", CLERK)).toBe("organization")
	})

	it("lands on Organization for a Clerk workspace", () => {
		expect(resolveActiveSettingsTab(undefined, CLERK)).toBe("organization")
	})

	it("lands on Ingestion when self-hosted, never on Setup Audit", () => {
		// Regression: `setup-audit` is not Clerk-gated, so it is the FIRST visible item in
		// self-hosted mode. A positional default would land here and run the audit's warehouse
		// reads on every visit to Settings.
		expect(SELF_HOSTED[0]?.id).toBe("setup-audit")
		expect(resolveActiveSettingsTab(undefined, SELF_HOSTED)).toBe("ingestion")
	})

	it("falls back to the first visible item when no preferred default is available", () => {
		expect(resolveActiveSettingsTab(undefined, [item("mcp"), item("api-keys")])).toBe("mcp")
	})

	it("falls back to ingestion when nothing is visible at all", () => {
		expect(resolveActiveSettingsTab(undefined, [])).toBe("ingestion")
	})
})

describe("DEFAULT_SETTINGS_TAB_ORDER", () => {
	it("only lists real tabs", () => {
		for (const tab of DEFAULT_SETTINGS_TAB_ORDER) {
			expect(settingsTabValues).toContain(tab)
		}
	})

	it("never lands users on a tab that does expensive work on mount", () => {
		// `setup-audit` issues a dozen warehouse reads (two of them cross-span joins) when its
		// section mounts. It must stay an explicit navigation, never a default.
		expect(DEFAULT_SETTINGS_TAB_ORDER).not.toContain("setup-audit")
	})
})
