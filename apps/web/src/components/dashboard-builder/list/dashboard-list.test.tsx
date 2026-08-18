// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { QUERY_ENDPOINT_RESULT_KINDS } from "@maple/widgets/dashboard"
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

// The row is a router Link; the list itself needs no routing behaviour to render.
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, ...props }: { children?: React.ReactNode }) => <a {...props}>{children}</a>,
}))

import type {
	Dashboard,
	DashboardWidget,
	DataSourceEndpoint,
	VisualizationType,
} from "@/components/dashboard-builder/types"
import { DashboardList } from "./dashboard-list"

afterEach(cleanup)

let seq = 0

// The call sites still name an endpoint, because that is what these tests are
// about (which tiles a dashboard summary counts). v3 moved the identity onto
// `kind`, so the name is mapped to the matching arm here rather than at 20 call
// sites.
const dataSourceFor = (endpoint: DataSourceEndpoint): DashboardWidget["dataSource"] => {
	if (endpoint === "markdown_static") return { kind: "static" }
	if (endpoint === "raw_sql_chart") return { kind: "raw_sql", sql: "SELECT 1" }
	const resultKind = QUERY_ENDPOINT_RESULT_KINDS[endpoint]
	return resultKind === undefined
		? { kind: "route", endpoint }
		: { kind: "query", resultShape: resultKind, queries: [] }
}

const widget = (visualization: VisualizationType, endpoint: DataSourceEndpoint): DashboardWidget => ({
	id: `w${++seq}`,
	visualization,
	dataSource: dataSourceFor(endpoint),
	display: { title: visualization },
	layout: { x: 0, y: 0, w: 4, h: 4 },
})

const dashboard = (overrides: Partial<Dashboard> = {}): Dashboard => ({
	id: "d1",
	name: "Checkout latency",
	timeRange: { type: "relative", value: "24h" },
	widgets: [widget("chart", "list_traces")],
	createdAt: "2026-07-01T00:00:00.000Z",
	updatedAt: "2026-07-20T00:00:00.000Z",
	...overrides,
})

const renderList = (props: Partial<React.ComponentProps<typeof DashboardList>> = {}) =>
	render(
		<DashboardList
			dashboards={[dashboard({ tags: ["api", "slo"] })]}
			favorites={new Set()}
			query=""
			scope="all"
			tags={[]}
			sort="updated"
			onQueryChange={vi.fn()}
			onScopeChange={vi.fn()}
			onTagsChange={vi.fn()}
			onSortChange={vi.fn()}
			onCreate={vi.fn()}
			onDelete={vi.fn()}
			onDuplicate={vi.fn()}
			onExport={vi.fn()}
			onSaveTags={vi.fn()}
			onToggleFavorite={vi.fn()}
			{...props}
		/>,
	)

describe("DashboardList rows", () => {
	it("renders the name, the description and the two right-hand lanes", () => {
		renderList({ dashboards: [dashboard({ description: "p95 by region" })] })
		expect(screen.getByText("Checkout latency")).toBeTruthy()
		expect(screen.getByText("p95 by region")).toBeTruthy()
		// Scope lane, then recency. Both appear once per row.
		expect(screen.getAllByText("1 widget").length).toBeGreaterThan(0)
		expect(screen.getAllByText("Traces").length).toBeGreaterThan(0)
	})

	it("uses the absence vocabulary instead of a zero count", () => {
		renderList({ dashboards: [dashboard({ widgets: [] })] })
		expect(screen.getAllByText("no widgets").length).toBeGreaterThan(0)
		expect(screen.queryByText("0 widgets")).toBeNull()
	})

	it("shows a markdown-only dashboard as static rather than as reading nothing", () => {
		renderList({ dashboards: [dashboard({ widgets: [widget("markdown", "markdown_static")] })] })
		expect(screen.getAllByText("static only").length).toBeGreaterThan(0)
	})

	it("renders the star for a non-favorite too, so it is never hover-only", () => {
		renderList()
		expect(screen.getByRole("button", { name: "Star Checkout latency" })).toBeTruthy()
	})
})

// These opened as runtime crashes: DropdownMenuLabel is Base UI's GroupLabel and
// throws unless a Group / RadioGroup wraps it. Only a render exercises that.
describe("toolbar menus open without throwing", () => {
	it("opens the sort menu with its label and options", () => {
		renderList()
		fireEvent.click(screen.getByRole("button", { name: /Recently updated/ }))
		expect(screen.getByText("Sort by")).toBeTruthy()
		expect(screen.getByRole("menuitemradio", { name: "Name A–Z" })).toBeTruthy()
	})

	// The trigger is a combobox, not a button: `role="combobox"` takes no name from
	// its own content, so the visible "Tags" text only names it via aria-label.
	it("opens the tag combobox with an option per tag", () => {
		renderList()
		fireEvent.click(screen.getByRole("combobox", { name: "Tags" }))
		expect(screen.getByRole("option", { name: "api" })).toBeTruthy()
		expect(screen.getByRole("option", { name: "slo" })).toBeTruthy()
	})

	it("opens a row's overflow menu", () => {
		renderList()
		fireEvent.click(screen.getByRole("button", { name: "More actions for Checkout latency" }))
		expect(screen.getByRole("menuitem", { name: "Export JSON" })).toBeTruthy()
		expect(screen.getByRole("menuitem", { name: "Delete…" })).toBeTruthy()
	})

	it("edits tags from the row menu and reports them normalized", () => {
		const onSaveTags = vi.fn()
		renderList({ onSaveTags })
		fireEvent.click(screen.getByRole("button", { name: "More actions for Checkout latency" }))
		fireEvent.click(screen.getByRole("menuitem", { name: "Edit tags…" }))
		const input = screen.getByLabelText("Add a tag")
		fireEvent.change(input, { target: { value: "Cost" } })
		fireEvent.keyDown(input, { key: "Enter" })
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		expect(onSaveTags).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }), ["api", "cost", "slo"])
	})

	it("disables the write actions in the row menu when the store is unreachable", () => {
		renderList({ readOnly: true })
		fireEvent.click(screen.getByRole("button", { name: "More actions for Checkout latency" }))
		expect(
			screen.getByRole("menuitem", { name: "Edit tags…" }).getAttribute("data-disabled"),
		).not.toBeNull()
	})

	it("keeps the Tags control present but disabled when no dashboard has a tag", () => {
		renderList({ dashboards: [dashboard({ tags: undefined })] })
		const tags = screen.getByRole("button", { name: "Tags" })
		expect(tags.hasAttribute("disabled")).toBe(true)
	})
})

describe("empty states", () => {
	it("leads with templates on first run", () => {
		renderList({ dashboards: [] })
		expect(screen.getByText("No dashboards yet")).toBeTruthy()
		expect(screen.getByText("Browse templates")).toBeTruthy()
	})

	it("distinguishes a search miss from having nothing", () => {
		renderList({ query: "apdex" })
		expect(screen.getByText(/No dashboard matches/)).toBeTruthy()
		// Two are expected: the search input's own clear affordance, and the empty
		// state's CTA. Both are legitimate ways out of a miss.
		expect(screen.getAllByRole("button", { name: "Clear search" }).length).toBe(2)
	})

	it("explains an empty favorites scope as device-local", () => {
		renderList({ scope: "favorites" })
		expect(screen.getByText("Nothing starred on this device")).toBeTruthy()
	})
})
