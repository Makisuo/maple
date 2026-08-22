// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeQueryDataSource, makeRawSqlDataSource } from "@maple/widgets/dashboard"

import { DashboardTimeRangeWrapper } from "@/components/dashboard-builder/dashboard-providers"
import { WidgetBuilderProvider } from "@/components/dashboard-builder/config/widget-builder-provider"
import { WidgetQueryBuilderPage } from "@/components/dashboard-builder/config/widget-query-builder-page"
import type { DashboardWidget } from "@/components/dashboard-builder/types"

afterEach(cleanup)

const STORED_SQL = "SELECT bucket, count() AS spans FROM traces WHERE $__orgFilter"

const widgetWith = (dataSource: DashboardWidget["dataSource"]): DashboardWidget =>
	({
		id: "w1",
		visualization: "chart",
		dataSource,
		display: { title: "Spans", chartId: "query-builder-line" },
		layout: { x: 0, y: 0, w: 6, h: 6 },
	}) as DashboardWidget

const rawSqlWidget = (sql: string) => widgetWith(makeRawSqlDataSource({ sql, displayType: "line" }))

const builderWidget = () => widgetWith(makeQueryDataSource({ resultShape: "timeseries", queries: [] }))

const editor = (widget: DashboardWidget) => (
	<DashboardTimeRangeWrapper initialTimeRange={{ type: "relative", value: "1h" }}>
		<WidgetBuilderProvider widget={widget}>
			<WidgetQueryBuilderPage widget={widget} onApply={vi.fn()} />
		</WidgetBuilderProvider>
	</DashboardTimeRangeWrapper>
)

const sqlEditor = () => screen.queryByLabelText("SQL query") as HTMLTextAreaElement | null

// The widget prop is not fixed for the life of the editor: the dashboard row can
// reach it after the first render, or be replaced by a later sync. Seeding the
// SQL draft and the Source toggle from the first render alone left a re-opened
// raw-SQL widget showing the Query Builder tab and a template, while the preview
// and the canvas tile drew the stored SQL.
describe("WidgetQueryBuilderPage raw SQL rehydration", () => {
	it("shows the stored SQL when the widget arrives after the first render", () => {
		const { rerender } = render(editor(builderWidget()))
		expect(sqlEditor()).toBeNull()

		rerender(editor(rawSqlWidget(STORED_SQL)))

		expect(sqlEditor()?.value).toBe(STORED_SQL)
	})

	it("follows the widget when its stored SQL changes under an untouched draft", () => {
		const { rerender } = render(editor(rawSqlWidget(STORED_SQL)))
		expect(sqlEditor()?.value).toBe(STORED_SQL)

		const updated = `${STORED_SQL} AND SpanKind = 'Server'`
		rerender(editor(rawSqlWidget(updated)))

		expect(sqlEditor()?.value).toBe(updated)
	})

	it("keeps what the user typed when the widget prop is replaced", () => {
		const { rerender } = render(editor(rawSqlWidget(STORED_SQL)))

		const typed = `${STORED_SQL} AND ServiceName = 'ingest'`
		const textarea = sqlEditor()
		if (!textarea) throw new Error("SQL editor not rendered")
		fireEvent.change(textarea, { target: { value: typed } })

		// A dashboard-level write (a time-range sync, another tile's layout) hands
		// the editor a fresh widget object carrying the same stored SQL.
		rerender(editor(rawSqlWidget(STORED_SQL)))

		expect(sqlEditor()?.value).toBe(typed)
	})
})
