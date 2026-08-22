// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { planetScaleAlertSuggestions } from "@/components/infra/planetscale/planetscale-alert-suggestions"
import type { WhereClauseAutocompleteValues } from "@/lib/query-builder/where-clause-autocomplete"
import { QueryPanel } from "./query-panel"

afterEach(cleanup)

const emptyAutocomplete: WhereClauseAutocompleteValues = {}

// One of the real "Alert on this" drafts — a gauge the metrics list is not
// guaranteed to contain.
const prefilled = planetScaleAlertSuggestions({ database: "checkout", kind: "postgresql" })[0]!.draft

const renderPanel = (
	metricSelectionOptions: React.ComponentProps<typeof QueryPanel>["metricSelectionOptions"],
) =>
	render(
		<QueryPanel
			query={prefilled}
			index={0}
			canRemove={false}
			metricSelectionOptions={metricSelectionOptions}
			autocompleteValues={{
				traces: emptyAutocomplete,
				logs: emptyAutocomplete,
				metrics: emptyAutocomplete,
			}}
			onUpdate={vi.fn()}
			onAggregationChange={vi.fn()}
			onMetricSelectionChange={vi.fn()}
			onClone={vi.fn()}
			onRemove={vi.fn()}
			onDataSourceChange={vi.fn()}
		/>,
	)

// The options list is one fetched page, so a prefilled metric is often absent
// from it — leaving the combobox with no item to render the selection from.
describe("QueryPanel metric combobox", () => {
	const openMetricList = () => {
		const trigger = document.querySelector('[data-slot="combobox-trigger"]')
		if (!trigger) throw new Error("metric combobox trigger not rendered")
		fireEvent.click(trigger)
	}

	it("offers the prefilled metric even when the fetched page omits it", () => {
		renderPanel([])
		openMetricList()

		expect(screen.getByRole("option", { name: `${prefilled.metricName} (gauge)` })).toBeDefined()
		// The empty-state must not claim there are no metrics while one is selected.
		expect(screen.queryByText("No metrics found.")).toBeNull()
	})

	it("does not duplicate the metric when the fetched page already has it", () => {
		renderPanel([
			{
				value: `${prefilled.metricName}::gauge`,
				label: `${prefilled.metricName} (gauge)`,
				isMonotonic: false,
			},
		])
		openMetricList()

		expect(screen.getAllByRole("option", { name: `${prefilled.metricName} (gauge)` })).toHaveLength(1)
	})

	it("still shows the empty state when nothing is selected and nothing was fetched", () => {
		render(
			<QueryPanel
				query={{ ...prefilled, metricName: "" }}
				index={0}
				canRemove={false}
				metricSelectionOptions={[]}
				autocompleteValues={{
					traces: emptyAutocomplete,
					logs: emptyAutocomplete,
					metrics: emptyAutocomplete,
				}}
				onUpdate={vi.fn()}
				onAggregationChange={vi.fn()}
				onMetricSelectionChange={vi.fn()}
				onClone={vi.fn()}
				onRemove={vi.fn()}
				onDataSourceChange={vi.fn()}
			/>,
		)
		openMetricList()

		expect(screen.getByText("No metrics found.")).toBeDefined()
	})
})

describe("QueryPanel source select", () => {
	it("offers an extra source only when asked", () => {
		render(
			<QueryPanel
				query={prefilled}
				index={0}
				canRemove={false}
				metricSelectionOptions={[]}
				autocompleteValues={{
					traces: emptyAutocomplete,
					logs: emptyAutocomplete,
					metrics: emptyAutocomplete,
				}}
				onUpdate={vi.fn()}
				onAggregationChange={vi.fn()}
				onMetricSelectionChange={vi.fn()}
				onClone={vi.fn()}
				onRemove={vi.fn()}
				onDataSourceChange={vi.fn()}
				extraSourceOptions={["product_events"]}
				onExtraSourceChange={vi.fn()}
			/>,
		)
		fireEvent.click(screen.getByRole("combobox", { name: "Query source" }))
		expect(screen.getByRole("option", { name: "Product events" })).toBeTruthy()
		expect(screen.getByRole("option", { name: "Traces" })).toBeTruthy()
	})

	it("does not offer Product events to an ordinary query", () => {
		renderPanel([])
		fireEvent.click(screen.getByRole("combobox", { name: "Query source" }))
		expect(screen.queryByRole("option", { name: "Product events" })).toBeNull()
	})
})
