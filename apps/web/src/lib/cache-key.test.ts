import { describe, expect, it } from "vitest"

import { encodeKey, encodeOrgScopedKey, identityFromKey, orgScopedKeyPayload } from "./cache-key"

/** Mirrors `ORG_KEY_SEPARATOR` in cache-key.ts — NUL cannot occur in JSON or a Clerk org id. */
const SEP = "\u0000"
const MALFORMED = `org_1${SEP}not-json`
const SEPARATED = `org_1${SEP}`

describe("encodeKey", () => {
	it("is order-insensitive across object keys", () => {
		expect(encodeKey({ a: 1, b: 2 })).toBe(encodeKey({ b: 2, a: 1 }))
	})

	it("drops undefined values", () => {
		expect(encodeKey({ a: 1, b: undefined })).toBe(encodeKey({ a: 1 }))
	})

	it("snaps timestamps to the 15s grid", () => {
		expect(encodeKey({ startTime: "2026-03-08 14:30:07" })).toBe(
			encodeKey({ startTime: "2026-03-08 14:30:00" }),
		)
	})
})

describe("identityFromKey", () => {
	const key = (orgId: string, input: unknown) => encodeOrgScopedKey(orgId, input)

	it("collapses two keys that differ only in their time window", () => {
		const a = key("org_1", {
			serviceName: "api",
			startTime: "2026-03-08 02:30:00",
			endTime: "2026-03-08 14:30:00",
		})
		const b = key("org_1", {
			serviceName: "api",
			startTime: "2026-03-08 02:35:00",
			endTime: "2026-03-08 14:35:00",
		})

		expect(a).not.toBe(b)
		expect(identityFromKey(a)).toBe(identityFromKey(b))
	})

	it("strips millisecond-precision and T-separated timestamps too", () => {
		const spaced = key("org_1", { at: "2026-03-08 14:30:00" })
		const fractional = key("org_1", { at: "2026-03-08 14:30:00.123" })
		const tSeparated = key("org_1", { at: "2026-03-08T14:30:00" })

		expect(identityFromKey(fractional)).toBe(identityFromKey(spaced))
		expect(identityFromKey(tSeparated)).toBe(identityFromKey(spaced))
	})

	it("separates identities across orgs", () => {
		const input = { serviceName: "api", startTime: "2026-03-08 02:30:00" }

		expect(identityFromKey(key("org_1", input))).not.toBe(identityFromKey(key("org_2", input)))
	})

	it("separates identities across non-time inputs", () => {
		const at = { startTime: "2026-03-08 02:30:00" }

		expect(identityFromKey(key("org_1", { ...at, serviceName: "api" }))).not.toBe(
			identityFromKey(key("org_1", { ...at, serviceName: "web" })),
		)
		expect(identityFromKey(key("org_1", { ...at, limit: 50 }))).not.toBe(
			identityFromKey(key("org_1", { ...at, limit: 100 })),
		)
	})

	it("strips timestamps nested in objects and arrays", () => {
		const a = key("org_1", { windows: [{ from: "2026-03-08 02:30:00" }], name: "api" })
		const b = key("org_1", { windows: [{ from: "2026-03-08 09:45:15" }], name: "api" })

		expect(identityFromKey(a)).toBe(identityFromKey(b))
	})

	it("keeps a filter value that merely contains a date distinct", () => {
		// Only the exact warehouse shape is stripped; a free-text filter that
		// happens to mention a date is still part of the query.
		const a = key("org_1", { q: "deploy at 2026-03-08 14:30:00 failed" })
		const b = key("org_1", { q: "deploy at 2026-03-09 14:30:00 failed" })

		expect(identityFromKey(a)).not.toBe(identityFromKey(b))
	})

	it("falls back to the key itself when the payload is not JSON", () => {
		expect(identityFromKey(MALFORMED)).toBe(MALFORMED)
	})

	it("round-trips the org prefix that orgScopedKeyPayload strips", () => {
		const identity = identityFromKey(key("org_1", { serviceName: "api" }))

		expect(identity.startsWith(SEPARATED)).toBe(true)
		expect(JSON.parse(orgScopedKeyPayload(identity))).toEqual({ serviceName: "api" })
	})
})
