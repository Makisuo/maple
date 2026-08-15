import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OrgId, UserId } from "@maple/domain/http"
import { DashboardPublicId, DashboardTemplatePublicId, MapleApiV2 } from "@maple/domain/http/v2"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "@/platform/test-pglite"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { AuthService } from "@/services/auth/AuthService"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@/services/dashboards/SharedDashboardService"
import { ApiAuthorizationV2Layer } from "@/services/auth/ApiAuthorizationV2Layer"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	PlanetScaleServiceStubsLayer,
	SlackIntegrationServiceStubLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"

const createdDbs: TestDb[] = []
const encodeDashboardPublicId = Schema.encodeUnknownSync(DashboardPublicId)
const USER_OTHER = Schema.decodeUnknownSync(UserId)("user_other_org")
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
			MAPLE_SHARE_TOKEN_HMAC_KEY: "maple-test-share-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

type Harness = ReturnType<typeof makeHarness>

const makeHarness = () => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(SlackIntegrationServiceStubLayer),
		Layer.provide(PlanetScaleServiceStubsLayer),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(ConfigResourceServiceStubsLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, {
		disableLogger: true,
	})
	const runtime = ManagedRuntime.make(servicesLive)
	const ORG = Schema.decodeUnknownSync(OrgId)("org_dashboard_e2e")
	const USER = Schema.decodeUnknownSync(UserId)("user_dashboard_e2e")

	const bootstrapKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "dashboard-test", scopes })
			}),
		)

	const request = async (method: string, path: string, token: string, body?: unknown) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body !== undefined ? { "content-type": "application/json" } : undefined),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
	}

	return {
		bootstrapKey,
		request,
		testDb,
		runtime,
		ORG,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 dashboards over HTTP", () => {
	it("supports headless CRUD and version restore with v2 wire conventions", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])

		const created = await harness.request("POST", "/v2/dashboards", key.secret, {
			name: "Operations",
			description: "Production overview",
			tags: ["production"],
			time_range: { type: "relative", value: "12h" },
			widgets: [],
			variables: [],
		})
		expect(created.status).toBe(200)
		expect(created.body.object).toBe("dashboard")
		expect(created.body.id).toMatch(/^dash_/)
		expect(created.body.time_range).toEqual({ type: "relative", value: "12h" })
		expect(created.body.txid).toMatch(/^\d+$/)
		expect("timeRange" in created.body).toBe(false)

		const id: string = created.body.id
		const listed = await harness.request("GET", "/v2/dashboards?limit=1", key.secret)
		expect(listed.status).toBe(200)
		expect(listed.body).toMatchObject({ object: "list", has_more: false, next_cursor: null })
		expect(listed.body.data[0].id).toBe(id)
		expect("txid" in listed.body.data[0]).toBe(false)

		const retrieved = await harness.request("GET", `/v2/dashboards/${id}`, key.secret)
		expect(retrieved.status).toBe(200)
		expect(retrieved.body.description).toBe("Production overview")

		const updated = await harness.request("PATCH", `/v2/dashboards/${id}`, key.secret, {
			name: "Operations v2",
			description: null,
			time_range: {
				type: "absolute",
				start_time: "2026-07-15T00:00:00.000Z",
				end_time: "2026-07-16T00:00:00.000Z",
			},
		})
		expect(updated.status).toBe(200)
		expect(updated.body.name).toBe("Operations v2")
		expect(updated.body.description).toBeNull()
		expect(updated.body.time_range.start_time).toBe("2026-07-15T00:00:00.000Z")
		expect(updated.body.txid).toMatch(/^\d+$/)

		const versions = await harness.request("GET", `/v2/dashboards/${id}/versions?limit=100`, key.secret)
		expect(versions.status).toBe(200)
		expect(versions.body.object).toBe("list")
		expect(versions.body.data.length).toBeGreaterThanOrEqual(2)
		expect(versions.body.data[0].id).toMatch(/^dbv_/)
		expect(versions.body.data[0].dashboard_id).toBe(id)

		const oldest = versions.body.data.at(-1)
		const detail = await harness.request("GET", `/v2/dashboards/${id}/versions/${oldest.id}`, key.secret)
		expect(detail.status).toBe(200)
		expect(detail.body.snapshot.object).toBe("dashboard")
		expect(detail.body.snapshot.name).toBe("Operations")

		const restored = await harness.request(
			"POST",
			`/v2/dashboards/${id}/versions/${oldest.id}/restore`,
			key.secret,
		)
		expect(restored.status).toBe(200)
		expect(restored.body.name).toBe("Operations")
		expect(restored.body.txid).toMatch(/^\d+$/)

		const deleted = await harness.request("DELETE", `/v2/dashboards/${id}`, key.secret)
		expect(deleted.status).toBe(200)
		expect(deleted.body).toMatchObject({ id, object: "dashboard", deleted: true })
		expect(deleted.body.txid).toMatch(/^\d+$/)

		const missing = await harness.request("GET", `/v2/dashboards/${id}`, key.secret)
		expect(missing.status).toBe(404)
		expect(missing.body.error).toMatchObject({
			type: "not_found_error",
			code: "dashboard_not_found",
		})
		await harness.dispose()
	})

	it("reports corrupt stored dashboards separately from retryable persistence failures", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])
		const created = await harness.request("POST", "/v2/dashboards", key.secret, {
			name: "Corrupt me",
			widgets: [],
		})
		expect(created.status).toBe(200)

		await executeSql(
			harness.testDb,
			"update dashboards set payload_json = '\"not-a-dashboard\"'::jsonb where org_id = $1",
			["org_dashboard_e2e"],
		)

		const response = await harness.request("GET", `/v2/dashboards/${created.body.id}`, key.secret)
		expect(response.status).toBe(500)
		expect(response.body.error).toMatchObject({
			_tag: "@maple/http/errors/DashboardStoredConfigInvalidError",
			code: "dashboard_stored_config_invalid",
			retryable: false,
			recovery: "contact_support",
		})
		expect(JSON.stringify(response.body)).not.toContain("not-a-dashboard")

		await harness.dispose()
	})

	// A widget may pin its own window; the field is optional, snake_cased on the
	// wire, and must survive a round-trip without leaking onto unpinned widgets.
	it("round-trips a per-widget time range", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])

		const widget = (id: string, timeRange?: unknown) => ({
			id,
			visualization: "stat",
			data_source: { kind: "query", result_shape: "timeseries", queries: [] },
			display: { title: id },
			layout: { x: 0, y: 0, w: 3, h: 3 },
			...(timeRange !== undefined ? { time_range: timeRange } : undefined),
		})

		const created = await harness.request("POST", "/v2/dashboards", key.secret, {
			name: "Mixed ranges",
			time_range: { type: "relative", value: "7d" },
			widgets: [widget("pinned", { type: "relative", value: "30m" }), widget("follows")],
		})
		expect(created.status).toBe(200)
		expect(created.body.widgets[0].time_range).toEqual({ type: "relative", value: "30m" })
		expect("time_range" in created.body.widgets[1]).toBe(false)
		expect("timeRange" in created.body.widgets[0]).toBe(false)

		const id: string = created.body.id
		const patched = await harness.request("PATCH", `/v2/dashboards/${id}`, key.secret, {
			widgets: [
				widget("pinned", {
					type: "absolute",
					start_time: "2026-07-15T00:00:00.000Z",
					end_time: "2026-07-16T00:00:00.000Z",
				}),
			],
		})
		expect(patched.status).toBe(200)
		expect(patched.body.widgets[0].time_range).toEqual({
			type: "absolute",
			start_time: "2026-07-15T00:00:00.000Z",
			end_time: "2026-07-16T00:00:00.000Z",
		})

		// Re-sending the widget without the field is how an override is removed.
		const cleared = await harness.request("PATCH", `/v2/dashboards/${id}`, key.secret, {
			widgets: [widget("pinned")],
		})
		expect(cleared.status).toBe(200)
		expect("time_range" in cleared.body.widgets[0]).toBe(false)

		await harness.dispose()
	})

	it("enforces dashboard read/write scopes", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:read"])
		const list = await harness.request("GET", "/v2/dashboards", key.secret)
		expect(list.status).toBe(200)

		const create = await harness.request("POST", "/v2/dashboards", key.secret, { name: "Denied" })
		expect(create.status).toBe(403)
		expect(create.body.error).toMatchObject({
			type: "permission_error",
			code: "insufficient_scope",
		})
		await harness.dispose()
	})

	// The picker asks for every template in one page; `limit` defaulting to 20
	// silently truncated the catalogue and hid the last two templates.
	it("returns the whole template catalogue with structured requirements", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:read"])

		const listed = await harness.request("GET", "/v2/dashboards/templates?limit=100", key.secret)
		expect(listed.status).toBe(200)
		expect(listed.body.has_more).toBe(false)
		expect(listed.body.data.length).toBeGreaterThan(20)

		const postgres = listed.body.data.find((t: { name: string }) => t.name === "Postgres Overview")
		expect(postgres.object).toBe("dashboard_template")
		expect(postgres.id).toMatch(/^dtpl_/)
		expect(postgres.required_metric_prefixes).toEqual(["postgresql."])
		expect(postgres.requirement).toMatchObject({
			kind: "metrics",
			collector: "the OpenTelemetry postgresreceiver",
			setup_label: "the Postgres receiver",
		})
		// The prose array stays on the wire, derived from the structured field.
		expect(postgres.requirements).toEqual([postgres.requirement.label])

		const cloudflare = listed.body.data.find((t: { name: string }) => t.name === "Cloudflare Edge")
		expect(cloudflare.requirement).toMatchObject({ kind: "integration", missing: "not connected" })

		const blank = listed.body.data.find((t: { name: string }) => t.name === "Blank Dashboard")
		expect(blank.requirement).toBeNull()
		expect(blank.requirements).toEqual([])

		await harness.dispose()
	})

	it("previews a template's widgets without creating a dashboard", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:read"])

		const listed = await harness.request("GET", "/v2/dashboards/templates?limit=100", key.secret)
		const postgres = listed.body.data.find((t: { name: string }) => t.name === "Postgres Overview")

		const preview = await harness.request(
			"POST",
			`/v2/dashboards/templates/${postgres.id}/preview`,
			key.secret,
			{},
		)
		expect(preview.status).toBe(200)
		expect(preview.body.object).toBe("dashboard_template_preview")
		expect(preview.body.time_range).toEqual({ type: "relative", value: "1h" })
		// One real widget per preview-metadata entry, carrying the data source the
		// browser needs to evaluate it.
		expect(preview.body.widgets.length).toBe(postgres.preview.length)
		// v3: identity is `kind`, and only the `route` arm still carries an endpoint.
		expect(preview.body.widgets[0].data_source.kind.length).toBeGreaterThan(0)
		expect("timeRange" in preview.body).toBe(false)

		// Nothing was persisted.
		const dashboards = await harness.request("GET", "/v2/dashboards", key.secret)
		expect(dashboards.body.data).toEqual([])

		// Parameters scope the build.
		const scoped = await harness.request(
			"POST",
			`/v2/dashboards/templates/${postgres.id}/preview`,
			key.secret,
			{ parameters: { service_name: "postgres-primary" } },
		)
		expect(scoped.status).toBe(200)
		expect(JSON.stringify(scoped.body.widgets)).toContain("postgres-primary")

		// Well-formed public id, no such template.
		const unknownId = Schema.encodeUnknownSync(DashboardTemplatePublicId)("does-not-exist")
		const missing = await harness.request(
			"POST",
			`/v2/dashboards/templates/${unknownId}/preview`,
			key.secret,
			{},
		)
		expect(missing.status).toBe(404)
		expect(missing.body.error.code).toBe("dashboard_template_not_found")

		await harness.dispose()
	})

	it("points an invalid widget field at its widget id and full path", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])

		const response = await harness.request("POST", "/v2/dashboards", key.secret, {
			name: "Operations",
			time_range: { type: "relative", value: "12h" },
			widgets: [
				{
					id: "error-rate",
					visualization: "chart",
					data_source: { kind: "route", endpoint: "traces_timeseries" },
					// `fill_nulls` is `number | false`; `true` is not a member.
					display: { title: "error-rate", chart_presentation: { fill_nulls: true } },
					layout: { x: 0, y: 0, w: 6, h: 4 },
				},
			],
		})

		expect(response.status).toBe(400)
		expect(response.body.error.type).toBe("invalid_request_error")
		expect(response.body.error.code).toBe("parameter_invalid")
		// `param` is the whole path, not just its first segment.
		expect(response.body.error.param).toContain("widgets[0]")
		expect(response.body.error.param).toContain("fill_nulls")
		expect(response.body.error.message).toContain('widget "error-rate"')
		expect(response.body.error.message).toContain("true")

		await harness.dispose()
	})
})

