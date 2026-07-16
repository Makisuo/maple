import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { V2ApiKey, V2ApiKeyMutationResponse, V2ApiKeyWithSecret } from "./api-keys"
import { V2DashboardMutation } from "./dashboards"
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

	it("keeps txid on mutation responses but out of the base resource", () => {
		const base = {
			id: encodePublicId("key", UUID),
			object: "api_key" as const,
			name: "ci",
			description: null,
			key_prefix: "maple_ak_abc...",
			kind: "standard" as const,
			scopes: null,
			revoked: false,
			revoked_at: null,
			last_used_at: null,
			expires_at: null,
			created_at: "2026-07-15T00:00:00.000Z",
			created_by: "user_123",
			created_by_email: null,
		}
		const withSecret = Schema.decodeUnknownSync(V2ApiKeyWithSecret)({
			...base,
			secret: "maple_ak_secret",
			txid: "81234",
		})
		const revoked = Schema.decodeUnknownSync(V2ApiKeyMutationResponse)({ ...base, txid: "81235" })

		expect(Schema.encodeSync(V2ApiKeyWithSecret)(withSecret).txid).toBe("81234")
		expect(Schema.encodeSync(V2ApiKeyMutationResponse)(revoked).txid).toBe("81235")
		expect("txid" in Schema.encodeSync(V2ApiKey)(Schema.decodeUnknownSync(V2ApiKey)(base))).toBe(false)
	})

	it("rejects non-Postgres transaction IDs", () => {
		expect(() =>
			Schema.decodeUnknownSync(V2ApiKeyMutationResponse)({
				id: encodePublicId("key", UUID),
				object: "api_key",
				name: "ci",
				description: null,
				key_prefix: "maple_ak_abc...",
				kind: "standard",
				scopes: null,
				revoked: true,
				revoked_at: "2026-07-15T00:00:00.000Z",
				last_used_at: null,
				expires_at: null,
				created_at: "2026-07-15T00:00:00.000Z",
				created_by: "user_123",
				created_by_email: null,
				txid: "not-a-txid",
			}),
		).toThrow()
	})
})

describe("V2Dashboard wire format", () => {
	it("encodes public IDs and recursively snake_cases the dashboard document", () => {
		const decoded = Schema.decodeUnknownSync(V2DashboardMutation)({
			id: encodePublicId("dash", UUID),
			object: "dashboard",
			name: "Operations",
			description: null,
			tags: ["production"],
			time_range: {
				type: "absolute",
				start_time: "2026-07-15T00:00:00.000Z",
				end_time: "2026-07-16T00:00:00.000Z",
			},
			widgets: [
				{
					id: "widget-1",
					visualization: "line",
					data_source: {
						endpoint: "queryBuilderTimeseries",
						params: { start_time: "now-1h", nested_filter: { attribute_key: "service.name" } },
						transform: { field_map: { value: "requests" } },
					},
					display: {
						chart_id: "requests",
						x_axis: { visible: true },
						list_root_only: true,
					},
					layout: { x: 0, y: 0, w: 6, h: 4, min_w: 2 },
				},
			],
			variables: [
				{
					type: "query",
					name: "service",
					include_all: true,
					source: { kind: "attribute", scope: "resource", attribute_key: "service.name" },
				},
			],
			created_at: "2026-07-15T00:00:00.000Z",
			updated_at: "2026-07-16T00:00:00.000Z",
			txid: "81234",
		})

		expect(decoded.id).toBe(UUID)
		expect(decoded.timeRange.type).toBe("absolute")
		expect(decoded.widgets[0]?.dataSource.transform?.fieldMap).toEqual({ value: "requests" })
		expect(decoded.widgets[0]?.dataSource.params).toEqual({
			startTime: "now-1h",
			nestedFilter: { attributeKey: "service.name" },
		})

		const wire = Schema.encodeSync(V2DashboardMutation)(decoded)
		expect(wire.id).toMatch(/^dash_/)
		expect(wire.time_range).toHaveProperty("start_time")
		expect(wire.widgets[0]?.data_source.transform).toHaveProperty("field_map")
		expect(wire.widgets[0]?.data_source.params).toHaveProperty("nested_filter.attribute_key")
		expect(wire.widgets[0]?.layout).toHaveProperty("min_w")
		expect(wire.variables[0]).toHaveProperty("include_all")
		const variable = wire.variables[0]
		if (variable?.type !== "query") throw new Error("Expected a query dashboard variable")
		expect(variable.source).toHaveProperty("attribute_key")
		expect(wire.txid).toBe("81234")
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
