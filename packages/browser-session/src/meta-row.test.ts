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

describe("buildSessionMetaRow billing marker", () => {
	// This key is the wire contract between three layers that cannot see each
	// other's types: the SDK writes it, the Rust gateway meters on it
	// (`is_billable_visit_start`), and the warehouse maps it via
	// `$.billable_start`. Renaming it here silently stops billing.
	it("emits billable_start as 0/1, never a boolean or an absent key", () => {
		const claimed = buildSessionMetaRow({
			...base,
			status: "active",
			recorded: false,
			billableStart: true,
		})
		expect(claimed.billable_start).toBe(1)

		const unclaimed = buildSessionMetaRow({
			...base,
			status: "active",
			recorded: false,
			billableStart: false,
		})
		expect(unclaimed.billable_start).toBe(0)

		// Absent input must still emit the key — the column is UInt8, and an
		// omitted key would read as the DEFAULT rather than an explicit "no".
		const unset = buildSessionMetaRow({ ...base, status: "active", recorded: false })
		expect(unset.billable_start).toBe(0)
	})

	it("keeps the marker on the ended row, which is what survives the merge", () => {
		const row = buildSessionMetaRow({
			...base,
			version: 7,
			status: "ended",
			recorded: false,
			billableStart: true,
		})
		expect(row.billable_start).toBe(1)
	})
})
