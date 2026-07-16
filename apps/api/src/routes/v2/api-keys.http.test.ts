import { afterEach, describe, expect, it } from "vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Env } from "../../lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "../../lib/test-pglite"
import { ApiKeysService } from "../../services/ApiKeysService"
import { AuthService } from "../../services/AuthService"
import { DashboardPersistenceService } from "../../services/DashboardPersistenceService"
import { ApiAuthorizationV2Layer } from "../../services/ApiAuthorizationV2Layer"
import { V2SchemaErrorsLive } from "./error-envelope"
import { AlertsServiceStubLayer, AllV2GroupLayersLive } from "./v2-test-support"

/**
 * End-to-end HTTP tests for the v2 pilot: a real router (auth middleware, v2
 * error envelopes, public-ID codecs, list envelope) over an embedded PGlite,
 * exercised with fetch Requests exactly as a client would.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3478",
			MCP_PORT: "3479",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const makeHarness = () => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(V2SchemaErrorsLive),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(servicesLive),
	)

	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, {
		disableLogger: true,
	})
	// Seed runtime for direct service access (bootstrap keys without HTTP).
	const runtime = ManagedRuntime.make(servicesLive)

	const request = async (
		method: string,
		path: string,
		options: { token?: string; body?: unknown } = {},
	) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: {
					...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
					...(options.body !== undefined ? { "content-type": "application/json" } : {}),
				},
				body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null }
	}

	const ORG = Schema.decodeUnknownSync(OrgId)("org_e2e")
	const USER = Schema.decodeUnknownSync(UserId)("user_e2e")

	const bootstrapKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, {
					name: scopes === undefined ? "root-key" : `scoped:${scopes.join(",")}`,
					scopes,
				})
			}),
		)

	return {
		request,
		bootstrapKey,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 api_keys over HTTP", () => {
	it("returns the list envelope for an authorized key", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey()

		const { status, body } = await harness.request("GET", "/v2/api_keys", { token: key.secret })
		expect(status).toBe(200)
		expect(body.object).toBe("list")
		expect(body.has_more).toBe(false)
		expect(body.next_cursor).toBeNull()
		expect(body.data).toHaveLength(1)
		expect(body.data[0].object).toBe("api_key")
		expect(body.data[0].id.startsWith("key_")).toBe(true)
		expect(body.data[0].key_prefix.startsWith("maple_ak_")).toBe(true)
		expect(typeof body.data[0].created_at).toBe("string")
		expect("txid" in body.data[0]).toBe(false)
		await harness.dispose()
	})

	it("rejects missing credentials with a 401 envelope", async () => {
		const harness = makeHarness()
		const { status, body } = await harness.request("GET", "/v2/api_keys")
		expect(status).toBe(401)
		expect(body.error.type).toBe("authentication_error")
		await harness.dispose()
	})

	it("enforces scopes: read-only key cannot create, and write implies read", async () => {
		const harness = makeHarness()
		const readOnly = await harness.bootstrapKey(["api_keys:read"])

		const list = await harness.request("GET", "/v2/api_keys", { token: readOnly.secret })
		expect(list.status).toBe(200)

		const create = await harness.request("POST", "/v2/api_keys", {
			token: readOnly.secret,
			body: { name: "nope" },
		})
		expect(create.status).toBe(403)
		expect(create.body.error).toEqual({
			type: "permission_error",
			code: "insufficient_scope",
			message: 'This API key does not have the "api_keys:write" scope required for this request.',
		})

		const writeKey = await harness.bootstrapKey(["api_keys:write"])
		const listViaWrite = await harness.request("GET", "/v2/api_keys", { token: writeKey.secret })
		expect(listViaWrite.status).toBe(200)
		await harness.dispose()
	})

	it("full CRUD round-trip: create with scopes, retrieve, roll, revoke", async () => {
		const harness = makeHarness()
		const root = await harness.bootstrapKey()

		const created = await harness.request("POST", "/v2/api_keys", {
			token: root.secret,
			body: { name: "ci", scopes: ["telemetry:read"], expires_in_seconds: 3600 },
		})
		expect(created.status).toBe(200)
		expect(created.body.object).toBe("api_key")
		expect(created.body.scopes).toEqual(["telemetry:read"])
		expect(created.body.secret.startsWith("maple_ak_")).toBe(true)
		expect(created.body.expires_at).not.toBeNull()
		expect(created.body.txid).toMatch(/^\d+$/)

		const id: string = created.body.id
		const retrieved = await harness.request("GET", `/v2/api_keys/${id}`, { token: root.secret })
		expect(retrieved.status).toBe(200)
		expect(retrieved.body.id).toBe(id)
		expect("secret" in retrieved.body).toBe(false)
		expect("txid" in retrieved.body).toBe(false)

		const rolled = await harness.request("POST", `/v2/api_keys/${id}/roll`, { token: root.secret })
		expect(rolled.status).toBe(200)
		expect(rolled.body.scopes).toEqual(["telemetry:read"])
		expect(rolled.body.id).not.toBe(id)
		expect(rolled.body.txid).toMatch(/^\d+$/)

		const revoked = await harness.request("DELETE", `/v2/api_keys/${rolled.body.id}`, {
			token: root.secret,
		})
		expect(revoked.status).toBe(200)
		expect(revoked.body.revoked).toBe(true)
		expect(revoked.body.txid).toMatch(/^\d+$/)
		await harness.dispose()
	})

	it("returns envelope errors for malformed and unknown IDs", async () => {
		const harness = makeHarness()
		const root = await harness.bootstrapKey()

		const malformed = await harness.request("GET", "/v2/api_keys/not-a-public-id", {
			token: root.secret,
		})
		expect(malformed.status).toBe(400)
		expect(malformed.body.error.type).toBe("invalid_request_error")
		expect(malformed.body.error.code).toBe("parameter_invalid")

		// valid key_ encoding of a UUID that doesn't exist
		const { encodePublicId } = await import("@maple/domain/http/v2")
		const ghost = encodePublicId("key", "0f8fad5b-d9cb-469f-a165-70867728950e")
		const missing = await harness.request("GET", `/v2/api_keys/${ghost}`, { token: root.secret })
		expect(missing.status).toBe(404)
		expect(missing.body.error.type).toBe("not_found_error")
		expect(missing.body.error.code).toBe("resource_missing")
		await harness.dispose()
	})

	it("rejects invalid scope strings on create with a 400 envelope", async () => {
		const harness = makeHarness()
		const root = await harness.bootstrapKey()

		const { status, body } = await harness.request("POST", "/v2/api_keys", {
			token: root.secret,
			body: { name: "bad", scopes: ["dashboards:admin"] },
		})
		expect(status).toBe(400)
		expect(body.error.type).toBe("invalid_request_error")
		await harness.dispose()
	})

	it("paginates with limit + cursor", async () => {
		const harness = makeHarness()
		const root = await harness.bootstrapKey()
		await harness.bootstrapKey(["api_keys:read"])
		await harness.bootstrapKey(["api_keys:read"])

		const first = await harness.request("GET", "/v2/api_keys?limit=2", { token: root.secret })
		expect(first.status).toBe(200)
		expect(first.body.data).toHaveLength(2)
		expect(first.body.has_more).toBe(true)

		const second = await harness.request(
			"GET",
			`/v2/api_keys?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`,
			{ token: root.secret },
		)
		expect(second.status).toBe(200)
		expect(second.body.data).toHaveLength(1)
		expect(second.body.has_more).toBe(false)
		await harness.dispose()
	})
})
