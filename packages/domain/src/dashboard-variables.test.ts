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
