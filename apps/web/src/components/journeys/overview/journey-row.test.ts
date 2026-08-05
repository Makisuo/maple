import { describe, expect, it } from "vitest"

import { detailLinkProps, type JourneyRow } from "./journey-row"

describe("detailLinkProps", () => {
	const journey = {
		journeyId: "conv_9f21",
		startTime: "2026-03-08 14:30:05",
	} satisfies Pick<JourneyRow, "journeyId" | "startTime">

	it("carries the journey's own start time as the detail route's scan hint", () => {
		// Without `t` the detail route bounds its scan to the last 7 days ending
		// now: a journey listed under an older custom range would 404 on click, and
		// every other click would scan a week of partitions to find one id.
		expect(detailLinkProps(journey)).toEqual({
			to: "/journeys/$journeyId",
			params: { journeyId: "conv_9f21" },
			search: { t: "2026-03-08 14:30:05" },
		})
	})

	it("passes the hint through as a warehouse timestamp string, not epoch ms", () => {
		// `$journeyId.tsx` decodes `t` with `warehouseDateTimeToIso` — a number here
		// would parse to NaN and silently fall back to the wide window.
		const { search } = detailLinkProps(journey)
		expect(typeof (search as { t: string }).t).toBe("string")
		expect(Number.isNaN(Date.parse(`${(search as { t: string }).t.replace(" ", "T")}Z`))).toBe(false)
	})
})
