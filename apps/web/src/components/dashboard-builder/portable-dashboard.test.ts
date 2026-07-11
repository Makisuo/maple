import { describe, expect, it } from "vitest"

import { isPersesDashboardJson, parsePortableDashboardJson, toPortableDashboard } from "./portable-dashboard"

describe("portable-dashboard", () => {
	it("exports the canonical portable dashboard payload", () => {
		const portableDashboard = toPortableDashboard({
			id: "dash_123",
			name: "Errors Overview",
			description: "Monitors key error metrics",
			tags: ["errors", "backend"],
			timeRange: { type: "relative", value: "12h" },
			widgets: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T01:00:00.000Z",
		})

		expect(portableDashboard).toEqual({
			name: "Errors Overview",
			description: "Monitors key error metrics",
			tags: ["errors", "backend"],
			timeRange: { type: "relative", value: "12h" },
			widgets: [],
		})
	})

	it("imports canonical dashboards and strips instance metadata", () => {
		const portableDashboard = parsePortableDashboardJson(
			JSON.stringify({
				id: "dash_123",
				name: "Errors Overview",
				description: "Monitors key error metrics",
				tags: ["errors", "backend"],
				timeRange: { type: "relative", value: "12h" },
				widgets: [],
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T01:00:00.000Z",
			}),
		)

		expect(portableDashboard).toEqual({
			name: "Errors Overview",
			description: "Monitors key error metrics",
			tags: ["errors", "backend"],
			timeRange: { type: "relative", value: "12h" },
			widgets: [],
		})
	})

	it("round-trips dashboard variables through export and import", () => {
		const variables = [
			{
				name: "service",
				type: "query" as const,
				source: { kind: "facet" as const, facet: "service" as const },
				includeAll: true,
			},
			{
				name: "env",
				type: "custom" as const,
				options: [{ value: "prod" }, { value: "stg" }],
				defaultValue: "prod",
			},
		]

		const exported = toPortableDashboard({
			id: "dash_123",
			name: "With Variables",
			timeRange: { type: "relative", value: "12h" },
			widgets: [],
			variables,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T01:00:00.000Z",
		})
		expect(exported.variables).toEqual(variables)

		const imported = parsePortableDashboardJson(JSON.stringify(exported))
		expect(imported.variables).toEqual(variables)
	})

	it("rejects non-canonical dashboard files", () => {
		expect(() =>
			parsePortableDashboardJson(
				JSON.stringify({
					widgets: [],
					timeRange: { type: "relative", value: "12h" },
				}),
			),
		).toThrow()
	})

	it("detects Perses dashboard resources", () => {
		expect(isPersesDashboardJson({ kind: "Dashboard", spec: { panels: {} } })).toBe(true)
		expect(isPersesDashboardJson({ kind: "Datasource", spec: {} })).toBe(false)
		expect(isPersesDashboardJson({ name: "Maple dashboard", widgets: [] })).toBe(false)
	})
})
