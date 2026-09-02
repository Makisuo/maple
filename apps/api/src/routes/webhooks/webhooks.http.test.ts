import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Env } from "@/platform/Env"
import { ProductEventsService, type ProductEventInput } from "@/services/product-events/ProductEventsService"
import { signSvix } from "@/services/product-events/svix"
import { AuditLogService, type AuditLogRecordInput } from "@/services/audit/AuditLogService"
import {
	MembershipRevocationService,
	MembershipRevocationError,
	type MembershipRevocationSummary,
} from "@/services/auth/MembershipRevocationService"
import { AutumnWebhookRouter } from "./autumn.http"
import { ClerkWebhookRoute } from "./clerk.http"

const CLERK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
const AUTUMN_SECRET = "whsec_" + Buffer.alloc(24, 7).toString("base64")

const makeConfig = (extra: Record<string, string>) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			...extra,
		}),
	)

const recordingProductEvents = () => {
	const tracked: Array<ProductEventInput> = []
	const layer = Layer.succeed(ProductEventsService, {
		enabled: true,
		track: (event) => Effect.sync(() => void tracked.push(event)),
	})
	return { tracked, layer }
}

const recordingAudit = () => {
	const recorded: Array<AuditLogRecordInput> = []
	const layer = Layer.succeed(AuditLogService, {
		record: (input) => Effect.sync(() => void recorded.push(input)),
		list: () => Effect.succeed([]),
	})
	return { recorded, layer }
}

const EMPTY_SUMMARY: MembershipRevocationSummary = {
	apiKeysRevoked: 0,
	mcpFamiliesRevoked: 0,
	cliAuthorizationsDeleted: 0,
	mcpAuthorizationsDeleted: 0,
	emailDestinationsUpdated: 0,
	mobileDevicesDeleted: 0,
}

/** Records the sweeps the route asks for, and can be made to fail on demand. */
const recordingRevocation = (fail = false) => {
	const calls: Array<string> = []
	const run = (label: string) =>
		fail
			? Effect.fail(new MembershipRevocationError({ message: "boom" }))
			: Effect.sync(() => {
					calls.push(label)
					return EMPTY_SUMMARY
				})
	const layer = Layer.succeed(MembershipRevocationService, {
		revokeMembership: (orgId, userId) => run(`revoke:${orgId}:${userId}`),
		revokeUser: (userId) => run(`revokeUser:${userId}`),
		demoteMembership: (orgId, userId, roles) =>
			run(`demote:${orgId}:${userId}:${roles.join(",")}`).pipe(
				Effect.map(() => ({ apiKeysRevoked: 0, mcpFamiliesRevoked: 0 })),
			),
		invalidateMembership: (userId) =>
			fail
				? Effect.void
				: Effect.sync(() => {
						calls.push(`invalidate:${userId}`)
					}),
	})
	return { calls, layer }
}

const makeRouterLayer = (
	router: typeof ClerkWebhookRoute | typeof AutumnWebhookRouter,
	config: Record<string, string>,
	productEvents: Layer.Layer<ProductEventsService>,
	revocation: Layer.Layer<MembershipRevocationService> = recordingRevocation().layer,
	audit: Layer.Layer<AuditLogService> = recordingAudit().layer,
) =>
	router.pipe(
		Layer.provide(productEvents),
		Layer.provide(revocation),
		Layer.provide(audit),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig(config)),
	)

const signedHeaders = (secret: string, body: string, nowMs: number, id = "msg_test") =>
	Effect.gen(function* () {
		const timestamp = String(Math.floor(nowMs / 1000))
		const signature = yield* signSvix(secret, id, timestamp, body)
		return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` }
	})

const post = (
	handler: (request: Request, context: Context.Context<never>) => Promise<Response>,
	path: string,
	body: string,
	headers: Record<string, string>,
) =>
	Effect.promise(() =>
		handler(
			new Request(`http://api.localhost${path}`, { method: "POST", body, headers }),
			Context.empty(),
		),
	)

