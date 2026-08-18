import type {
	ChartKey,
	ChartMark,
	ChartValue,
	MarkRenderContext,
	ResolvedScale,
	SceneNode,
} from "@tanstack/charts"
import { afterEach, describe, expect, it } from "vitest"

import { canvasSafeThresholdColor, thresholdRules } from "../threshold-rules"

const TOKENS = ["--destructive", "--chart-warning"] as const

afterEach(() => {
	for (const token of TOKENS) document.documentElement.style.removeProperty(token)
})

/**
 * A scale that reports the value it was handed.
 *
 * The marks under test only ask a scale to place a value, so an identity map
 * makes the assertions read as "this rule sits at 500" rather than as pixel
 * arithmetic. Dates map to their epoch so the x anchor stays comparable.
 */
function identityScale(id: string): ResolvedScale {
	const map = (value: unknown): number => (value instanceof Date ? value.getTime() : Number(value))
	return {
		id,
		type: "configured",
		domain: [0, 1000],
		map,
		ticks: [],
		bandwidth: 0,
	}
}

const RENDER_CONTEXT: MarkRenderContext = {
	markIndex: 0,
	surface: { x: 0, y: 0, width: 200, height: 100 },
	chart: { x: 0, y: 0, width: 200, height: 100 },
	scales: { x: identityScale("x"), y: identityScale("y") },
	theme: {
		foreground: "#fafafa",
		muted: "#a1a1aa",
		grid: "#27272a",
		background: "#0c0a09",
		palette: ["#6366f1"],
	},
	color: (value: ChartKey | null | undefined) => (value == null ? "#fafafa" : String(value)),
	colors: {
		type: "ordinal",
		domain: [],
		range: [],
		map: () => "#6366f1",
	},
	layout: {},
}

/** Every leaf scene node a mark emits, with its group wrapper unwrapped. */
function renderNodes(mark: ChartMark<never, ChartValue, ChartValue>, markIndex = 0): SceneNode[] {
	const initialized = mark.initialize({ markIndex })
	const scene = initialized.render({ ...RENDER_CONTEXT, markIndex })
	return scene.nodes.flatMap((node) => (node.kind === "group" ? [...node.children] : [node]))
}

const SLO: ReadonlyArray<{ value: number; color?: string; label?: string }> = [
	{ value: 500, color: "#ef4444", label: "SLO" },
]

describe("thresholdRules", () => {
	it("draws nothing for an empty or non-finite threshold list", () => {
		expect(thresholdRules([])).toEqual([])
		expect(thresholdRules([{ value: Number.NaN }])).toEqual([])
	})

	it("draws the dashes at the width they were asked for", () => {
		// `roundCapDasharray` compensates for the round cap `lineY` hard-codes.
		// `ruleY` sets no cap at all (`dist/rule.js`), so running the dash through
		// that compensation painted 3-on/5-off where 4/4 was intended.
		const [rule] = renderNodes(thresholdRules(SLO)[0])
		expect(rule.kind).toBe("rule")
		expect(rule.kind === "rule" ? rule.style?.strokeDasharray : undefined).toBe("4 4")
	})

	it("keeps the stroke weight and opacity the reference line had", () => {
		const [rule] = renderNodes(thresholdRules(SLO)[0])
		if (rule.kind !== "rule") throw new Error("expected a rule node")
		expect(rule.style?.strokeWidth).toBe(1.5)
		// `ruleY` defaults to 0.5, which left the line too faint to read.
		expect(rule.style?.strokeOpacity).toBe(1)
	})

	it("labels the rule, which is the only thing telling it from any other dash", () => {
		const anchor = new Date("2026-08-18T06:00:00Z")
		const marks = thresholdRules(SLO, { labelX: anchor })
		expect(marks).toHaveLength(2)

		const [label] = renderNodes(marks[1], 1)
		if (label.kind !== "label") throw new Error("expected a label node")
		expect(label.text).toBe("SLO")
		expect(label.fontSize).toBe(10)
		// insideTopRight: at the right end of the domain, anchored to its end,
		// nudged in and up off its own rule.
		expect(label.anchor).toBe("end")
		expect(label.x).toBe(anchor.getTime() - 4)
		expect(label.y).toBe(500 - 6)
		expect(label.style?.fill).toBe("#ef4444")
	})

	it("omits the label rather than guessing where it goes", () => {
		// A `text` mark has no notion of a plot corner — without an x anchor there
		// is no honest position for it.
		expect(thresholdRules(SLO)).toHaveLength(1)
		// And a threshold with no label contributes no text mark at all.
		expect(thresholdRules([{ value: 500 }], { labelX: new Date() })).toHaveLength(1)
	})
})

describe("canvasSafeThresholdColor", () => {
	it("resolves a configured var() token instead of discarding it", () => {
		// Rejecting `var(--token)` swapped a deliberately configured colour for the
		// default red, which reads as the chart ignoring the setting.
		document.documentElement.style.setProperty("--chart-warning", "oklch(0.8 0.16 80)")
		expect(canvasSafeThresholdColor("var(--chart-warning)")).toBe("oklch(0.8 0.16 80)")
	})

	it("falls back to the themed destructive token, not a hard-coded red", () => {
		document.documentElement.style.setProperty("--destructive", "oklch(0.55 0.2 25)")
		expect(canvasSafeThresholdColor(undefined)).toBe("oklch(0.55 0.2 25)")
		// `currentColor` validates as CSS but the canvas 2D context cannot resolve
		// it, so it takes the fallback too.
		expect(canvasSafeThresholdColor("currentColor")).toBe("oklch(0.55 0.2 25)")
	})

	it("keeps a literal colour untouched", () => {
		expect(canvasSafeThresholdColor("#ef4444")).toBe("#ef4444")
	})

	it("rejects a value that is not a colour at all", () => {
		document.documentElement.style.setProperty("--destructive", "oklch(0.55 0.2 25)")
		expect(canvasSafeThresholdColor("url(https://example.com/x.png)")).toBe("oklch(0.55 0.2 25)")
	})
})
