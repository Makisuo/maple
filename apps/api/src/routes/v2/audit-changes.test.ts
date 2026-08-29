import { describe, expect, it } from "vitest"
import { auditDiff, redactAuditUrl } from "./audit-changes"

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