const CLERK_USER_CREATED = JSON.stringify({
	type: "user.created",
	timestamp: 1_700_000_000_000,
	data: {
		id: "user_2abc",
		created_at: 1_700_000_000_000,
		primary_email_address_id: "idn_2",
		email_addresses: [
			{ id: "idn_1", email_address: "personal@gmail.com" },
			{ id: "idn_2", email_address: "Dev@Example.COM" },
		],
		external_accounts: [{ provider: "oauth_github" }],
	},
})

const AUTUMN_BILLING_UPDATED = JSON.stringify({
	type: "billing.updated",
	data: {
		object: "billing.updated",
		customer_id: "org_42",
		plan_changes: [
			{
				action: "activated",
				subscription: {
					plan_id: "startup",
					status: "active",
					past_due: false,
					started_at: 1_761_840_000_000,
					canceled_at: null,
					expires_at: null,
					trial_ends_at: null,
					current_period_start: 1_761_840_000_000,
					current_period_end: 1_764_432_000_000,
				},
				previous_attributes: null,
				item_changes: [],
			},
			{
				action: "expired",
				subscription: {
					plan_id: "free",
					status: "expired",
					past_due: false,
					started_at: 1_759_248_000_000,
					canceled_at: 1_761_840_000_000,
					expires_at: 1_761_840_000_000,
					trial_ends_at: null,
					current_period_start: null,
					current_period_end: null,
				},
				previous_attributes: { status: "active" },
				item_changes: [],
			},
		],
		tags: [],
	},
})

const CLERK_MEMBERSHIP_CREATED = JSON.stringify({
	type: "organizationMembership.created",
	timestamp: 1_700_000_000_000,
	data: {
		organization: { id: "org_42" },
		public_user_data: { user_id: "user_2abc" },
		role: "org:admin",
	},
})

