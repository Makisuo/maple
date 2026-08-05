import { describe, expect, it } from "vitest"

import { detailLinkProps, type AgentTraceRow } from "./agent-trace-row"

describe("detailLinkProps", () => {
	const agentTrace = {
		agentTraceId: "conv_9f21",
		startTime: "2026-03-08 14:30:05",
	} satisfies Pick<AgentTraceRow, "agentTraceId" | "startTime">

	it("carries the agent trace's own start time as the detail route's scan hint", () => {
		// Without `t` the detail route bounds its scan to the last 7 days ending
		// now: an agent trace listed under an older custom range would 404 on click, and
		// every other click would scan a week of partitions to find one id.
		expect(detailLinkProps(agentTrace)).toEqual({
			to: "/agent-traces/$agentTraceId",
			params: { agentTraceId: "conv_9f21" },
			search: { t: "2026-03-08 14:30:05" },
		})
	})

	it("passes the hint through as a warehouse timestamp string, not epoch ms", () => {
		// `$agentTraceId.tsx` decodes `t` with `warehouseDateTimeToIso` — a number here
		// would parse to NaN and silently fall back to the wide window.
		const { search } = detailLinkProps(agentTrace)
		expect(typeof (search as { t: string }).t).toBe("string")
		expect(Number.isNaN(Date.parse(`${(search as { t: string }).t.replace(" ", "T")}Z`))).toBe(false)
	})
})
