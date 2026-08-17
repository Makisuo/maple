import { describe, expect, it } from "vitest"

import type { DashboardQueryVariableSource, DashboardVariable } from "@maple/domain/http"
import { ALL_VALUE } from "./interpolate"
import {
	LOADING_VARIABLE_OPTIONS,
	NO_VARIABLE_OPTIONS,
	dashboardVariableOptionsFromResult,
	dashboardVariableOptionsQuery,
	resolveDashboardVariableValue,
} from "./options"

// SAFETY: test fixtures; the shape is the decoded query-variable arm.
const query = (source: DashboardQueryVariableSource): DashboardVariable =>
	({ name: "v", type: "query", source }) as DashboardVariable

const loaded = (options: string[]) => ({ options, loading: false })

describe("resolveDashboardVariableValue", () => {
	const variable = { type: "query" as const }

	it("takes the selection first", () => {
		expect(resolveDashboardVariableValue(variable, "checkout", loaded(["a", "b"]))).toBe("checkout")
	})

	it("honours an All selection only when the board offers All", () => {
		expect(
			resolveDashboardVariableValue({ ...variable, includeAll: true }, ALL_VALUE, loaded(["a"])),
		).toBe(ALL_VALUE)
		// Not offered: the selection is ignored and the ladder continues.
		expect(resolveDashboardVariableValue(variable, ALL_VALUE, loaded(["a", "b"]))).toBe("a")
	})

	it("falls back to the declared default, then All, then the first option", () => {
		expect(
			resolveDashboardVariableValue({ ...variable, defaultValue: "d" }, undefined, loaded(["a"])),
		).toBe("d")
		expect(
			resolveDashboardVariableValue({ ...variable, includeAll: true }, undefined, loaded(["a"])),
		).toBe(ALL_VALUE)
		expect(resolveDashboardVariableValue(variable, undefined, loaded(["a", "b"]))).toBe("a")
		expect(resolveDashboardVariableValue(variable, "", loaded(["a", "b"]))).toBe("a")
	})

	it("is undefined while options load and empty when there are none", () => {
		expect(resolveDashboardVariableValue(variable, undefined, LOADING_VARIABLE_OPTIONS)).toBeUndefined()
		expect(resolveDashboardVariableValue(variable, undefined, NO_VARIABLE_OPTIONS)).toBe("")
	})

	it("resolves a textbox with nothing selected to the empty string, never to an option", () => {
		expect(resolveDashboardVariableValue({ type: "textbox" }, undefined, loaded(["a"]))).toBe("")
	})
})

describe("dashboardVariableOptionsQuery", () => {
	it("maps each facet variable onto its one engine facet branch", () => {
		expect(dashboardVariableOptionsQuery(query({ kind: "facet", facet: "service" }))).toEqual({
			kind: "facets",
			source: "traces",
			facet: "service",
		})
		expect(dashboardVariableOptionsQuery(query({ kind: "facet", facet: "environment" }))).toEqual({
			kind: "facets",
			source: "traces",
			facet: "deploymentEnv",
		})
		expect(dashboardVariableOptionsQuery(query({ kind: "facet", facet: "http_status_code" }))).toEqual({
			kind: "facets",
			source: "traces",
			facet: "httpStatus",
		})
		expect(dashboardVariableOptionsQuery(query({ kind: "facet", facet: "log_severity" }))).toEqual({
			kind: "facets",
			source: "logs",
			facet: "severity",
		})
	})

	it("maps an attribute variable onto an attribute-values scan of its scope", () => {
		expect(
			dashboardVariableOptionsQuery(
				query({ kind: "attribute", scope: "resource", attributeKey: "k8s.pod" }),
			),
		).toEqual({ kind: "attributeValues", source: "traces", scope: "resource", attributeKey: "k8s.pod" })
	})

	it("has nothing to run for custom and textbox variables", () => {
		expect(
			dashboardVariableOptionsQuery({
				name: "c",
				type: "custom",
				options: [{ value: "x" }],
			} as DashboardVariable),
		).toBeNull()
		expect(dashboardVariableOptionsQuery({ name: "t", type: "textbox" } as DashboardVariable)).toBeNull()
	})
})

describe("dashboardVariableOptionsFromResult", () => {
	it("keeps the requested facet's rows in engine order", () => {
		const options = dashboardVariableOptionsFromResult(
			{ kind: "facets", source: "traces", facet: "service" },
			{
				kind: "facets",
				source: "traces",
				data: [
					{ facetType: "service", name: "checkout", count: 9 },
					{ facetType: "deploymentEnv", name: "prod", count: 9 },
					{ facetType: "service", name: "search", count: 4 },
				],
			},
		)
		expect(options).toEqual(["checkout", "search"])
	})

	it("drops the empty severity for logs, as the browser does", () => {
		expect(
			dashboardVariableOptionsFromResult(
				{ kind: "facets", source: "logs", facet: "severity" },
				{
					kind: "facets",
					source: "logs",
					data: [
						{ facetType: "severity", name: "", count: 1 },
						{ facetType: "severity", name: "ERROR", count: 3 },
					],
				},
			),
		).toEqual(["ERROR"])
	})

	it("reads attribute values, and nothing from a result of another kind", () => {
		const query = { kind: "attributeValues", source: "traces", scope: "span", attributeKey: "k" } as const
		expect(
			dashboardVariableOptionsFromResult(query, {
				kind: "attributeValues",
				source: "traces",
				data: [
					{ value: "a", count: 2 },
					{ value: "b", count: 1 },
				],
			}),
		).toEqual(["a", "b"])
		expect(
			dashboardVariableOptionsFromResult(query, { kind: "facets", source: "traces", data: [] }),
		).toEqual([])
	})
})
