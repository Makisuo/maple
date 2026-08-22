// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { AlertCheckDocument, IsoDateTimeString } from "@maple/domain/http"
import type { AlertRulePreviewResponse } from "@maple/domain/http"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AlertRuleChart } from "./alert-rule-chart"

afterEach(() => {
	cleanup()
})

const WINDOW_START = Date.parse("2026-08-01T00:00:00.000Z")
const WINDOW_END = Date.parse("2026-08-02T00:00:00.000Z")
const domain = { min: WINDOW_START, max: WINDOW_END }

const iso = (ms: number) => IsoDateTimeString.make(new Date(ms).toISOString())

function check(offsetMinutes: number, status: AlertCheckDocument["status"], observed: number) {
	const at = WINDOW_START + offsetMinutes * 60_000
	return new AlertCheckDocument({
		timestamp: iso(at),
		groupKey: "all",
		status,
		signalType: "error_rate",
		comparator: "gt",
		threshold: 0.05,
		thresholdUpper: null,
		observedValue: observed,
		sampleCount: 100,
		windowMinutes: 15,
		windowStart: iso(at),
		windowEnd: iso(at + 900_000),
		consecutiveBreaches: 0,
		consecutiveHealthy: 0,
		incidentId: null,
		incidentTransition: "none",
		evaluationDurationMs: 12,
		errorMessage: null,
		errorCategory: null,
	})
}

/** A preview with real points, i.e. the "Query" source is available. */
// SAFETY: this focused fixture supplies every preview field rendered by AlertRuleChart.
const preview = {
	bucketSeconds: 900,
	series: [
		{
			groupKey: "all",
			points: [
				{
					bucket: iso(WINDOW_START),
					value: 0.02,
					sampleCount: 100,
					status: "healthy",
					provisional: false,
				},
				{
					bucket: iso(WINDOW_START + 900_000),
					value: 0.09,
					sampleCount: 100,
					status: "breached",
					provisional: false,
				},
			],
		},
	],
	wouldFire: [],
	truncatedToStart: null,
} as unknown as AlertRulePreviewResponse

/** Every window came back empty — the case that used to swap sources silently. */
// SAFETY: this focused fixture supplies every preview field rendered by AlertRuleChart.
const emptyPreview = {
	bucketSeconds: 900,
	series: [
		{
			groupKey: "all",
			points: [
				{
					bucket: iso(WINDOW_START),
					value: null,
					sampleCount: 0,
					status: "skipped",
					provisional: false,
				},
			],
		},
	],
	wouldFire: [],
	truncatedToStart: null,
} as unknown as AlertRulePreviewResponse

const checks = [check(0, "healthy", 0.02), check(30, "breached", 0.09), check(60, "healthy", 0.03)]

/** The server capped the replay, so the series covers only the last 6h of 24h. */
// SAFETY: this focused fixture supplies every preview field rendered by AlertRuleChart.
const truncatedPreview = {
	...preview,
	series: [
		{
			groupKey: "all",
			points: [
				{
					bucket: iso(WINDOW_END - 6 * 3_600_000),
					value: 0.02,
					sampleCount: 100,
					status: "healthy",
					provisional: false,
				},
			],
		},
	],
	truncatedToStart: iso(WINDOW_END - 6 * 3_600_000),
} as unknown as AlertRulePreviewResponse

const baseProps = {
	threshold: 0.05,
	comparator: "gt" as const,
	signalType: "error_rate" as const,
	window: domain,
	checks,
}

describe("alert rule chart source toggle", () => {
	// The old chart auto-picked its series and only mentioned the swap when the
	// preview *errored* — an empty-but-successful preview changed what the chart
	// meant with no indication at all.
	it("says so when the requested source is empty and it falls back", () => {
		render(<AlertRuleChart {...baseProps} preview={emptyPreview} source="preview" />)
		expect(screen.getByText(/Showing/)).toBeTruthy()
		expect(screen.getByText(/query has no points in this window/i)).toBeTruthy()
	})

	it("stays quiet when the requested source is the one drawn", () => {
		render(<AlertRuleChart {...baseProps} preview={preview} source="preview" />)
		expect(screen.queryByText(/has no points in this window/i)).toBeNull()
	})

	it("honours a request for the recorded values when both sources exist", () => {
		render(<AlertRuleChart {...baseProps} preview={preview} source="checks" />)
		// No fallback notice: "Evaluated" was asked for and "Evaluated" is drawn.
		expect(screen.queryByText(/has no points in this window/i)).toBeNull()
		// The unselected source is offered as a comparison ghost instead.
		expect(screen.getByText("Query")).toBeTruthy()
	})
})

// The framing rule itself is `resolveChartDomain`, unit-tested in
// lib/alerts/chart-series.test.ts. What is component-level here is the caption:
// it must describe what the reader is actually looking at in each case.
describe("alert rule chart truncated preview caption", () => {
	it("says the axis moved when the preview owns it", () => {
		render(
			<AlertRuleChart
				{...baseProps}
				checks={[]}
				preview={truncatedPreview}
				source="preview"
				onSelectBucket={vi.fn()}
			/>,
		)
		expect(screen.getByText(/Axis starts at/)).toBeTruthy()
	})

	it("says only the series is short when the rail shares the axis", () => {
		render(<AlertRuleChart {...baseProps} preview={truncatedPreview} source="preview" />)
		expect(screen.getByText(/Query series starts at/)).toBeTruthy()
		// 60 cells still span the full 24h window: the +30min check lands in cell 1.
		const cells = screen.getAllByRole("button")
		expect(cells.length).toBe(60)
	})
})

describe("alert rule chart rail", () => {
	it("states its own coverage, so the capped table below can't look contradictory", () => {
		render(
			<AlertRuleChart
				{...baseProps}
				preview={preview}
				source="preview"
				railCoverage="60 buckets · covers all of last 24 hours"
			/>,
		)
		expect(screen.getByText("60 buckets · covers all of last 24 hours")).toBeTruthy()
	})

	it("labels both lanes and tallies the window", () => {
		render(<AlertRuleChart {...baseProps} preview={preview} source="preview" />)
		expect(screen.getByText("Eval")).toBeTruthy()
		expect(screen.getByText("Incident")).toBeTruthy()
		expect(screen.getByText("Healthy 2")).toBeTruthy()
		expect(screen.getByText("Breached 1")).toBeTruthy()
	})

	it("reports the clicked bucket with its own time bounds", () => {
		const onSelectBucket = vi.fn()
		render(
			<AlertRuleChart
				{...baseProps}
				preview={preview}
				source="preview"
				onSelectBucket={onSelectBucket}
			/>,
		)
		// 60 cells over 24h → each spans 24 minutes; the breach at +30min is cell 1.
		const cells = screen.getAllByRole("button")
		fireEvent.click(cells[1]!)
		expect(onSelectBucket).toHaveBeenCalledTimes(1)
		const [index, bucket] = onSelectBucket.mock.calls[0]!
		expect(index).toBe(1)
		expect(bucket.start).toBe(WINDOW_START + 24 * 60_000)
		expect(bucket.end).toBe(WINDOW_START + 48 * 60_000)
	})

	it("toggles a selected bucket back off", () => {
		const onSelectBucket = vi.fn()
		render(
			<AlertRuleChart
				{...baseProps}
				preview={preview}
				source="preview"
				selectedBucket={1}
				onSelectBucket={onSelectBucket}
			/>,
		)
		fireEvent.click(screen.getAllByRole("button")[1]!)
		expect(onSelectBucket.mock.calls[0]![0]).toBeNull()
	})
})