describe("v2 dashboard shares", () => {
	const createDashboard = async (harness: Harness, key: string) => {
		const created = await harness.request("POST", "/v2/dashboards", key, {
			name: "Shared board",
			time_range: { type: "relative", value: "12h" },
			widgets: [
				{
					id: "w-1",
					visualization: "stat",
					data_source: { kind: "static" },
					display: {},
					layout: { x: 0, y: 0, w: 3, h: 4 },
				},
			],
			variables: [],
		})
		expect(created.status).toBe(200)
		return created.body.id as string
	}

	/**
	 * Resolve a raw token the way the public share endpoint will, in Phase 3.
	 *
	 * Returns the dashboard's *public* id so callers can compare against what the
	 * v2 API handed them — the share row stores the internal id, and the two are
	 * different strings for the same dashboard.
	 */
	const resolve = (harness: Harness, token: string) =>
		harness.runtime.runPromise(
			SharedDashboardService.resolveByToken(token).pipe(
				Effect.map((resolved) => encodeDashboardPublicId(resolved.share.dashboardId)),
				Effect.catchTag("@maple/http/errors/ShareNotFoundError", () =>
					Effect.succeed("__not_found__"),
				),
			),
		)

	it("mints a token once, and never hands it back", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])
		const id = await createDashboard(harness, key.secret)

		const unshared = await harness.request("GET", `/v2/dashboards/${id}/share`, key.secret)
		expect(unshared.status).toBe(200)
		expect(unshared.body).toBeNull()

		const shared = await harness.request("PUT", `/v2/dashboards/${id}/share`, key.secret, {
			mode: "public",
		})
		expect(shared.status).toBe(200)
		expect(shared.body.object).toBe("dashboard_share")
		expect(shared.body.id).toMatch(/^dshr_/)
		expect(shared.body.mode).toBe("public")
		expect(typeof shared.body.token).toBe("string")

		const token: string = shared.body.token
		expect(shared.body.token_suffix).toBe(token.slice(-6))

		// Readable again on a later call, decrypted out of storage: a caller who
		// never saw the mint response, or who simply reopened the dialog, gets the
		// same working link rather than having to rotate to see one.
		const fetched = await harness.request("GET", `/v2/dashboards/${id}/share`, key.secret)
		expect(fetched.status).toBe(200)
		expect(fetched.body.id).toBe(shared.body.id)
		expect(fetched.body.token).toBe(token)

		expect(await resolve(harness, token)).toBe(id)

		await harness.dispose()
	})

	it("keeps the same link when only the mode changes", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])
		const id = await createDashboard(harness, key.secret)

		const first = await harness.request("PUT", `/v2/dashboards/${id}/share`, key.secret, {
			mode: "public",
		})
		const token: string = first.body.token

		const switched = await harness.request("PUT", `/v2/dashboards/${id}/share`, key.secret, {
			mode: "org",
		})
		expect(switched.status).toBe(200)
		expect(switched.body.mode).toBe("org")
		// The same token comes back, not a new one: a link already pasted somewhere
		// must keep working across a mode change.
		expect(switched.body.token).toBe(token)
		expect(switched.body.id).toBe(first.body.id)
		expect(await resolve(harness, token)).toBe(id)

		await harness.dispose()
	})

	it("rotates: the old link stops resolving the moment the new one starts", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])
		const id = await createDashboard(harness, key.secret)

		const first = await harness.request("PUT", `/v2/dashboards/${id}/share`, key.secret, {
			mode: "public",
		})
		const oldToken: string = first.body.token

		const rotated = await harness.request("POST", `/v2/dashboards/${id}/share/rotate`, key.secret)
		expect(rotated.status).toBe(200)
		const newToken: string = rotated.body.token
		expect(newToken).not.toBe(oldToken)
		expect(rotated.body.mode).toBe("public")

		expect(await resolve(harness, oldToken)).toBe("__not_found__")
		expect(await resolve(harness, newToken)).toBe(id)

		// Rotating twice must not leave two live rows behind — the partial unique
		// index is the guarantee, this asserts it holds in practice.
		const second = await harness.request("POST", `/v2/dashboards/${id}/share/rotate`, key.secret)
		expect(second.status).toBe(200)
		expect(await resolve(harness, newToken)).toBe("__not_found__")
		expect(await resolve(harness, second.body.token)).toBe(id)

		const live = await queryFirstRow<{ count: number }>(
			harness.testDb,
			"select count(*)::int as count from dashboard_shares where revoked_at is null",
		)
		expect(live?.count).toBe(1)

		await harness.dispose()
	})

	it("rotating an unshared dashboard reports no such share", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])
		const id = await createDashboard(harness, key.secret)

		const rotated = await harness.request("POST", `/v2/dashboards/${id}/share/rotate`, key.secret)
		expect(rotated.status).toBe(404)

		await harness.dispose()
	})

	it("revokes idempotently, and the link stops resolving", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])
		const id = await createDashboard(harness, key.secret)

		const shared = await harness.request("PUT", `/v2/dashboards/${id}/share`, key.secret, {
			mode: "public",
		})
		const token: string = shared.body.token

		const revoked = await harness.request("DELETE", `/v2/dashboards/${id}/share`, key.secret)
		expect(revoked.status).toBe(200)
		expect(revoked.body.deleted).toBe(true)
		expect(await resolve(harness, token)).toBe("__not_found__")
		expect((await harness.request("GET", `/v2/dashboards/${id}/share`, key.secret)).body).toBeNull()

		// "Stop sharing" is a statement about the end state, so a second call — or a
		// double-clicked button — succeeds rather than 404ing.
		const again = await harness.request("DELETE", `/v2/dashboards/${id}/share`, key.secret)
		expect(again.status).toBe(200)
		expect(again.body.deleted).toBe(true)

		await harness.dispose()
	})

	it("stops resolving when the dashboard itself is deleted", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])
		const id = await createDashboard(harness, key.secret)

		const shared = await harness.request("PUT", `/v2/dashboards/${id}/share`, key.secret, {
			mode: "public",
		})
		const token: string = shared.body.token
		expect(await resolve(harness, token)).toBe(id)

		const deleted = await harness.request("DELETE", `/v2/dashboards/${id}`, key.secret)
		expect(deleted.status).toBe(200)

		// A live link to a deleted dashboard is the failure mode the foreign key's
		// ON DELETE CASCADE exists to prevent.
		expect(await resolve(harness, token)).toBe("__not_found__")

		await harness.dispose()
	})

	it("enforces dashboard scopes on share management", async () => {
		const harness = makeHarness()
		const readOnly = await harness.bootstrapKey(["dashboards:read"])
		const writer = await harness.bootstrapKey(["dashboards:write"])
		const id = await createDashboard(harness, writer.secret)

		// Reading a share is a read; every mutation is a write. The scope is derived
		// mechanically from method + path, so this guards that derivation too.
		expect((await harness.request("GET", `/v2/dashboards/${id}/share`, readOnly.secret)).status).toBe(200)
		expect(
			(await harness.request("PUT", `/v2/dashboards/${id}/share`, readOnly.secret, { mode: "public" }))
				.status,
		).toBe(403)
		expect(
			(await harness.request("POST", `/v2/dashboards/${id}/share/rotate`, readOnly.secret)).status,
		).toBe(403)
		expect((await harness.request("DELETE", `/v2/dashboards/${id}/share`, readOnly.secret)).status).toBe(
			403,
		)

		await harness.dispose()
	})

	it("cannot reach a dashboard belonging to another org", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])
		const id = await createDashboard(harness, key.secret)
		await harness.request("PUT", `/v2/dashboards/${id}/share`, key.secret, { mode: "public" })

		const foreign = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(Schema.decodeUnknownSync(OrgId)("org_other"), USER_OTHER, {
					name: "other-org",
					scopes: ["dashboards:write"],
				})
			}),
		)

		// The dashboard load is org-scoped, so another org's key cannot even learn
		// that this dashboard is shared.
		expect((await harness.request("GET", `/v2/dashboards/${id}/share`, foreign.secret)).status).toBe(404)
		expect(
			(await harness.request("PUT", `/v2/dashboards/${id}/share`, foreign.secret, { mode: "public" }))
				.status,
		).toBe(404)

		await harness.dispose()
	})

	it("shares a single widget on its own link", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])
		const id = await createDashboard(harness, key.secret)

		const unshared = await harness.request("GET", `/v2/dashboards/${id}/widgets/w-1/share`, key.secret)
		expect(unshared.body).toBeNull()

		const shared = await harness.request("PUT", `/v2/dashboards/${id}/widgets/w-1/share`, key.secret, {
			mode: "public",
		})
		expect(shared.status).toBe(200)
		expect(shared.body.widget_id).toBe("w-1")
		expect(typeof shared.body.token).toBe("string")
		expect(await resolve(harness, shared.body.token)).toBe(id)

		await harness.dispose()
	})

	it("refuses to mint a link for a widget that is not on the board", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])
		const id = await createDashboard(harness, key.secret)

		// Otherwise the caller walks away with a token that resolves to a
		// permanently blank tile.
		const bogus = await harness.request(
			"PUT",
			`/v2/dashboards/${id}/widgets/does-not-exist/share`,
			key.secret,
			{ mode: "public" },
		)
		expect(bogus.status).toBe(404)

		await harness.dispose()
	})

	it("keeps a widget share independent of the dashboard's own", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])
		const id = await createDashboard(harness, key.secret)

		const board = await harness.request("PUT", `/v2/dashboards/${id}/share`, key.secret, {
			mode: "public",
		})
		const widget = await harness.request("PUT", `/v2/dashboards/${id}/widgets/w-1/share`, key.secret, {
			mode: "public",
		})
		const boardToken: string = board.body.token
		const widgetToken: string = widget.body.token
		expect(widgetToken).not.toBe(boardToken)

		// Both live at once — the partial unique index folds a null widget_id to
		// '', so the two scopes do not collide.
		const listed = await harness.request("GET", `/v2/dashboards/${id}/shares`, key.secret)
		expect(listed.body).toHaveLength(2)

		// This is the property an embed depends on: unsharing the board must not
		// break a chart already embedded in someone else's page.
		await harness.request("DELETE", `/v2/dashboards/${id}/share`, key.secret)
		expect(await resolve(harness, boardToken)).toBe("__not_found__")
		expect(await resolve(harness, widgetToken)).toBe(id)

		// And the reverse: rotating the widget link leaves the board's alone.
		const reshared = await harness.request("PUT", `/v2/dashboards/${id}/share`, key.secret, {
			mode: "public",
		})
		const rotated = await harness.request(
			"POST",
			`/v2/dashboards/${id}/widgets/w-1/share/rotate`,
			key.secret,
		)
		expect(await resolve(harness, widgetToken)).toBe("__not_found__")
		expect(await resolve(harness, rotated.body.token)).toBe(id)
		expect(await resolve(harness, reshared.body.token)).toBe(id)

		await harness.dispose()
	})

	it("scopes each widget's link to its own widget", async () => {
		const harness = makeHarness()
		const key = await harness.bootstrapKey(["dashboards:write"])
		const id = await createDashboard(harness, key.secret)

		await harness.request("PUT", `/v2/dashboards/${id}/widgets/w-1/share`, key.secret, {
			mode: "public",
		})

		// A second widget's scope is a separate row; asking for it must not return
		// the first one's share.
		const other = await harness.request("GET", `/v2/dashboards/${id}/widgets/w-2/share`, key.secret)
		expect(other.body).toBeNull()

		await harness.dispose()
	})
})
