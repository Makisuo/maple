import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { vi } from "vitest"

vi.mock("@/lib/registry", () => ({ mapleRuntime: {} }))

import { ApiKeyRowSchema, rowToV2ApiKey, type ApiKeyRow } from "./api-keys"

const KEY_ID = "0f8fad5b-d9cb-469f-a165-70867728950e"

const row: ApiKeyRow = {
	id: KEY_ID,
	org_id: "org_1",
	name: "CI",
	description: "Deploy key",
	key_prefix: "maple_ak_abc...",
	revoked: false,
	revoked_at: null,
	last_used_at: "2026-07-15T10:00:00.000Z",
	expires_at: null,
	scopes: ["dashboards:read"],
	kind: "standard",
	created_at: "2026-07-01T09:00:00.000Z",
	created_by: "user_1",
	created_by_email: "owner@example.com",
}

describe("ApiKeyRowSchema", () => {
	it("validates the safe Electric projection", () => {
		assert.deepStrictEqual(Schema.decodeUnknownSync(ApiKeyRowSchema)(row), row)
		assert.throws(() => Schema.decodeUnknownSync(ApiKeyRowSchema)({ ...row, scopes: "*" }))
	})
})

describe("rowToV2ApiKey", () => {
	it("maps the raw row to the decoded v2 API-key model", () => {
		const key = rowToV2ApiKey(row)
		assert.strictEqual(key.id, KEY_ID)
		assert.strictEqual(key.object, "api_key")
		assert.strictEqual(key.key_prefix, "maple_ak_abc...")
		assert.deepStrictEqual(key.scopes, ["dashboards:read"])
		assert.strictEqual(key.last_used_at, "2026-07-15T10:00:00.000Z")
		assert.strictEqual(key.created_by_email, "owner@example.com")
	})
})
