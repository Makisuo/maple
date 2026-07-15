import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { V2ApiKey } from "./api-keys"
import { requiredScopeForRequest, scopeAllows, V2Scope } from "./auth"
import { decodeOffsetCursor, encodeOffsetCursor, isoTimestamp, paginateArray } from "./envelopes"
import { notFound, permissionError, V2NotFoundError } from "./errors"
import { encodePublicId } from "./public-id"

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e"

describe("V2ApiKey wire format", () => {
	it("encodes snake_case fields, an object type, and a key_ public ID", () => {
		const key = Schema.decodeUnknownSync(V2ApiKey)({
			id: encodePublicId("key", UUID),
			object: "api_key",
			name: "ci",
			description: null,
			key_prefix: "maple_ak_abc...",
			kind: "standard",
			scopes: ["dashboards:read"],
			revoked: false,
			revoked_at: null,
			last_used_at: null,
			expires_at: null,
			created_at: "2026-07-15T00:00:00.000Z",
			created_by: "user_123",
			created_by_email: null,
		})
		expect(key.id).toBe(UUID) // decoded to the internal ID

		const wire = Schema.encodeSync(V2ApiKey)(key)
		expect(wire.id).toBe(encodePublicId("key", UUID))
		expect(wire.object).toBe("api_key")
		expect(wire.key_prefix).toBe("maple_ak_abc...")
		expect(wire.created_at).toBe("2026-07-15T00:00:00.000Z")
		expect("keyPrefix" in wire).toBe(false)
	})
})

describe("v2 error envelope", () => {
	it("encodes exactly the Stripe envelope with no _tag", () => {
		const error = notFound("No such api_key", "id")
		const wire = Schema.encodeSync(V2NotFoundError)(error) as Record<string, unknown>
		expect(wire).toEqual({
			error: {
				type: "not_found_error",
				code: "resource_missing",
				message: "No such api_key",
				param: "id",
			},
		})
		expect("_tag" in wire).toBe(false)
	})

	it("omits param when not provided", () => {
		const wire = Schema.encodeSync(V2NotFoundError)(notFound("gone")) as {
			error: Record<string, unknown>
		}
		expect("param" in wire.error).toBe(false)
	})

	it("permissionError has type permission_error", () => {
		expect(permissionError("insufficient_scope", "nope").error.type).toBe("permission_error")
	})
})

describe("scopes", () => {
	const check = Schema.decodeUnknownSync(V2Scope)

	it("accepts valid scope strings and rejects invalid ones", () => {
		expect(check("dashboards:read")).toBe("dashboards:read")
		expect(check("alert_rules:write")).toBe("alert_rules:write")
		expect(check("*")).toBe("*")
		expect(() => check("dashboards")).toThrow()
		expect(() => check("dashboards:admin")).toThrow()
		expect(() => check("Dashboards:read")).toThrow()
	})

	it("derives the required scope from method + path", () => {
		expect(requiredScopeForRequest("GET", "/v2/api_keys")).toEqual({
			family: "api_keys",
			access: "read",
		})
		expect(requiredScopeForRequest("GET", "/v2/api_keys/key_abc")).toEqual({
			family: "api_keys",
			access: "read",
		})
		expect(requiredScopeForRequest("POST", "/v2/api_keys/key_abc/roll")).toEqual({
			family: "api_keys",
			access: "write",
		})
		expect(requiredScopeForRequest("DELETE", "/v2/api_keys/key_abc")).toEqual({
			family: "api_keys",
			access: "write",
		})
		expect(requiredScopeForRequest("GET", "/api/api-keys")).toBeNull()
	})

	it("enforces the scope matrix", () => {
		const required = { family: "api_keys", access: "read" } as const
		const write = { family: "api_keys", access: "write" } as const

		expect(scopeAllows(null, write)).toBe(true) // legacy full-access key
		expect(scopeAllows(undefined, write)).toBe(true) // session token
		expect(scopeAllows(["*"], write)).toBe(true)
		expect(scopeAllows(["api_keys:read"], required)).toBe(true)
		expect(scopeAllows(["api_keys:read"], write)).toBe(false)
		expect(scopeAllows(["api_keys:write"], write)).toBe(true)
		expect(scopeAllows(["api_keys:write"], required)).toBe(true) // write implies read
		expect(scopeAllows(["dashboards:write"], required)).toBe(false)
		expect(scopeAllows([], required)).toBe(false)
	})
})

describe("list pagination", () => {
	const items = Array.from({ length: 45 }, (_, index) => index)

	it("paginates with default limit and opaque cursors", () => {
		const first = paginateArray(items, {})
		expect(first.data).toHaveLength(20)
		expect(first.has_more).toBe(true)
		expect(first.next_cursor).not.toBeNull()

		const second = paginateArray(items, { cursor: first.next_cursor! })
		expect(second.data[0]).toBe(20)

		const third = paginateArray(items, { cursor: second.next_cursor!, limit: 20 })
		expect(third.data).toHaveLength(5)
		expect(third.has_more).toBe(false)
		expect(third.next_cursor).toBeNull()
	})

	it("cursor round-trips and rejects garbage", () => {
		expect(decodeOffsetCursor(encodeOffsetCursor(1234))).toBe(1234)
		expect(decodeOffsetCursor("garbage")).toBeNull()
		expect(decodeOffsetCursor("off_-1")).toBeNull()
	})
})

describe("timestamps", () => {
	it("formats epoch-ms as ISO-8601 UTC", () => {
		expect(isoTimestamp(0)).toBe("1970-01-01T00:00:00.000Z")
	})
})
