// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { TimeDisplayProvider } from "@maple/ui/lib/time-display-context"
import type { TimeZoneId } from "@maple/ui/lib/time-format"
import { useTimeFormat } from "./use-time-format"
import { IssueOccurrenceSparkline } from "@/components/errors/issue-occurrence-sparkline"

// Casting bypasses the import-restricted `makeTimeZoneId` constructor — tests are
// the one place allowed to mint a zone without the preference system.
const UTC = "UTC" as unknown as TimeZoneId
const KOLKATA = "Asia/Kolkata" as unknown as TimeZoneId

// Mirrors exactly what a chart's XAxis `tickFormatter` does: read the active
// display zone from context via the bound hook, then format a bucket.
function TickProbe({ bucket }: { bucket: string }) {
	const { formatBucketLabel } = useTimeFormat()
	return <span data-testid="tick">{formatBucketLabel(bucket, { rangeMs: 0, bucketSeconds: 60 }, "tick")}</span>
}

afterEach(() => {
	cleanup()
})

describe("useTimeFormat through TimeDisplayProvider", () => {
	// 20:00 UTC is 01:30 the next day in Asia/Kolkata (+05:30).
	const bucket = "2024-06-15T20:00:00Z"

	it("renders a chart-style tick label in the provider's timezone", () => {
		const { unmount } = render(
			<TimeDisplayProvider timeZone={UTC}>
				<TickProbe bucket={bucket} />
			</TimeDisplayProvider>,
		)
		const utcLabel = screen.getByTestId("tick").textContent
		unmount()

		render(
			<TimeDisplayProvider timeZone={KOLKATA}>
				<TickProbe bucket={bucket} />
			</TimeDisplayProvider>,
		)
		const kolkataLabel = screen.getByTestId("tick").textContent

		// The same instant renders differently under the two zones — the whole
		// point of threading the display timezone through the formatters.
		expect(utcLabel).not.toBe(kolkataLabel)
		expect(utcLabel).toContain("08:00")
		expect(kolkataLabel).toContain("01:30")
	})

	it("mounts a real chart under the provider without throwing", () => {
		// A real chart component reads the display zone through useTimeDisplay/
		// useTimeFormat; this proves that wiring resolves under the provider.
		// (recharts draws no <svg> in jsdom's zero-size container, so we assert the
		// component mounts rather than snapshotting SVG internals.)
		const data = [
			{ bucket: "2024-06-15T20:00:00Z", count: 3 },
			{ bucket: "2024-06-15T21:00:00Z", count: 5 },
		]
		const { container } = render(
			<TimeDisplayProvider timeZone={KOLKATA}>
				<IssueOccurrenceSparkline data={data} />
			</TimeDisplayProvider>,
		)
		expect(container.firstChild).toBeTruthy()
	})
})
