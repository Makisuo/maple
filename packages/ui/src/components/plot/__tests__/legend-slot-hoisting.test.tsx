import { act, cleanup, render } from "@testing-library/react"
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

const swappedSeries: readonly PlotLegendItem[] = [
	{ key: "latency", label: "Latency", color: "#a78bfa" },
]

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

/**
 * The loop guard.
 *
 * `usePlotLegendSlot` publishes into state an ANCESTOR owns, so a caller that
 * rebuilds `items` every render used to be a hang, not a slow path: publish →
 * host `setState` → chart re-render → fresh array → publish. An inline
 * `mapSeries` on `useTimeseriesModel` was one arrow function away from it.
 */
describe("usePlotLegendSlot republish guard", () => {
	/**
	 * Counts host commits and rebuilds `items` every render, as the footgun did.
	 *
	 * Past `BREAKER` it stops publishing. Without that the regression does not
	 * FAIL, it hangs — React never trips its update-depth guard here because each
	 * commit is a fresh effect rather than a render-phase update, so the suite
	 * spins until CI kills it. Cutting the loop ourselves turns the same bug into
	 * a one-line assertion failure.
	 */
	const BREAKER = 20

	function LoopHost({ renders }: { renders: { count: number } }) {
		const [items, setItems] = useState<readonly PlotLegendItem[]>([])
		const slot = useMemo(() => ({ setItems }), [])
		renders.count += 1
		return (
			<PlotLegendSlotContext value={slot}>
				<div data-testid="host">{items.map((item) => item.key).join(",")}</div>
				{/* A NEW array each render — never memoised, on purpose. */}
				{renders.count < BREAKER ? (
					<Publisher items={series.map((entry) => ({ ...entry }))} />
				) : null}
			</PlotLegendSlotContext>
		)
	}

	it("settles when the caller rebuilds items every render", () => {
		const renders = { count: 0 }
		const { container } = render(<LoopHost renders={renders} />)

		// The bound is generous — one mount plus the single commit the first
		// publish legitimately causes — and still well under `BREAKER`, so a
		// regression reads as "27 renders" rather than as a timeout.
		expect(renders.count).toBeLessThan(6)
		expect(container.querySelector("[data-testid='host']")?.textContent).toBe("requests,errors")
	})

	it("publishes again when the content actually changes", () => {
		// The guard must not be so eager that a real series change stops reaching
		// the header — a chart swapping group-by keeps its array length.
		function ChangingHost() {
			const [items, setItems] = useState<readonly PlotLegendItem[]>([])
			const slot = useMemo(() => ({ setItems }), [])
			const [swapped, setSwapped] = useState(false)
			return (
				<PlotLegendSlotContext value={slot}>
					<div data-testid="host">{items.map((item) => item.key).join(",")}</div>
					<button type="button" onClick={() => setSwapped(true)}>
						swap
					</button>
					{/*
					 * Both arms are module constants. An inline literal here would be
					 * the very footgun the sibling test covers, and — having no
					 * breaker — would hang this file rather than fail it.
					 */}
					<Publisher items={swapped ? swappedSeries : series} />
				</PlotLegendSlotContext>
			)
		}

		const { container } = render(<ChangingHost />)
		expect(container.querySelector("[data-testid='host']")?.textContent).toBe("requests,errors")

		act(() => {
			container.querySelector("button")?.click()
		})
		expect(container.querySelector("[data-testid='host']")?.textContent).toBe("latency")
	})
})
