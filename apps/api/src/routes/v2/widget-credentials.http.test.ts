import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Env } from "@/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
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
 * `/v2/widget_credentials` over an embedded PGlite. The assertions here are
 * mostly about what the credential *cannot* do — that is the whole reason it
 * exists as a distinct kind rather than a `standard` key with narrow scopes.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_widget_cred")
const USER = Schema.decodeUnknownSync(UserId)("user_widget_cred")
const INSTALLATION = "F9E1B4C0-8F2A-4C6D-9E1B-4C08F2A4C6D9"
const OTHER_INSTALLATION = "A1B2C3D4-8F2A-4C6D-9E1B-4C08F2A4C6D9"

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3492",
			MCP_PORT: "3493",
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
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)

	const request = async (method: string, path: string, token: string) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: { authorization: `Bearer ${token}` },
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
	}

	const bootstrapKey = () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "widget-cred-test" })
			}),
		)

	const mint = async (secret: string, installation = INSTALLATION) =>
		request("PUT", `/v2/widget_credentials/${installation}`, secret)

	return {
		request,
		bootstrapKey,
		mint,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 widget credentials", () => {
	it("mints a credential the server bounded, not the caller", async () => {
		const harness = makeHarness()
		try {
			const key = await harness.bootstrapKey()
			const minted = await harness.mint(key.secret)

			expect(minted.status).toBe(200)
			expect(minted.body.object).toBe("widget_credential")
			expect(minted.body.secret).toMatch(/^maple_ak_/)
			expect(minted.body.organization_id).toBe(ORG)
			// The caller asked for none of this.
			expect(minted.body.scopes).toEqual(["widget_summary:read"])
			expect(Date.parse(minted.body.expires_at)).toBeGreaterThan(Date.now())
		} finally {
			await harness.dispose()
		}
	})

	it("is fenced to the widget summary and nothing else", async () => {
		const harness = makeHarness()
		try {
			const key = await harness.bootstrapKey()
			const minted = await harness.mint(key.secret)

			const summary = await harness.request("GET", "/v2/widget_summary", minted.body.secret)
			expect(summary.status).not.toBe(401)
			expect(summary.status).not.toBe(403)

			// Everything the summary is composed from, and everything a credential
			// could otherwise be abused for. This is the property that keeps a
			// token on a phone from being an organization read key.
			for (const path of ["/v2/error_issues", "/v2/services", "/v2/mobile_devices", "/v2/api_keys"]) {
				const denied = await harness.request("GET", path, minted.body.secret)
				expect(denied.status).toBe(403)
			}
		} finally {
			await harness.dispose()
		}
	})

	it("cannot renew itself — renewal always goes through a session", async () => {
		const harness = makeHarness()
		try {
			const key = await harness.bootstrapKey()
			const minted = await harness.mint(key.secret)
			const renewed = await harness.mint(minted.body.secret)
			expect(renewed.status).toBe(403)
		} finally {
			await harness.dispose()
		}
	})

	it("replaces the installation's previous credential rather than adding one", async () => {
		const harness = makeHarness()
		try {
			const key = await harness.bootstrapKey()
			const first = await harness.mint(key.secret)
			const second = await harness.mint(key.secret)
			expect(second.body.secret).not.toBe(first.body.secret)

			// A phone that got a new key must not leave the old one live.
			expect((await harness.request("GET", "/v2/widget_summary", first.body.secret)).status).toBe(401)
			expect((await harness.request("GET", "/v2/widget_summary", second.body.secret)).status).not.toBe(
				401,
			)
		} finally {
			await harness.dispose()
		}
	})

	it("scopes the replacement to one installation", async () => {
		const harness = makeHarness()
		try {
			const key = await harness.bootstrapKey()
			const phone = await harness.mint(key.secret, INSTALLATION)
			await harness.mint(key.secret, OTHER_INSTALLATION)
			// A second device minting must not knock the first one's Home Screen out.
			expect((await harness.request("GET", "/v2/widget_summary", phone.body.secret)).status).not.toBe(
				401,
			)
		} finally {
			await harness.dispose()
		}
	})

	it("revokes on sign-out, idempotently", async () => {
		const harness = makeHarness()
		try {
			const key = await harness.bootstrapKey()
			const minted = await harness.mint(key.secret)

			const revoked = await harness.request(
				"DELETE",
				`/v2/widget_credentials/${INSTALLATION}`,
				key.secret,
			)
			expect(revoked.status).toBe(200)
			expect(revoked.body.deleted).toBe(true)
			// The Home Screen outlives the session; the credential must not.
			expect((await harness.request("GET", "/v2/widget_summary", minted.body.secret)).status).toBe(401)

			// Nothing to revoke is already the requested state.
			const again = await harness.request(
				"DELETE",
				`/v2/widget_credentials/${OTHER_INSTALLATION}`,
				key.secret,
			)
			expect(again.status).toBe(200)
		} finally {
			await harness.dispose()
		}
	})

	it("keeps device credentials out of the organization's key list", async () => {
		const harness = makeHarness()
		try {
			const key = await harness.bootstrapKey()
			await harness.mint(key.secret)

			// A dozen rows nobody created by hand, in front of an admin looking for
			// the two they did, each of them one click from breaking a Home Screen.
			const keys = await harness.request("GET", "/v2/api_keys", key.secret)
			expect(keys.status).toBe(200)
			expect(keys.body.data.every((row: { kind: string }) => row.kind !== "device")).toBe(true)
			expect(keys.body.data.some((row: { name: string }) => row.name === "widget-cred-test")).toBe(true)
		} finally {
			await harness.dispose()
		}
	})
})
