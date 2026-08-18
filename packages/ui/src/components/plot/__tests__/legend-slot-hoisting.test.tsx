import { cleanup, render } from "@testing-library/react"
import { useMemo, useState, type ReactNode } from "react"
import { afterEach, describe, expect, it } from "vitest"

import { PlotLegendSlotContext, usePlotLegendSlot, type PlotLegendItem } from "../plot-frame"

afterEach(cleanup)

/**
 * A stand-in for the widget shell: opens the slot and prints what it received,
 * including the dashed flag, so the published payload is readable as DOM.
 */
function SlotHost({ children }: { children: ReactNode }) {
	const [items, setItems] = useState<readonly PlotLegendItem[]>([])
	const slot = useMemo(() => ({ setItems }), [])
	return (
		<PlotLegendSlotContext value={slot}>
			<div data-testid="host">
				{items.map((item) => (
					<span key={item.key} data-key={item.key} data-dashed={item.dashed === true}>
						{item.label}
					</span>
				))}
			</div>
			{children}
		</PlotLegendSlotContext>
	)
}

/** A chart stand-in: publishes what it is given and reports what it was told. */
function Publisher({ items }: { items: readonly PlotLegendItem[] | null }) {
	const hoisted = usePlotLegendSlot(items)
	return <div data-testid="hoisted">{String(hoisted)}</div>
}

function hoisted(container: HTMLElement): string {
	return container.querySelector("[data-testid='hoisted']")?.textContent ?? ""
}

const series: readonly PlotLegendItem[] = [
	{ key: "requests", label: "Requests", color: "#22d3ee" },
	{ key: "errors", label: "Errors", color: "#f87171", dashed: true },
]

describe("usePlotLegendSlot", () => {
	it("reports no hoist outside a shell", () => {
		// The chart is on a page that opens no slot — the service detail page —
		// so it has to keep drawing its own strip or lose the legend entirely.
		const { container } = render(<Publisher items={series} />)
		expect(hoisted(container)).toBe("false")
	})

	it("reports a hoist inside a shell that was handed a list", () => {
		const { container } = render(
			<SlotHost>
				<Publisher items={series} />
			</SlotHost>,
		)
		expect(hoisted(container)).toBe("true")
	})

	it("reports no hoist when the chart declined, even under an open slot", () => {
		// `null` is the chart saying it draws its own legend. The slot still gets
		// cleared, but an empty header is not a legend anything can rely on.
		const { container } = render(
			<SlotHost>
				<Publisher items={null} />
			</SlotHost>,
		)
		expect(hoisted(container)).toBe("false")
	})

	it("answers during the first render, not a frame later", () => {
		// The publish itself is an effect. If the answer were read back out of it
		// the strip would paint and then withdraw, so this asserts the value is
		// already correct in the DOM the very first commit produces.
		const { container } = render(
			<SlotHost>
				<Publisher items={series} />
			</SlotHost>,
		)
		expect(hoisted(container)).not.toBe("")
	})

	it("carries the dashed flag through to the host", () => {
		// A header that draws every series solid would state something false about
		// a chart whose error line is dashed.
		const { container } = render(
			<SlotHost>
				<Publisher items={series} />
			</SlotHost>,
		)
		const chips = [...container.querySelectorAll("[data-testid='host'] span")]
		expect(chips.map((node) => node.getAttribute("data-key"))).toEqual(["requests", "errors"])
		expect(chips.map((node) => node.getAttribute("data-dashed"))).toEqual(["false", "true"])
	})
})
