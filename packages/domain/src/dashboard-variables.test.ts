import { describe, expect, it } from "vitest"
import { Schema } from "effect"

import { DashboardDocument, DashboardVariableSchema } from "./http/dashboards"

const decodeVariable = Schema.decodeUnknownSync(DashboardVariableSchema)
const decodeDocument = Schema.decodeUnknownSync(DashboardDocument)
const encodeDocument = Schema.encodeSync(DashboardDocument)

const baseDocument = {
	id: "dash-1",
	name: "Test",
	timeRange: { type: "relative", value: "12h" },
	widgets: [],
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
}

describe("DashboardVariableSchema", () => {
	it("decodes a query variable with a facet source", () => {
		const variable = decodeVariable({
			name: "service",
			type: "query",
			source: { kind: "facet", facet: "service" },
			includeAll: true,
		})
		expect(variable.name).toBe("service")
		expect(variable.type).toBe("query")
	})

	it("decodes a query variable with an attribute source", () => {
		const variable = decodeVariable({
			name: "route",
			type: "query",
			source: { kind: "attribute", scope: "span", attributeKey: "http.route" },
		})
		expect(variable.type).toBe("query")
	})

	it("decodes custom and textbox variables", () => {
		expect(
			decodeVariable({
				name: "env",
				type: "custom",
				options: [{ value: "prod" }, { value: "stg", label: "Staging" }],
				defaultValue: "prod",
			}).type,
		).toBe("custom")
		expect(decodeVariable({ name: "needle", type: "textbox" }).type).toBe("textbox")
	})

	it.each(["__x", "1x", "a-b", "", "a b", "$x"])("rejects invalid name %j", (name) => {
		expect(() => decodeVariable({ name, type: "textbox" })).toThrow()
	})

	it("rejects unknown facets and scopes", () => {
		expect(() =>
			decodeVariable({ name: "x", type: "query", source: { kind: "facet", facet: "bogus" } }),
		).toThrow()
		expect(() =>
			decodeVariable({
				name: "x",
				type: "query",
				source: { kind: "attribute", scope: "metric", attributeKey: "k" },
			}),
		).toThrow()
	})
})

describe("DashboardDocument with variables", () => {
	it("round-trips a document without variables (back-compat)", () => {
		const decoded = decodeDocument(baseDocument)
		expect(decoded.variables).toBeUndefined()
		expect("variables" in encodeDocument(decoded)).toBe(false)
	})

	it("round-trips a document with variables", () => {
		const decoded = decodeDocument({
			...baseDocument,
			variables: [
				{ name: "service", type: "query", source: { kind: "facet", facet: "service" } },
				{ name: "env", type: "custom", options: [{ value: "prod" }], includeAll: true },
			],
		})
		expect(decoded.variables).toHaveLength(2)
		const encoded = encodeDocument(decoded)
		expect(encoded.variables).toHaveLength(2)
	})
})

const widget = (id: string, membership: Record<string, string> = {}) => ({
	id,
	visualization: "chart",
	dataSource: { endpoint: "custom_query_builder_timeseries" },
	display: {},
	layout: { x: 0, y: 0, w: 4, h: 4 },
	...membership,
})

describe("DashboardDocument with sections", () => {
	it("round-trips a document without sections (back-compat)", () => {
		const decoded = decodeDocument({ ...baseDocument, widgets: [widget("w1")] })
		expect(decoded.sections).toBeUndefined()
		const encoded = encodeDocument(decoded)
		expect("sections" in encoded).toBe(false)
		expect("sectionId" in encoded.widgets[0]!).toBe(false)
	})

	it("round-trips sections and widget membership", () => {
		const decoded = decodeDocument({
			...baseDocument,
			widgets: [widget("w1", { sectionId: "s1", tabId: "t1" })],
			sections: [
				{ id: "s1", title: "Overview", collapsed: true, tabs: [{ id: "t1", title: "Latency" }] },
			],
		})
		expect(decoded.sections).toHaveLength(1)
		expect(decoded.sections?.[0]?.collapsed).toBe(true)
		expect(decoded.widgets[0]?.sectionId).toBe("s1")
		expect(encodeDocument(decoded).sections?.[0]?.tabs).toHaveLength(1)
	})

	// This is the entire back-compat story for an older client reading a newer
	// document: `Schema.Struct` ignores excess properties, so sections are
	// dropped on decode and the board renders flat rather than failing to load.
	// It currently rests on an implicit Effect default, so pin it.
	it("ignores unknown keys rather than failing the read", () => {
		const decoded = decodeDocument({
			...baseDocument,
			widgets: [widget("w1")],
			somethingFromTheFuture: { nested: true },
		})
		expect(decoded.name).toBe("Test")
		expect("somethingFromTheFuture" in encodeDocument(decoded)).toBe(false)
	})

	// The invariants are repaired by `sanitizeDashboardSections` on write, never
	// by schema checks — an orphaned widget must not fail the whole read.
	it("decodes a widget pointing at a section that does not exist", () => {
		const decoded = decodeDocument({
			...baseDocument,
			widgets: [widget("w1", { sectionId: "gone", tabId: "t1" })],
			sections: [{ id: "s1", title: "Overview", tabs: [{ id: "t1", title: "T" }] }],
		})
		expect(decoded.widgets[0]?.sectionId).toBe("gone")
	})

	it("rejects a section with no tabs", () => {
		expect(() =>
			decodeDocument({ ...baseDocument, sections: [{ id: "s1", title: "S", tabs: [] }] }),
		).toThrow()
	})
})
