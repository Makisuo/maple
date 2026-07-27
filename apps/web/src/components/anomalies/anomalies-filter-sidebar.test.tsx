// @vitest-environment jsdom

import { AnomalyIncidentDocument } from "@maple/domain/http"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AnomaliesFilterSidebar } from "./anomalies-filter-sidebar"

const decodeIncident = Schema.decodeUnknownSync(AnomalyIncidentDocument)

let seq = 0
const incident = (overrides: {
	signalType: string
	severity: "warning" | "critical"
	serviceName: string
	deploymentEnv?: string
}) =>
	decodeIncident({
		id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
		detectorKey: "golden-signal",
		deploymentEnv: "production",
		fingerprintHash: null,
		errorIssueId: null,
		status: "open",
		openedValue: 1,
		baselineMedian: 1,
		baselineSigma: 1,
		thresholdValue: 1,
		lastObservedValue: 1,
		lastSampleCount: 1,
		firstTriggeredAt: "2026-07-25T00:00:00.000Z",
		lastTriggeredAt: "2026-07-25T00:00:00.000Z",
		resolvedAt: null,
		resolveReason: null,
		triageStatus: "none",
		fingerprints: [],
		reopenCount: 0,
		lastReopenedAt: null,
		...overrides,
	})

const incidents = [
	incident({ signalType: "error_rate", severity: "critical", serviceName: "api-gateway" }),
	incident({ signalType: "error_rate", severity: "warning", serviceName: "api-gateway" }),
	incident({ signalType: "latency_p95", severity: "warning", serviceName: "checkout" }),
]

afterEach(cleanup)

describe("AnomaliesFilterSidebar", () => {
	it("renders display labels for the fixed vocabularies, not their URL values", () => {
		render(
			<AnomaliesFilterSidebar
				incidents={incidents}
				filters={{}}
				onChange={vi.fn()}
				onClear={vi.fn()}
			/>,
		)

		// Severity and Signal are the sections whose value differs from its label.
		expect(screen.getByText("Critical")).toBeTruthy()
		expect(screen.getByText("Warning")).toBeTruthy()
		expect(screen.getByText("Error rate")).toBeTruthy()
		expect(screen.getByText("p95 latency")).toBeTruthy()
		expect(screen.queryByText("error_rate")).toBeNull()
		expect(screen.queryByText("latency_p95")).toBeNull()

		// Counts still come from the facet tally.
		expect(screen.getByText("Error rate").parentElement?.parentElement?.textContent).toContain("2")
	})

	it("reports the underlying value — not the label — when an option is toggled", () => {
		const onChange = vi.fn()
		render(
			<AnomaliesFilterSidebar
				incidents={incidents}
				filters={{}}
				onChange={onChange}
				onClear={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByText("p95 latency"))
		expect(onChange).toHaveBeenCalledWith("signals", ["latency_p95"])

		onChange.mockClear()
		fireEvent.click(screen.getByText("Critical"))
		expect(onChange).toHaveBeenCalledWith("severity", ["critical"])
	})

	it("clears a dimension when its last selection is removed", () => {
		const onChange = vi.fn()
		render(
			<AnomaliesFilterSidebar
				incidents={incidents}
				filters={{ signals: ["latency_p95"] }}
				onChange={onChange}
				onClear={vi.fn()}
			/>,
		)

		fireEvent.click(screen.getByText("p95 latency"))
		expect(onChange).toHaveBeenCalledWith("signals", undefined)
	})

	it("renders the empty state and no facet sections when there are no incidents", () => {
		render(<AnomaliesFilterSidebar incidents={[]} filters={{}} onChange={vi.fn()} onClear={vi.fn()} />)

		expect(screen.getByText("No anomalies in this view")).toBeTruthy()
		expect(screen.queryByText("Severity")).toBeNull()
		expect(screen.queryByText("Signal")).toBeNull()
	})
})
