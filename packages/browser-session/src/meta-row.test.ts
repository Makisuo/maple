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
		const row = buildSessionMetaRow({
			...base,
			status: "active",
			recorded: true,
		})
		const attrs = row.resource_attributes as Record<string, string>
		expect(attrs["maple.session.recorded"]).toBe("true")
	})

	it("marks a metadata-only session", () => {
		const row = buildSessionMetaRow({
			...base,
			status: "active",
			recorded: false,
		})
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
		const row = buildSessionMetaRow({
			...base,
			status: "ended",
			recorded: false,
		})
		expect(row.page_views).toBe(0)
		expect(row.error_count).toBe(0)
	})

	it("writes counters on active rows too, so a killed tab is not a false bounce", () => {
		// The backend resolves each field with argMax(field, Version). A tab closed
		// without an unload beacon never posts an ended row, so if the counters
		// only rode on that row, the surviving active row would report 0 page views
		// and 0 clicks — indistinguishable from a real bounce.
		const row = buildSessionMetaRow({
			...base,
			status: "active",
			recorded: true,
			errorCount: 3,
			pageViews: 5,
			clickCount: 9,
		})
		expect(row.error_count).toBe(3)
		expect(row.page_views).toBe(5)
		expect(row.click_count).toBe(9)
		// End-of-session facts stay on the ended row — an active row has no end.
		expect(row).not.toHaveProperty("end_time")
		expect(row).not.toHaveProperty("duration_ms")
		expect(row).not.toHaveProperty("trace_ids")
	})
})

// ReplacingMergeTree replaces the whole row at the latest Version rather than
// merging fields, so anything emitted on only one of the two row versions is
// destroyed by the other. Attribution has to be on the base row.
describe("buildSessionMetaRow analytics fields", () => {
	const entry = {
		entryUrl: "https://maple.dev/pricing?utm_source=twitter&email=leak@example.com",
		referrer: "https://news.ycombinator.com/item?id=1",
		utm: { utm_source: "twitter", utm_medium: "social" },
	}

	it("carries visitor, identity and acquisition on both row versions", () => {
		for (const status of ["active", "ended"] as const) {
			const row = buildSessionMetaRow({
				...base,
				status,
				recorded: true,
				visitorId: "visitor-1",
				visitorIsNew: true,
				visitorIdPersisted: true,
				identity: {
					id: "user_123",
					email: "user@example.com",
					username: "John Doe",
					groupId: "org_456",
					groupName: "Acme Inc.",
					traits: { plan: "premium" },
				},
				entry,
				lastUrl: "https://maple.dev/checkout",
			})

			expect(row.visitor_id).toBe("visitor-1")
			expect(row.visitor_is_new).toBe(1)
			expect(row.user_id).toBe("user_123")
			expect(row.user_email).toBe("user@example.com")
			expect(row.group_id).toBe("org_456")
			expect(row.group_name).toBe("Acme Inc.")
			expect(row.user_traits).toEqual({ plan: "premium" })
			expect(row.referrer).toBe("https://news.ycombinator.com/item?id=1")
			expect(row.utm_source).toBe("twitter")
			expect(row.utm_medium).toBe("social")
		}
	})

	it("stores paths without the query string", () => {
		const row = buildSessionMetaRow({
			...base,
			status: "ended",
			recorded: true,
			entry,
			lastUrl: "https://maple.dev/checkout?step=2",
		})
		// Query strings are the most common accidental PII carrier — the entry URL
		// above smuggles an email — and nobody groups by /pricing?ref=x separately.
		expect(row.entry_path).toBe("/pricing")
		expect(row.exit_path).toBe("/checkout")
	})

	it("does not derive referrer_host — the gateway owns that normalization", () => {
		const row = buildSessionMetaRow({
			...base,
			status: "active",
			recorded: true,
			entry,
		})
		expect(row).not.toHaveProperty("referrer_host")
	})

	it("suppresses the email when the host app opted out", () => {
		const row = buildSessionMetaRow({
			...base,
			status: "active",
			recorded: true,
			captureUserEmail: false,
			identity: { id: "user_123", email: "user@example.com", traits: {} },
		})
		expect(row.user_email).toBe("")
		expect(row.user_id).toBe("user_123")
	})

	it("flags a visitor id that storage refused to persist", () => {
		const row = buildSessionMetaRow({
			...base,
			status: "active",
			recorded: true,
			visitorId: "ephemeral-1",
			visitorIdPersisted: false,
		})
		const attrs = row.resource_attributes as Record<string, string>
		// Otherwise every private-mode session looks like a distinct visitor and
		// unique counts quietly inflate.
		expect(attrs["maple.visitor.persisted"]).toBe("false")
	})

	it("falls back to the legacy userId when no identity was set", () => {
		const row = buildSessionMetaRow({
			...base,
			status: "active",
			recorded: true,
			userId: "user_legacy",
		})
		expect(row.user_id).toBe("user_legacy")
		expect(row.group_id).toBe("")
	})
})

// `maple.session.replay_format` tells the web player which engine to mount
// before it downloads a chunk. The browser SDK can only ever produce rrweb; the
// mobile SDKs stamp "video". It must be on BOTH the active and ended rows:
// session_replays is a ReplacingMergeTree that replaces the whole row at the
// latest Version, so a marker emitted only on the active row would be destroyed
// by the ended row and the player would silently fall back to rrweb.
describe("buildSessionMetaRow replay format marker", () => {
	it("stamps rrweb on the active row", () => {
		const row = buildSessionMetaRow({ ...base, status: "active", recorded: true })
		const attrs = row.resource_attributes as Record<string, string>
		expect(attrs["maple.session.replay_format"]).toBe("rrweb")
	})

	it("stamps rrweb on the ended row too, so the merge cannot drop it", () => {
		const row = buildSessionMetaRow({
			...base,
			status: "ended",
			recorded: true,
			environment: "production",
			traceIds: ["trace-1"],
		})
		const attrs = row.resource_attributes as Record<string, string>
		expect(attrs["maple.session.replay_format"]).toBe("rrweb")
	})

	it("stamps it even when no replay was recorded", () => {
		// A metadata-only session still describes what it *would* have recorded, so
		// the attribute stays uniform across every row this builder emits.
		const row = buildSessionMetaRow({ ...base, status: "active", recorded: false })
		const attrs = row.resource_attributes as Record<string, string>
		expect(attrs["maple.session.replay_format"]).toBe("rrweb")
	})
})
