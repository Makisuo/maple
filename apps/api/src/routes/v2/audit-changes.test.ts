import { describe, expect, it } from "vitest"
import { auditDiff, redactAuditUrl } from "./audit-changes"
import { destinationAuditDiff } from "./alert-destinations.http"

const targetDiff = auditDiff({
	fields: ["name", "url", "enabled", "labels_json"],
	summarize: { labels_json: "<updated>" },
	redact: { url: redactAuditUrl },
	writeOnly: ["auth_credentials"],
})

describe("auditDiff", () => {
	it("diffs only the fields the payload carried", () => {
		const changes = targetDiff(
			{ name: "renamed" },
			{ name: "before", url: "https://a.test/x", enabled: true, labels_json: "{}" },
			{ name: "renamed", url: "https://b.test/y", enabled: false, labels_json: "{}" },
		)
		// `url` and `enabled` moved, but the request did not ask for them.
		expect(changes).toEqual({
			fields: ["name"],
			before: { name: "before" },
			after: { name: "renamed" },
		})
	})

	it("returns undefined when a touched field is unchanged", () => {
		expect(
			targetDiff(
				{ name: "same" },
				{ name: "same", url: "https://a.test", enabled: true, labels_json: "{}" },
				{ name: "same", url: "https://a.test", enabled: true, labels_json: "{}" },
			),
		).toBeUndefined()
	})

	it("redacts credentials out of a changed URL", () => {
		const changes = targetDiff(
			{ url: "https://user:secret@b.test/m?token=live" },
			{ name: "n", url: "https://a.test/m", enabled: true, labels_json: "{}" },
			{ name: "n", url: "https://user:secret@b.test/m?token=live", enabled: true, labels_json: "{}" },
		)
		expect(changes?.after["url"]).toBe("https://b.test/m")
		expect(JSON.stringify(changes)).not.toContain("secret")
		expect(JSON.stringify(changes)).not.toContain("token=live")
	})

	it("summarizes config blobs instead of recording their bodies", () => {
		const changes = targetDiff(
			{ labels_json: '{"team":"infra"}' },
			{ name: "n", url: "https://a.test", enabled: true, labels_json: "{}" },
			{ name: "n", url: "https://a.test", enabled: true, labels_json: '{"team":"infra"}' },
		)
		expect(changes).toEqual({
			fields: ["labels_json"],
			before: { labels_json: "<updated>" },
			after: { labels_json: "<updated>" },
		})
	})

	it("records a write-only field as rotated whenever the payload carries it", () => {
		const changes = targetDiff(
			{ auth_credentials: "hunter2" },
			{ name: "n", url: "https://a.test", enabled: true, labels_json: "{}" },
			{ name: "n", url: "https://a.test", enabled: true, labels_json: "{}" },
		)
		expect(changes).toEqual({
			fields: ["auth_credentials"],
			before: { auth_credentials: "<redacted>" },
			after: { auth_credentials: "<redacted>" },
		})
		expect(JSON.stringify(changes)).not.toContain("hunter2")
	})

	it("merges a rotated credential into an observable diff", () => {
		const changes = targetDiff(
			{ name: "renamed", auth_credentials: "hunter2" },
			{ name: "before", url: "https://a.test", enabled: true, labels_json: "{}" },
			{ name: "renamed", url: "https://a.test", enabled: true, labels_json: "{}" },
		)
		expect(changes?.fields).toEqual(["name", "auth_credentials"])
		expect(changes?.after).toEqual({ name: "renamed", auth_credentials: "<redacted>" })
	})
})

describe("auditDiff opaque fields", () => {
	const knobDiff = auditDiff({
		fields: ["name"],
		opaque: ["channel_id"],
		writeOnly: ["bot_token"],
	})

	it("records a provider-side handle as touched, not as its value", () => {
		const changes = knobDiff({ channel_id: "C0123" }, { name: "n" }, { name: "n" })
		expect(changes).toEqual({
			fields: ["channel_id"],
			before: { channel_id: "<updated>" },
			after: { channel_id: "<updated>" },
		})
		// Not secret, but not ours to echo either — the document never returns it.
		expect(JSON.stringify(changes)).not.toContain("C0123")
	})

	it("keeps a knob distinct from a credential in the same request", () => {
		const changes = knobDiff(
			{ name: "renamed", channel_id: "C0123", bot_token: "xoxb-secret" },
			{ name: "before" },
			{ name: "renamed" },
		)
		expect(changes?.fields).toEqual(["name", "bot_token", "channel_id"])
		expect(changes?.after).toEqual({
			name: "renamed",
			bot_token: "<redacted>",
			channel_id: "<updated>",
		})
	})

	it("says nothing when the request carried neither", () => {
		expect(knobDiff({ name: "same" }, { name: "same" }, { name: "same" })).toBeUndefined()
	})
})

describe("destinationAuditDiff", () => {
	const view = (over: Record<string, unknown> = {}) => ({
		name: "Ops",
		enabled: true,
		member_user_ids: undefined,
		...over,
	})

	it("diffs the fields a destination document echoes", () => {
		const changes = destinationAuditDiff({ enabled: false }, view(), view({ enabled: false }))
		expect(changes).toEqual({ fields: ["enabled"], before: { enabled: true }, after: { enabled: false } })
	})

	it("never records a rotated credential's value", () => {
		const changes = destinationAuditDiff({ bot_token: "xoxb-secret" }, view(), view())
		expect(changes?.fields).toEqual(["bot_token"])
		expect(JSON.stringify(changes)).not.toContain("xoxb-secret")
	})

	// A webhook URL is the credential for Discord and can carry one for a plain
	// webhook, so it is withheld rather than diffed.
	it("treats a webhook URL as a credential", () => {
		const changes = destinationAuditDiff({ webhook_url: "https://discord.test/api/webhooks/1/tok" }, view(), view())
		expect(changes?.after).toEqual({ webhook_url: "<redacted>" })
	})

	it("records a channel move as touched", () => {
		const changes = destinationAuditDiff({ channel_id: "C9", channel_name: "#alerts" }, view(), view())
		expect(changes?.fields).toEqual(["channel_id", "channel_name"])
		expect(changes?.after).toEqual({ channel_id: "<updated>", channel_name: "<updated>" })
	})

	// The pre-update document is looked up from a list; if it were missing, the
	// diff must still record what the request changed rather than nothing.
	it("still records a change when the previous document is unknown", () => {
		const unknown = { name: undefined, enabled: undefined, member_user_ids: undefined }
		const changes = destinationAuditDiff({ name: "Ops" }, unknown, view())
		expect(changes).toEqual({ fields: ["name"], before: { name: undefined }, after: { name: "Ops" } })
	})
})
