import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { QueryBuilderHbarChart } from "../query-builder-hbar-chart"

beforeAll(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		right: 800,
		bottom: 400,
		width: 800,
		height: 400,
		toJSON: () => ({}),
	})
})

afterEach(cleanup)

/** The row labels, top to bottom. */
function rowLabels(container: HTMLElement): string[] {
	return [...container.querySelectorAll("span[title]")].map((node) => node.textContent ?? "")
}

/** Each bar's fill width, which encodes its share of the LARGEST row. */
function barWidths(container: HTMLElement): string[] {
	return [...container.querySelectorAll("div[style*='width']")].map(
		(node) => (node as HTMLElement).style.width,
	)
}

describe("query-builder hbar: ranking", () => {
	it("sorts by value rather than trusting the query's order", () => {
		// The panel's whole claim is that it is ranked, and a breakdown without an
		// ORDER BY isn't.
		const { container } = render(
			<QueryBuilderHbarChart
				data={[
					{ name: "middle", value: 30 },
					{ name: "largest", value: 60 },
					{ name: "smallest", value: 10 },
				]}
			/>,
		)
		expect(rowLabels(container)).toEqual(["largest", "middle", "smallest"])
	})
})

describe("query-builder hbar: shares", () => {
	const rows = [
		{ name: "a", value: 60 },
		{ name: "b", value: 30 },
		{ name: "c", value: 10 },
	]

	it("labels each row with its share of the TOTAL", () => {
		// Not a share of the largest row, which is what the funnel does and why
		// four unrelated operations of equal size all rendered "100%" there. Only
		// the share of the total sums to 100% across the panel.
		const { container } = render(<QueryBuilderHbarChart data={rows} />)
		const text = container.textContent ?? ""
		expect(text).toContain("60%")
		expect(text).toContain("30%")
		expect(text).toContain("10%")
	})

	it("still draws bar LENGTH against the largest row", () => {
		// The two readings differ deliberately: the number answers "what share of
		// everything", the bar answers "how does this compare to the leader", and
		// the leader's bar has to fill the track for the panel to read as a ranking.
		const { container } = render(<QueryBuilderHbarChart data={rows} />)
		expect(barWidths(container)).toEqual(["100%", "50%", `${(10 / 60) * 100}%`])
	})

	it("keeps a real but tiny row visible", () => {
		const { container } = render(
			<QueryBuilderHbarChart
				data={[
					{ name: "big", value: 100000 },
					{ name: "tiny", value: 1 },
				]}
			/>,
		)
		// A 0.001% bar would round to no pixels at all, so it floors at 2%.
		expect(barWidths(container)).toEqual(["100%", "2%"])
		expect(container.textContent ?? "").toContain("<0.1%")
	})

	it("drops rows with nothing to rank", () => {
		const { container } = render(<QueryBuilderHbarChart data={[...rows, { name: "zero", value: 0 }]} />)
		expect(rowLabels(container)).toEqual(["a", "b", "c"])
	})
})