describe("ClerkWebhookRouter", () => {
	// Membership is changed in Clerk, never through Maple's API, so this receiver
	// is the only writer of `affected_user`.
	it.effect("audits an organizationMembership.created delivery against the member", () =>
		Effect.gen(function* () {
			const events = recordingProductEvents()
			const audit = recordingAudit()
			const configured = HttpRouter.toWebHandler(
				makeRouterLayer(
					ClerkWebhookRouter,
					{ CLERK_WEBHOOK_SECRET: CLERK_SECRET },
					events.layer,
					audit.layer,
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const now = Date.now()
				const headers = yield* signedHeaders(CLERK_SECRET, CLERK_MEMBERSHIP_CREATED, now)
				const response = yield* post(
					configured.handler,
					"/webhooks/clerk",
					CLERK_MEMBERSHIP_CREATED,
					headers,
				)
				assert.strictEqual(response.status, 200)
				assert.strictEqual(audit.recorded.length, 1)
				const entry = audit.recorded[0]!
				assert.strictEqual(entry.action, "member.added")
				assert.strictEqual(entry.affectedUserId, "user_2abc")
				assert.strictEqual(entry.orgId, "org_42")
				// Clerk's payload never names the admin who acted; claiming a user
				// here would be a guess, so the entry is Maple recording what it learned.
				assert.strictEqual(entry.actor.type, "system")
				assert.strictEqual(entry.source, "system")
			}).pipe(Effect.ensuring(Effect.promise(() => configured.dispose())))
		}),
	)

	it.effect(
		"503s while unconfigured, 401s a bad signature, and emits signup_completed for user.created",
		() =>
			Effect.gen(function* () {
				const events = recordingProductEvents()
				const unconfigured = HttpRouter.toWebHandler(
					makeRouterLayer(ClerkWebhookRoute, {}, events.layer),
					{
						disableLogger: true,
					},
				)
				yield* Effect.gen(function* () {
					const response = yield* post(
						unconfigured.handler,
						"/webhooks/clerk",
						CLERK_USER_CREATED,
						{},
					)
					assert.strictEqual(response.status, 503)
				}).pipe(Effect.ensuring(Effect.promise(unconfigured.dispose)))

				const configured = HttpRouter.toWebHandler(
					makeRouterLayer(ClerkWebhookRoute, { CLERK_WEBHOOK_SECRET: CLERK_SECRET }, events.layer),
					{ disableLogger: true },
				)
				yield* Effect.gen(function* () {
					const now = Date.now()
					const missing = yield* post(configured.handler, "/webhooks/clerk", CLERK_USER_CREATED, {})
					assert.strictEqual(missing.status, 401)

					const stale = yield* signedHeaders(CLERK_SECRET, CLERK_USER_CREATED, now - 10 * 60 * 1000)
					const staleResponse = yield* post(
						configured.handler,
						"/webhooks/clerk",
						CLERK_USER_CREATED,
						stale,
					)
					assert.strictEqual(staleResponse.status, 401)

					const tampered = yield* signedHeaders(CLERK_SECRET, CLERK_USER_CREATED, now)
					const tamperedResponse = yield* post(
						configured.handler,
						"/webhooks/clerk",
						CLERK_USER_CREATED.replace("user_2abc", "user_evil"),
						tampered,
					)
					assert.strictEqual(tamperedResponse.status, 401)
					assert.strictEqual(events.tracked.length, 0)

					const ok = yield* signedHeaders(CLERK_SECRET, CLERK_USER_CREATED, now)
					const accepted = yield* post(
						configured.handler,
						"/webhooks/clerk",
						CLERK_USER_CREATED,
						ok,
					)
					assert.strictEqual(accepted.status, 200)
					assert.deepStrictEqual(events.tracked, [
						{
							name: "signup_completed",
							userId: "user_2abc",
							timestamp: 1_700_000_000_000,
							attributes: { sign_up_source: "github", email_domain: "example.com" },
						},
					])

					// Other event types are acknowledged and ignored.
					const other = JSON.stringify({ type: "session.created", data: { id: "sess_1" } })
					const otherHeaders = yield* signedHeaders(CLERK_SECRET, other, now, "msg_other")
					const ignored = yield* post(configured.handler, "/webhooks/clerk", other, otherHeaders)
					assert.strictEqual(ignored.status, 200)
					assert.strictEqual(events.tracked.length, 1)
				}).pipe(Effect.ensuring(Effect.promise(configured.dispose)))
			}),
	)
	it.effect("sweeps a removed member, only invalidates on a role change, and 500s a failed sweep", () =>
		Effect.gen(function* () {
			const events = recordingProductEvents()
			const revocation = recordingRevocation()
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(
					ClerkWebhookRoute,
					{ CLERK_WEBHOOK_SECRET: CLERK_SECRET },
					events.layer,
					revocation.layer,
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const now = Date.now()
				const membership = (type: string, role?: string) =>
					JSON.stringify({
						type,
						data: {
							organization: { id: "org_9" },
							public_user_data: { user_id: "user_9" },
							...(role === undefined ? undefined : { role }),
						},
					})

				const deleted = membership("organizationMembership.deleted")
				const deletedHeaders = yield* signedHeaders(CLERK_SECRET, deleted, now, "msg_del")
				const deletedResponse = yield* post(handler, "/webhooks/clerk", deleted, deletedHeaders)
				assert.strictEqual(deletedResponse.status, 200)

				const updated = membership("organizationMembership.updated", "org:member")
				const updatedHeaders = yield* signedHeaders(CLERK_SECRET, updated, now, "msg_upd")
				const updatedResponse = yield* post(handler, "/webhooks/clerk", updated, updatedHeaders)
				assert.strictEqual(updatedResponse.status, 200)

				const userDeleted = JSON.stringify({ type: "user.deleted", data: { id: "user_9" } })
				const userHeaders = yield* signedHeaders(CLERK_SECRET, userDeleted, now, "msg_user_del")
				const userResponse = yield* post(handler, "/webhooks/clerk", userDeleted, userHeaders)
				assert.strictEqual(userResponse.status, 200)

				// A role change goes to the demotion sweep carrying the *new* role, so
				// keys pinned to the role the member just lost are retired.
				assert.deepStrictEqual(revocation.calls, [
					"revoke:org_9:user_9",
					"demote:org_9:user_9:org:member",
					"revokeUser:user_9",
				])

				// No role in the payload: we cannot tell demotion from promotion, so
				// the caches are evicted and nothing is revoked on a guess.
				const roleless = membership("organizationMembership.updated")
				const rolelessHeaders = yield* signedHeaders(CLERK_SECRET, roleless, now, "msg_upd_norole")
				const rolelessResponse = yield* post(handler, "/webhooks/clerk", roleless, rolelessHeaders)
				assert.strictEqual(rolelessResponse.status, 200)
				assert.strictEqual(revocation.calls.at(-1), "invalidate:user_9")

				// Clerk's delete envelope may omit the id. Nothing to sweep and no
				// retry can produce one, so it is a logged 200, not a 400 that burns
				// the retry budget and ends as a failed delivery nobody sees.
				const idless = JSON.stringify({
					type: "user.deleted",
					data: { object: "user", deleted: true },
				})
				const idlessHeaders = yield* signedHeaders(CLERK_SECRET, idless, now, "msg_user_noid")
				const idlessResponse = yield* post(handler, "/webhooks/clerk", idless, idlessHeaders)
				assert.strictEqual(idlessResponse.status, 200)
				assert.strictEqual(revocation.calls.at(-1), "invalidate:user_9")

				// An unrecognized membership shape is a 400, not a silent 200.
				const malformed = JSON.stringify({
					type: "organizationMembership.deleted",
					data: { organization: {} },
				})
				const malformedHeaders = yield* signedHeaders(CLERK_SECRET, malformed, now, "msg_bad")
				const malformedResponse = yield* post(handler, "/webhooks/clerk", malformed, malformedHeaders)
				assert.strictEqual(malformedResponse.status, 400)
			}).pipe(Effect.ensuring(Effect.promise(dispose)))

			// A half-run sweep must be loud: 500 so Clerk retries the delivery.
			const failing = recordingRevocation(true)
			const broken = HttpRouter.toWebHandler(
				makeRouterLayer(
					ClerkWebhookRoute,
					{ CLERK_WEBHOOK_SECRET: CLERK_SECRET },
					events.layer,
					failing.layer,
				),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const body = JSON.stringify({
					type: "organizationMembership.deleted",
					data: {
						organization: { id: "org_9" },
						public_user_data: { user_id: "user_9" },
					},
				})
				const headers = yield* signedHeaders(CLERK_SECRET, body, Date.now(), "msg_fail")
				const response = yield* post(broken.handler, "/webhooks/clerk", body, headers)
				assert.strictEqual(response.status, 500)
			}).pipe(Effect.ensuring(Effect.promise(broken.dispose)))
		}),
	)
})

