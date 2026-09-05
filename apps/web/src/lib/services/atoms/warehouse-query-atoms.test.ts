// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import { setActiveOrgId } from "@/lib/services/common/auth-headers"
import { setGlobalNamespace } from "@/lib/services/common/global-namespace"
import { applyGlobalNamespace } from "./warehouse-query-atoms"

// Unique org per test — the global-namespace store keeps a per-org in-memory
// cache, so a reused org id would read a previous test's pin.
let orgSeq = 0
const freshOrg = () => `org_wqa_${orgSeq++}`

describe("applyGlobalNamespace", () => {
	beforeEach(() => {
		localStorage.clear()
		setActiveOrgId(freshOrg())
	})

	it("is a no-op while unpinned", () => {
		const input = { data: { startTime: "2026-01-01 00:00:00", namespaces: ["from-url"] } }
		expect(applyGlobalNamespace(input, "top")).toBe(input)
	})

	it("pins into top-level data and overrides URL-borne namespace filters", () => {
		setGlobalNamespace("checkout")
		const result = applyGlobalNamespace(
			{
				data: {
					startTime: "2026-01-01 00:00:00",
					namespaces: ["from-url"],
					excludedNamespaces: ["other"],
					namespaceMatchMode: "contains",
					services: ["api"],
				},
			},
			"top",
		)
		expect(result).toEqual({
			data: {
				startTime: "2026-01-01 00:00:00",
				namespaces: ["checkout"],
				excludedNamespaces: undefined,
				namespaceMatchMode: undefined,
				namespace: undefined,
				services: ["api"],
			},
		})
	})

	it('pins into nested filters for the "filters" scope', () => {
		setGlobalNamespace("checkout")
		const result = applyGlobalNamespace(
			{ data: { source: "logs", filters: { environments: ["prod"], excludedNamespaces: ["x"] } } },
			"filters",
		)
		expect(result).toEqual({
			data: {
				source: "logs",
				filters: { environments: ["prod"], namespaces: ["checkout"], excludedNamespaces: undefined },
			},
		})
	})

	it("creates the data/filters objects when absent", () => {
		setGlobalNamespace("checkout")
		expect(applyGlobalNamespace({}, "top")).toEqual({
			data: {
				namespaces: ["checkout"],
				namespace: undefined,
				namespaceMatchMode: undefined,
				excludedNamespaces: undefined,
			},
		})
		expect(applyGlobalNamespace({ data: {} }, "filters")).toEqual({
			data: { filters: { namespaces: ["checkout"], excludedNamespaces: undefined } },
		})
	})
})
