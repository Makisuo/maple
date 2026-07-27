import { describe, expect, it } from "vitest"
import { buildSessionMetaRow } from "./meta-row"

// `maple.session.recorded` is the only signal the Sessions UI has for telling a
// metadata-only session (replay off / unsampled) apart from one whose chunks
// are still uploading. Both SDK paths post through this builder, so the marker
// must be present and correctly valued on every row it emits.

const base = {
	sessionId: "sess-1",
	startedAt: new Date("2026-07-24T10:00:00.000Z"),
	version: 1,
	serviceName: "unit-test",
} as const

describe("buildSessionMetaRow recording marker", () => {
	it("marks a recorded session", () => {
		const row = buildSessionMetaRow({ ...base, status: "active", recorded: true })
		const attrs = row.resource_attributes as Record<string, string>
		expect(attrs["maple.session.recorded"]).toBe("true")
	})

	it("marks a metadata-only session", () => {
		const row = buildSessionMetaRow({ ...base, status: "active", recorded: false })
		const attrs = row.resource_attributes as Record<string, string>
		expect(attrs["maple.session.recorded"]).toBe("false")
	})

	it("keeps the marker on ended rows alongside the dual-emitted environment", () => {
		const row = buildSessionMetaRow({
			...base,
			status: "ended",
			recorded: true,
			environment: "production",
			traceIds: ["trace-1"],
		})
		const attrs = row.resource_attributes as Record<string, string>
		expect(attrs["maple.session.recorded"]).toBe("true")
		expect(attrs["deployment.environment"]).toBe("production")
		expect(attrs["deployment.environment.name"]).toBe("production")
		expect(row.trace_ids).toEqual(["trace-1"])
	})
})

// `error_count` is what the Sessions UI "has errors" filter tests (ErrorCount > 0),
// and `page_views` feeds the session list. Both were absent from the row for
// months, so every session reported 0 and the filter matched nothing.
describe("buildSessionMetaRow session counters", () => {
	it("writes all three counters on ended rows", () => {
		const row = buildSessionMetaRow({
			...base,
			status: "ended",
			recorded: true,
			clickCount: 7,
			pageViews: 4,
			errorCount: 2,
		})
		expect(row.click_count).toBe(7)
		expect(row.page_views).toBe(4)
		expect(row.error_count).toBe(2)
	})

	it("defaults counters to 0 rather than omitting them", () => {
		const row = buildSessionMetaRow({ ...base, status: "ended", recorded: false })
		expect(row.page_views).toBe(0)
		expect(row.error_count).toBe(0)
	})

	it("leaves counters off active rows", () => {
		const row = buildSessionMetaRow({ ...base, status: "active", recorded: true, errorCount: 3 })
		expect(row).not.toHaveProperty("error_count")
		expect(row).not.toHaveProperty("page_views")
	})
})
