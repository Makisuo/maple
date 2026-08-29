import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2, encodePublicId } from "@maple/domain/http/v2"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { Env } from "@/platform/Env"
import { ApiAuthorizationV2Layer } from "@/services/auth/ApiAuthorizationV2Layer"
import { AuditLogService } from "@/services/audit/AuditLogService"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { AuthService } from "@/services/auth/AuthService"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@/services/dashboards/SharedDashboardService"
import { LiveActivitiesService } from "@/services/push/LiveActivitiesService"
import { MobileDevicesService } from "@/services/push/MobileDevicesService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	Phase1ResourceStubsLayer,
	PlanetScaleServiceStubsLayer,
	SlackIntegrationServiceStubLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"

/**
 * `/v2/mobile_devices` over an embedded PGlite: register is an idempotent
 * upsert keyed on the token, preferences merge, list is scoped to the caller,
 * and unregister removes the row.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_mobile_e2e")
const USER = Schema.decodeUnknownSync(UserId)("user_mobile_e2e")
const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
/** ActivityKit's two extra tokens: one starts an activity, one updates it. */
const START_TOKEN = "b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
const ACTIVITY_TOKEN = "c1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3488",
			MCP_PORT: "3489",
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
		SharedDashboardService.layer,
		MobileDevicesService.layer,
		LiveActivitiesService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(ConfigResourceServiceStubsLayer),
		Layer.provide(Phase1ResourceStubsLayer),
		Layer.provide(SlackIntegrationServiceStubLayer),
		Layer.provide(PlanetScaleServiceStubsLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(AuditLogService.layer),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)

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

	const bootstrapKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "mobile-test", scopes })
			}),
		)

	return {
		request,
		bootstrapKey,
		runtime,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 mobile devices", () => {
	it("registers, refreshes, lists, and unregisters a device", async () => {
		const harness = makeHarness()
		try {
			const key = await harness.bootstrapKey()

			const created = await harness.request("PUT", `/v2/mobile_devices/${TOKEN}`, key.secret, {
				platform: "ios",
				environment: "sandbox",
				bundle_id: "com.maple.mobile",
				app_version: "0.2.0",
				device_name: "iPhone",
			})
			expect(created.status).toBe(200)
			expect(created.body.object).toBe("mobile_device")
			expect(created.body.id).toMatch(/^mdev_/)
			expect(created.body.token).toBe(TOKEN)
			expect(created.body.enabled).toBe(true)
			// Defaults: critical incidents only — everything else is opt-in.
			expect(created.body.preferences).toEqual({
				critical_incidents: true,
				warning_incidents: false,
				resolved_incidents: false,
				new_error_issues: false,
				anomalies: false,
			})

			// A second PUT with a partial preferences patch merges rather than
			// resets, and keeps the same id.
			const refreshed = await harness.request("PUT", `/v2/mobile_devices/${TOKEN}`, key.secret, {
				platform: "ios",
				environment: "production",
				bundle_id: "com.maple.mobile",
				preferences: { resolved_incidents: true, anomalies: true },
			})
			expect(refreshed.status).toBe(200)
			expect(refreshed.body.id).toBe(created.body.id)
			expect(refreshed.body.environment).toBe("production")
			expect(refreshed.body.app_version).toBe("0.2.0")
			expect(refreshed.body.preferences).toEqual({
				critical_incidents: true,
				warning_incidents: false,
				resolved_incidents: true,
				new_error_issues: false,
				anomalies: true,
			})

			const listed = await harness.request("GET", "/v2/mobile_devices", key.secret)
			expect(listed.status).toBe(200)
			expect(listed.body.data.map((device: { id: string }) => device.id)).toEqual([created.body.id])

			// The fan-out read sees the same device as enabled.
			const forOrg = await harness.runtime.runPromise(
				Effect.gen(function* () {
					const devices = yield* MobileDevicesService
					return yield* devices.listForOrg(ORG)
				}),
			)
			expect(forOrg.map((device) => device.token)).toEqual([TOKEN])

			const removed = await harness.request("DELETE", `/v2/mobile_devices/${TOKEN}`, key.secret)
			expect(removed.status).toBe(200)
			expect(removed.body).toEqual({ id: created.body.id, object: "mobile_device", deleted: true })

			const again = await harness.request("DELETE", `/v2/mobile_devices/${TOKEN}`, key.secret)
			expect(again.status).toBe(404)
			expect(again.body.error._tag).toBe("@maple/http/errors/MobileDeviceNotFoundError")

			const empty = await harness.request("GET", "/v2/mobile_devices", key.secret)
			expect(empty.body.data).toEqual([])
		} finally {
			await harness.dispose()
		}
	})

	it("records and forgets a Live Activity's update token", async () => {
		const harness = makeHarness()
		try {
			const key = await harness.bootstrapKey()
			const incidentId = "0f8fad5b-d9cb-469f-a165-70867728950e"
			const publicIncidentId = encodePublicId("inc", incidentId)

			// Registering an activity before the device exists is a 404, not a
			// dangling row: the device is what says which APNs host to push to.
			const orphan = await harness.request(
				"PUT",
				`/v2/mobile_devices/${TOKEN}/live_activities/${publicIncidentId}`,
				key.secret,
				{ activity_id: "activity-1", push_token: ACTIVITY_TOKEN },
			)
			expect(orphan.status).toBe(404)

			const device = await harness.request("PUT", `/v2/mobile_devices/${TOKEN}`, key.secret, {
				platform: "ios",
				environment: "sandbox",
				bundle_id: "com.maple.mobile",
				live_activity_start_token: START_TOKEN,
			})
			expect(device.status).toBe(200)
			expect(device.body.live_activities_enabled).toBe(true)

			const registered = await harness.request(
				"PUT",
				`/v2/mobile_devices/${TOKEN}/live_activities/${publicIncidentId}`,
				key.secret,
				{ activity_id: "activity-1", push_token: ACTIVITY_TOKEN },
			)
			expect(registered.status).toBe(200)
			expect(registered.body.incident_id).toBe(publicIncidentId)
			expect(registered.body.ended).toBe(false)

			const running = await harness.runtime.runPromise(
				Effect.gen(function* () {
					const activities = yield* LiveActivitiesService
					return yield* activities.listActive(ORG, incidentId)
				}),
			)
			expect(running.map((row) => row.pushToken)).toEqual([ACTIVITY_TOKEN])

			// iOS rotated the token: the same (device, incident) is updated, not
			// duplicated.
			const rotated = await harness.request(
				"PUT",
				`/v2/mobile_devices/${TOKEN}/live_activities/${publicIncidentId}`,
				key.secret,
				{ activity_id: "activity-1", push_token: `${ACTIVITY_TOKEN}ff` },
			)
			expect(rotated.status).toBe(200)

			const ended = await harness.request(
				"DELETE",
				`/v2/mobile_devices/${TOKEN}/live_activities/${publicIncidentId}`,
				key.secret,
			)
			expect(ended.status).toBe(200)
			expect(ended.body).toEqual({
				object: "live_activity",
				incident_id: publicIncidentId,
				deleted: true,
			})

			const afterEnd = await harness.runtime.runPromise(
				Effect.gen(function* () {
					const activities = yield* LiveActivitiesService
					return yield* activities.listActive(ORG, incidentId)
				}),
			)
			expect(afterEnd).toEqual([])
		} finally {
			await harness.dispose()
		}
	})

	it("disables a device the platform reported dead and re-enables it on re-registration", async () => {
		const harness = makeHarness()
		try {
			const key = await harness.bootstrapKey()
			const created = await harness.request("PUT", `/v2/mobile_devices/${TOKEN}`, key.secret, {
				platform: "ios",
				environment: "production",
				bundle_id: "com.maple.mobile",
			})
			expect(created.status).toBe(200)

			await harness.runtime.runPromise(
				Effect.gen(function* () {
					const devices = yield* MobileDevicesService
					const [device] = yield* devices.listForOrg(ORG)
					yield* devices.disable(device!.id, "Unregistered")
					expect(yield* devices.listForOrg(ORG)).toEqual([])
				}),
			)

			const listed = await harness.request("GET", "/v2/mobile_devices", key.secret)
			expect(listed.body.data[0].enabled).toBe(false)

			const revived = await harness.request("PUT", `/v2/mobile_devices/${TOKEN}`, key.secret, {
				platform: "ios",
				environment: "production",
				bundle_id: "com.maple.mobile",
			})
			expect(revived.body.enabled).toBe(true)
		} finally {
			await harness.dispose()
		}
	})

	it("enforces the mobile_devices scope family on restricted keys", async () => {
		const harness = makeHarness()
		try {
			const readOnly = await harness.bootstrapKey(["mobile_devices:read"])
			const denied = await harness.request("PUT", `/v2/mobile_devices/${TOKEN}`, readOnly.secret, {
				platform: "ios",
				environment: "production",
				bundle_id: "com.maple.mobile",
			})
			expect(denied.status).toBe(403)
			const allowed = await harness.request("GET", "/v2/mobile_devices", readOnly.secret)
			expect(allowed.status).toBe(200)
		} finally {
			await harness.dispose()
		}
	})
})
