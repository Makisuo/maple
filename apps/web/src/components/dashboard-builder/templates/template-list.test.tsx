// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { V2DashboardTemplate } from "@maple/domain/http/v2"
import { TemplateList } from "./template-list"
import type { TemplateReadiness } from "./use-template-readiness"

afterEach(cleanup)

const template = (id: string, name: string, category = "database"): V2DashboardTemplate =>
	({
		id,
		object: "dashboard_template",
		name,
		description: "",
		category,
		tags: [],
		requirements: [],
		requirement: null,
		requiredMetricPrefixes: [],
		parameters: [],
		preview: [],
	}) as unknown as V2DashboardTemplate

const readinessFor = (entries: Record<string, boolean>): Map<string, TemplateReadiness> =>
	new Map(
		Object.entries(entries).map(([id, ready]) => [
			id,
			{
				ready,
				missingLabel: ready ? null : "no postgresql.*",
				prefixLabel: "postgresql.*",
				metricCount: 0,
				lastSeen: null,
			},
		]),
	)

const TEMPLATES = [
	template("postgres-overview", "Postgres Overview"),
	template("service-health", "Service Health", "application"),
]

function renderList(props: Partial<React.ComponentProps<typeof TemplateList>> = {}) {
	return render(
		<TemplateList
			templates={TEMPLATES}
			readiness={readinessFor({ "postgres-overview": false, "service-health": true })}
			selectedId={null}
			onSelect={() => {}}
			onSelectBlank={() => {}}
			query=""
			onQueryChange={() => {}}
			filter="all"
			onFilterChange={() => {}}
			{...props}
		/>,
	)
}

describe("TemplateList", () => {
	it("splits templates into ready and needs-setup sections", () => {
		renderList()
		expect(screen.getByRole("heading", { name: "Ready for your data" })).toBeDefined()
		expect(screen.getByRole("heading", { name: "Needs setup" })).toBeDefined()
		expect(screen.getByText("Service Health")).toBeDefined()
		expect(screen.getByText("Postgres Overview")).toBeDefined()
		// The row states the missing prefix, not the receiver name.
		expect(screen.getByText("no postgresql.*")).toBeDefined()
	})

	// The search-result count is computed before the readiness filter runs, so a
	// filter that excludes every match used to empty both sections while the
	// "no results" state stayed hidden — a blank list with no explanation.
	it("explains an empty list when the readiness filter excludes every match", () => {
		renderList({ query: "postgres", filter: "ready" })

		expect(screen.queryByText("Postgres Overview")).toBeNull()
		expect(screen.getByText("None of these are ready yet")).toBeDefined()
		expect(screen.getByRole("button", { name: "Show all templates" })).toBeDefined()
	})

	it("explains the inverse case too", () => {
		renderList({ query: "service", filter: "needs-setup" })

		expect(screen.queryByText("Service Health")).toBeNull()
		expect(screen.getByText("These are all ready to use")).toBeDefined()
	})

	it("keeps the search empty state when nothing matches at all", () => {
		const { container } = renderList({ query: "nothing-matches-this" })

		expect(screen.getByText(/No template matches/)).toBeDefined()
		// Scoped to the empty state — the search input carries its own clear button.
		const empty = container.querySelector("[data-slot=empty]")
		expect(empty).not.toBeNull()
		expect(within(empty as HTMLElement).getByRole("button", { name: "Clear search" })).toBeDefined()
	})

	it("pins the blank row outside the catalogue", () => {
		renderList()
		expect(screen.getByText("Blank dashboard")).toBeDefined()
	})
})
