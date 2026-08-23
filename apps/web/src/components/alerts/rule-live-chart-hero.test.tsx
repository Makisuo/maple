// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RuleLiveChartHero } from "./rule-live-chart-hero"
import { defaultRuleForm } from "@/lib/alerts/form-utils"

afterEach(() => {
	cleanup()
})

function renderHero(timeRange: Parameters<typeof RuleLiveChartHero>[0]["timeRange"]) {
	return render(
		<RuleLiveChartHero
			form={defaultRuleForm()}
			preview={null}
			previewLoading={false}
			previewError={null}
			onTestRule={vi.fn()}
			testing={false}
			previewResult={null}
			range={{ startTime: "2026-08-01 00:00:00", endTime: "2026-08-02 00:00:00" }}
			timeRange={timeRange}
			onTimeRangeChange={vi.fn()}
		/>,
	)
}

describe("RuleLiveChartHero", () => {
	it("labels the preview picker with the selected preset", () => {
		renderHero({ presetValue: "24h" })
		expect(screen.getByText("Last 24 hours")).toBeTruthy()
	})

	it("labels the preview picker with a custom range's bounds", () => {
		// Bounds are rendered in the viewer's timezone, so assert the shape
		// rather than the exact day/hour.
		renderHero({ startTime: "2026-08-01 12:00:00", endTime: "2026-08-02 12:00:00" })
		expect(screen.getByText(/^Aug \d+, \d{2}:\d{2} - Aug \d+, \d{2}:\d{2}$/)).toBeTruthy()
	})
})
