import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	OrgId,
	UserId,
} from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Env } from "@/lib/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/lib/test-pglite"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { AuthService } from "@/services/auth/AuthService"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { ApiAuthorizationV2Layer } from "@/services/auth/ApiAuthorizationV2Layer"
import {
	SLACK_CALLBACK_PATH,
	SlackIntegrationService,
	type SlackIntegrationServiceShape,
} from "@/services/integrations/SlackIntegrationService"
import { V2SchemaErrorsLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"

/**
 * End-to-end HTTP tests for the `slackIntegration` v2 group: a real router
 * (auth middleware, admin gate, v2 error envelopes) over an embedded PGlite,
 * with a hand-built {@link SlackIntegrationService} fake so each service error
 * tag can be pinned to the status it must map to.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

/**
 * The API and the web app sit on sibling hosts of one registrable domain in
 * every real deployment; `isTrustedCallbackOrigin` is what enforces that, so
 * the harness mirrors it (`api.maple.test` / `app.maple.test`).
 */
const APP_BASE_URL = "https://app.maple.test"
const API_HOST = "api.maple.test"

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
			MAPLE_APP_BASE_URL: APP_BASE_URL,
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const die = () => Effect.die(new Error("This SlackIntegrationService method is not stubbed in this test"))

/**
 * A real `SlackIntegrationService` with only the methods a test exercises —
 * anything else dies loudly rather than silently succeeding.
 */
const slackServiceLayer = (overrides: Partial<SlackIntegrationServiceShape>) =>
	Layer.succeed(
		SlackIntegrationService,
		SlackIntegrationService.of({
			startInstall: die,
			completeInstall: die,
			getStatus: die,
			uninstall: die,
			listChannels: die,
			resolveForBot: die,
			revokeByTeamId: die,
			reconcileWorkspaces: die,
			...overrides,
		}),
	)

const makeHarness = (slack: Partial<SlackIntegrationServiceShape> = {}) => {
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
		Layer.provide(slackServiceLayer(slack)),
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
	const ORG = Schema.decodeUnknownSync(OrgId)("org_slack_e2e")
	const USER = Schema.decodeUnknownSync(UserId)("user_slack_e2e")

	/** Root-role key (API keys resolve as `root` unless their metadata pins roles). */
	const bootstrapAdminKey = (scopes?: ReadonlyArray<string>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, { name: "slack-admin", scopes })
			}),
		)

	/** A caller with a real, non-admin role — same shape the CLI login flow issues. */
	const bootstrapMemberKey = () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, {
					name: "slack-member",
					metadataJson: { source: "maple_cli", roles: ["org:member"], deviceName: "laptop" },
				})
			}),
		)

	const request = async (
		method: string,
		path: string,
		token: string,
		options: { forwardedHost?: string } = {},
	) => {
		const response = await handler(
			new Request(`http://${API_HOST}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					// `resolveRequestOrigin` prefers x-forwarded-host; set it explicitly
					// so the resolved origin does not depend on the web adapter's
					// host-header handling.
					"x-forwarded-host": options.forwardedHost ?? API_HOST,
				},
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
	}

	return {
		bootstrapAdminKey,
		bootstrapMemberKey,
		request,
		ORG,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("v2 slack integration over HTTP", () => {
	it("returns the installed status in v2 wire shape", async () => {
		const harness = makeHarness({
			getStatus: () =>
				Effect.succeed({
					installed: true,
					teamId: "T0123ABCD",
					teamName: "Acme",
					botUserId: "U0456BOT",
					installedAt: Date.parse("2026-07-01T12:00:00.000Z"),
					disconnectedReason: null,
					disconnectedTeamName: null,
					disconnectedAt: null,
					missingScopes: ["reactions:write"],
				}),
		})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request("GET", "/v2/integrations/slack", key.secret)
		expect(status).toBe(200)
		expect(body).toEqual({
			object: "slack_integration",
			installed: true,
			team_id: "T0123ABCD",
			team_name: "Acme",
			bot_user_id: "U0456BOT",
			installed_at: "2026-07-01T12:00:00.000Z",
			disconnected_reason: null,
			disconnected_team_name: null,
			disconnected_at: null,
			missing_scopes: ["reactions:write"],
		})
		// snake_case only — no camelCase leakage from the service shape.
		expect("teamId" in body).toBe(false)
		await harness.dispose()
	})

	it("surfaces a remote disconnect in v2 wire shape", async () => {
		const harness = makeHarness({
			getStatus: () =>
				Effect.succeed({
					installed: false,
					teamId: null,
					teamName: null,
					botUserId: null,
					installedAt: null,
					disconnectedReason: "app_uninstalled" as const,
					disconnectedTeamName: "Acme",
					disconnectedAt: Date.parse("2026-07-20T08:30:00.000Z"),
					missingScopes: [],
				}),
		})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request("GET", "/v2/integrations/slack", key.secret)
		expect(status).toBe(200)
		expect(body).toEqual({
			object: "slack_integration",
			installed: false,
			team_id: null,
			team_name: null,
			bot_user_id: null,
			installed_at: null,
			disconnected_reason: "app_uninstalled",
			disconnected_team_name: "Acme",
			disconnected_at: "2026-07-20T08:30:00.000Z",
			missing_scopes: [],
		})
		await harness.dispose()
	})

	it("maps a status persistence failure to 503", async () => {
		const harness = makeHarness({
			getStatus: () =>
				Effect.fail(new IntegrationsPersistenceError({ message: "slack workspace lookup failed" })),
		})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request("GET", "/v2/integrations/slack", key.secret)
		expect(status).toBe(503)
		expect(body.error).toMatchObject({ type: "api_error", code: "service_unavailable" })
		await harness.dispose()
	})

	it("starts an install for an admin, deriving the callback from the request origin", async () => {
		const calls: Array<{ orgId: string; userId: string; callbackUrl: string }> = []
		const harness = makeHarness({
			startInstall: (orgId, userId, callbackUrl) =>
				Effect.sync(() => {
					calls.push({ orgId, userId, callbackUrl })
					return { url: "https://slack.com/oauth/v2/authorize?client_id=123&state=abc" }
				}),
		})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request("POST", "/v2/integrations/slack/install", key.secret)
		expect(status).toBe(200)
		expect(body).toEqual({
			object: "slack_integration.install",
			url: "https://slack.com/oauth/v2/authorize?client_id=123&state=abc",
		})
		expect(calls).toHaveLength(1)
		expect(calls[0]!.orgId).toBe(harness.ORG)
		expect(calls[0]!.callbackUrl).toBe(`https://${API_HOST}${SLACK_CALLBACK_PATH}`)
		await harness.dispose()
	})

	it("refuses an install from a non-admin member with 403 and never calls the service", async () => {
		let called = false
		const harness = makeHarness({
			startInstall: () =>
				Effect.sync(() => {
					called = true
					return { url: "https://slack.com/oauth/v2/authorize" }
				}),
		})
		const member = await harness.bootstrapMemberKey()

		const { status, body } = await harness.request(
			"POST",
			"/v2/integrations/slack/install",
			member.secret,
		)
		expect(status).toBe(403)
		expect(body.error).toEqual({
			type: "permission_error",
			code: "insufficient_permissions",
			message: "Only org admins can install the Slack app",
		})
		expect(called).toBe(false)
		await harness.dispose()
	})

	it("fails an install closed with 503 when the request origin is not trusted", async () => {
		let called = false
		const harness = makeHarness({
			startInstall: () =>
				Effect.sync(() => {
					called = true
					return { url: "https://slack.com/oauth/v2/authorize" }
				}),
		})
		const key = await harness.bootstrapAdminKey()

		// A spoofed `x-forwarded-host` would otherwise mint an authorize URL whose
		// redirect_uri points at a host the attacker controls.
		const { status, body } = await harness.request("POST", "/v2/integrations/slack/install", key.secret, {
			forwardedHost: "public.example.com",
		})
		expect(status).toBe(503)
		expect(body.error).toMatchObject({ type: "api_error", code: "service_unavailable" })
		expect(called).toBe(false)
		await harness.dispose()
	})

	it("maps install validation and persistence failures to 503", async () => {
		const unconfigured = makeHarness({
			startInstall: () =>
				Effect.fail(
					new IntegrationsValidationError({ message: "Slack integration is not configured" }),
				),
		})
		const unconfiguredKey = await unconfigured.bootstrapAdminKey()
		const validation = await unconfigured.request(
			"POST",
			"/v2/integrations/slack/install",
			unconfiguredKey.secret,
		)
		expect(validation.status).toBe(503)
		expect(validation.body.error.code).toBe("service_unavailable")
		await unconfigured.dispose()

		const broken = makeHarness({
			startInstall: () =>
				Effect.fail(new IntegrationsPersistenceError({ message: "oauth state insert failed" })),
		})
		const brokenKey = await broken.bootstrapAdminKey()
		const persistence = await broken.request("POST", "/v2/integrations/slack/install", brokenKey.secret)
		expect(persistence.status).toBe(503)
		await broken.dispose()
	})

	it("uninstalls for an admin and answers with the fixed uninstall body", async () => {
		const orgs: string[] = []
		const harness = makeHarness({
			uninstall: (orgId) =>
				Effect.sync(() => {
					orgs.push(orgId)
					return { uninstalled: true }
				}),
		})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request("DELETE", "/v2/integrations/slack", key.secret)
		expect(status).toBe(200)
		expect(body).toEqual({ object: "slack_integration", installed: false })
		expect(orgs).toEqual([harness.ORG])
		await harness.dispose()
	})

	it("refuses an uninstall from a non-admin member with 403 and never calls the service", async () => {
		let called = false
		const harness = makeHarness({
			uninstall: () =>
				Effect.sync(() => {
					called = true
					return { uninstalled: true }
				}),
		})
		const member = await harness.bootstrapMemberKey()

		const { status, body } = await harness.request("DELETE", "/v2/integrations/slack", member.secret)
		expect(status).toBe(403)
		expect(body.error).toEqual({
			type: "permission_error",
			code: "insufficient_permissions",
			message: "Only org admins can uninstall the Slack app",
		})
		expect(called).toBe(false)
		await harness.dispose()
	})

	it("maps an uninstall persistence failure to 503", async () => {
		const harness = makeHarness({
			uninstall: () =>
				Effect.fail(new IntegrationsPersistenceError({ message: "revoke write failed" })),
		})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request("DELETE", "/v2/integrations/slack", key.secret)
		expect(status).toBe(503)
		expect(body.error.code).toBe("service_unavailable")
		await harness.dispose()
	})

	it("returns the bespoke channel-list envelope with snake_case channel flags", async () => {
		const harness = makeHarness({
			listChannels: () =>
				Effect.succeed({
					channels: [
						{ id: "C0789CHAN", name: "incidents", isPrivate: false, isMember: true },
						{ id: "C0790PRIV", name: "sre-private", isPrivate: true, isMember: false },
					],
					truncated: false,
				}),
		})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request("GET", "/v2/integrations/slack/channels", key.secret)
		expect(status).toBe(200)
		// Deliberately NOT the standard `{ object: "list", data, … }` envelope.
		expect(body).toEqual({
			object: "slack_integration.channel_list",
			channels: [
				{ id: "C0789CHAN", name: "incidents", is_private: false, is_member: true },
				{ id: "C0790PRIV", name: "sre-private", is_private: true, is_member: false },
			],
			truncated: false,
		})
		await harness.dispose()
	})

	it("reports a page-capped walk as truncated on the wire", async () => {
		const harness = makeHarness({
			listChannels: () =>
				Effect.succeed({
					channels: [{ id: "C0789CHAN", name: "incidents", isPrivate: false, isMember: true }],
					truncated: true,
				}),
		})
		const key = await harness.bootstrapAdminKey()

		const { status, body } = await harness.request("GET", "/v2/integrations/slack/channels", key.secret)
		expect(status).toBe(200)
		// The client renders an "incomplete list" note off this flag, so it must
		// survive the wire mapping rather than defaulting to false.
		expect(body.truncated).toBe(true)
		await harness.dispose()
	})

	it("refuses a channel list from a non-admin member with 403 and never calls the service", async () => {
		let called = false
		const harness = makeHarness({
			listChannels: () =>
				Effect.sync(() => {
					called = true
					return {
						channels: [{ id: "C0790PRIV", name: "sre-private", isPrivate: true, isMember: true }],
						truncated: false,
					}
				}),
		})
		const member = await harness.bootstrapMemberKey()

		// The list enumerates the workspace's channels — including private ones the
		// bot was invited to — so it is admin-gated like install/uninstall.
		const { status, body } = await harness.request(
			"GET",
			"/v2/integrations/slack/channels",
			member.secret,
		)
		expect(status).toBe(403)
		expect(body.error).toEqual({
			type: "permission_error",
			code: "insufficient_permissions",
			message: "Only org admins can list Slack channels",
		})
		expect(called).toBe(false)
		await harness.dispose()
	})

	it("still serves the install status to a non-admin member (the integration card renders for everyone)", async () => {
		const harness = makeHarness({
			getStatus: () =>
				Effect.succeed({
					installed: true,
					teamId: "T0123ABCD",
					teamName: "Acme",
					botUserId: "U0456BOT",
					installedAt: null,
					disconnectedReason: null,
					disconnectedTeamName: null,
					disconnectedAt: null,
					missingScopes: [],
				}),
		})
		const member = await harness.bootstrapMemberKey()

		const { status, body } = await harness.request("GET", "/v2/integrations/slack", member.secret)
		expect(status).toBe(200)
		expect(body.installed).toBe(true)
		await harness.dispose()
	})

	it("maps each channels service error tag to its status: 404, 502, 503", async () => {
		const notConnected = makeHarness({
			listChannels: () =>
				Effect.fail(
					new IntegrationsNotConnectedError({
						message: "Slack is not connected for this organization",
					}),
				),
		})
		const notConnectedKey = await notConnected.bootstrapAdminKey()
		const missing = await notConnected.request(
			"GET",
			"/v2/integrations/slack/channels",
			notConnectedKey.secret,
		)
		expect(missing.status).toBe(404)
		expect(missing.body.error).toMatchObject({
			type: "not_found_error",
			code: "resource_missing",
			message: "Slack is not connected for this organization",
		})
		await notConnected.dispose()

		const upstream = makeHarness({
			listChannels: () =>
				Effect.fail(
					new IntegrationsUpstreamError({
						message: "Slack conversations.list error: invalid_auth",
					}),
				),
		})
		const upstreamKey = await upstream.bootstrapAdminKey()
		const rejected = await upstream.request("GET", "/v2/integrations/slack/channels", upstreamKey.secret)
		expect(rejected.status).toBe(502)
		expect(rejected.body.error).toMatchObject({ type: "api_error", code: "slack_upstream_error" })
		await upstream.dispose()

		const persistence = makeHarness({
			listChannels: () =>
				Effect.fail(new IntegrationsPersistenceError({ message: "workspace lookup failed" })),
		})
		const persistenceKey = await persistence.bootstrapAdminKey()
		const unavailable = await persistence.request(
			"GET",
			"/v2/integrations/slack/channels",
			persistenceKey.secret,
		)
		expect(unavailable.status).toBe(503)
		expect(unavailable.body.error.code).toBe("service_unavailable")
		await persistence.dispose()
	})

	it("enforces the integrations read/write scope family", async () => {
		const harness = makeHarness({
			getStatus: () =>
				Effect.succeed({
					installed: false,
					teamId: null,
					teamName: null,
					botUserId: null,
					installedAt: null,
					disconnectedReason: null,
					disconnectedTeamName: null,
					disconnectedAt: null,
					missingScopes: [],
				}),
			startInstall: () => Effect.succeed({ url: "https://slack.com/oauth/v2/authorize" }),
		})
		const readOnly = await harness.bootstrapAdminKey(["integrations:read"])

		const read = await harness.request("GET", "/v2/integrations/slack", readOnly.secret)
		expect(read.status).toBe(200)

		const write = await harness.request("POST", "/v2/integrations/slack/install", readOnly.secret)
		expect(write.status).toBe(403)
		expect(write.body.error).toMatchObject({
			type: "permission_error",
			code: "insufficient_scope",
		})
		await harness.dispose()
	})
})
