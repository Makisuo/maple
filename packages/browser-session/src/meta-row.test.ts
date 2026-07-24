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