describe("AutumnWebhookRouter", () => {
	it.effect("emits plan_started for an activated plan and plan_cancelled for the expired one", () =>
		Effect.gen(function* () {
			const events = recordingProductEvents()
			const { handler, dispose } = HttpRouter.toWebHandler(
				makeRouterLayer(AutumnWebhookRouter, { AUTUMN_WEBHOOK_SECRET: AUTUMN_SECRET }, events.layer),
				{ disableLogger: true },
			)
			yield* Effect.gen(function* () {
				const now = Date.now()
				const wrongSecret = yield* signedHeaders(CLERK_SECRET, AUTUMN_BILLING_UPDATED, now)
				const rejected = yield* post(handler, "/webhooks/autumn", AUTUMN_BILLING_UPDATED, wrongSecret)
				assert.strictEqual(rejected.status, 401)

				const ok = yield* signedHeaders(AUTUMN_SECRET, AUTUMN_BILLING_UPDATED, now, "msg_autumn_1")
				const accepted = yield* post(handler, "/webhooks/autumn", AUTUMN_BILLING_UPDATED, ok)
				assert.strictEqual(accepted.status, 200)
				assert.deepStrictEqual(events.tracked, [
					{
						name: "plan_started",
						groupId: "org_42",
						timestamp: 1_761_840_000_000,
						attributes: {
							plan_id: "startup",
							trigger: "webhook",
							kind: "subscription",
							subscription_started_at: "1761840000000",
							webhook_message_id: "msg_autumn_1",
						},
					},
					{
						name: "plan_cancelled",
						groupId: "org_42",
						timestamp: undefined,
						attributes: {
							plan_id: "free",
							trigger: "webhook",
							kind: "subscription",
							subscription_started_at: "1759248000000",
							webhook_message_id: "msg_autumn_1",
						},
					},
				])
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}),
	)
})
