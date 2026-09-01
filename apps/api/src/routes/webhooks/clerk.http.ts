import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, type HttpServerRequest } from "effect/unstable/http"
import { Env } from "@/platform/Env"
import { MembershipRevocationService } from "@/services/auth/MembershipRevocationService"
import {
	decodeClerkEnvelope,
	decodeClerkOrganizationMembership,
	decodeClerkUserCreated,
	decodeClerkUserDeleted,
	signupCompletedEvent,
} from "@/services/product-events/clerk-events"
import { ProductEventsService } from "@/services/product-events/ProductEventsService"
import { receiveSvixWebhook, webhookText } from "./svix-receiver"

/**
 * Clerk webhook receiver. Two jobs:
 *
 * - `user.created` → `signup_completed` product event.
 * - membership lifecycle → the revocation sweep. This is the only thing in
 *   Maple that runs when somebody stops being a member of an organization;
 *   without it the membership cache and every user-bound credential keep
 *   answering yes indefinitely.
 *
 * Public route; authenticity is the Svix signature (`CLERK_WEBHOOK_SECRET`).
 * Any other event type is acknowledged with 200 so Clerk does not retry it.
 */
const ROUTE = "/webhooks/clerk"

const decodeOrgId = Schema.decodeUnknownOption(OrgId)
const decodeUserId = Schema.decodeUnknownOption(UserId)
const decodeRole = Schema.decodeUnknownOption(RoleName)

const handler = Effect.gen(function* () {
	const env = yield* Env
	const productEvents = yield* ProductEventsService
	const revocation = yield* MembershipRevocationService

	/**
	 * A revocation that only half-ran is the state this whole handler exists to
	 * prevent, so a failure is loud: 500, Clerk retries, and the failed delivery
	 * is visible in both Clerk's dashboard and the span. Every step is
	 * predicate-driven and idempotent, so a retry converges rather than
	 * double-applying — which is what makes "fail loudly" the safe choice here
	 * rather than a source of duplicate work.
	 */
	const revoke = Effect.fn("ClerkWebhook.revoke")(function* (run: Effect.Effect<unknown, unknown>) {
		const outcome = yield* run.pipe(Effect.option)
		if (Option.isNone(outcome)) {
			yield* Effect.annotateCurrentSpan({
				"http.response.status_code": 500,
				"maple.webhook.outcome": "revocation_failed",
			})
			return webhookText("Membership revocation failed", 500)
		}
		yield* Effect.annotateCurrentSpan({
			"http.response.status_code": 200,
			"maple.webhook.outcome": "handled",
		})
		return webhookText("ok", 200)
	})

	const handleMembership = Effect.fn("ClerkWebhook.membership")(function* (
		data: unknown,
		removed: boolean,
	) {
		const payload = yield* decodeClerkOrganizationMembership(data).pipe(Effect.option)
		if (Option.isNone(payload)) {
			yield* Effect.annotateCurrentSpan({
				"http.response.status_code": 400,
				"maple.webhook.outcome": "parse_rejected",
			})
			return webhookText("Unrecognized membership payload", 400)
		}
		const orgId = decodeOrgId(payload.value.organization.id)
		const userId = decodeUserId(payload.value.public_user_data.user_id)
		if (Option.isNone(orgId) || Option.isNone(userId)) {
			yield* Effect.annotateCurrentSpan({
				"http.response.status_code": 400,
				"maple.webhook.outcome": "parse_rejected",
			})
			return webhookText("Unrecognized membership identifiers", 400)
		}
		if (removed) return yield* revoke(revocation.revokeMembership(orgId.value, userId.value))

		// A role change is not just a cache eviction: CLI/MCP/device keys pin the
		// minting user's roles and are never re-checked, so a demotion has to go
		// and take those keys away. A promotion strips nothing.
		const role = payload.value.role === undefined ? Option.none() : decodeRole(payload.value.role)
		if (Option.isNone(role)) {
			// Clerk always sends `role`; without one we cannot tell a demotion from
			// a promotion, and guessing "demoted" would revoke a promoted admin's
			// keys. Evict and say so loudly instead of silently doing nothing.
			yield* Effect.logError("Clerk membership update carried no usable role").pipe(
				Effect.annotateLogs({ orgId: orgId.value, userId: userId.value }),
			)
			yield* Effect.annotateCurrentSpan({ "maple.webhook.role_missing": true })
			return yield* revoke(revocation.invalidateMembership(userId.value))
		}
		return yield* revoke(revocation.demoteMembership(orgId.value, userId.value, [role.value]))
	})

	return Effect.fn("ClerkWebhook.receive")(function* (req: HttpServerRequest.HttpServerRequest) {
		yield* Effect.annotateCurrentSpan({ "http.request.method": req.method, "http.route": ROUTE })

		const received = yield* receiveSvixWebhook({
			provider: "clerk",
			secret: env.CLERK_WEBHOOK_SECRET,
			request: req,
		})
		if (received._tag === "rejected") return received.response

		const envelope = yield* decodeClerkEnvelope(received.body).pipe(Effect.option)
		if (Option.isNone(envelope)) {
			yield* Effect.annotateCurrentSpan({
				"http.response.status_code": 400,
				"maple.webhook.outcome": "rejected",
				"maple.webhook.reason": "parse_rejected",
			})
			return webhookText("Unrecognized payload", 400)
		}
		yield* Effect.annotateCurrentSpan({ "maple.webhook.event": envelope.value.type })

		if (envelope.value.type === "organizationMembership.deleted") {
			return yield* handleMembership(envelope.value.data, true)
		}
		if (envelope.value.type === "organizationMembership.updated") {
			return yield* handleMembership(envelope.value.data, false)
		}
		if (envelope.value.type === "user.deleted") {
			const payload = yield* decodeClerkUserDeleted(envelope.value.data).pipe(Effect.option)
			const rawId = Option.isSome(payload) ? payload.value.id : undefined
			// Clerk's delete envelope may legitimately omit the id. There is then no
			// user to sweep and no retry that can produce one, so a 400 would only
			// burn Svix's retry budget and end as a failed delivery nobody sees.
			// 200 and an error log: the sweep that did not run is on the record.
			if (Option.isSome(payload) && rawId === undefined) {
				yield* Effect.logError("Clerk user.deleted carried no user id; no revocation sweep ran")
				yield* Effect.annotateCurrentSpan({
					"http.response.status_code": 200,
					"maple.webhook.outcome": "unresolvable_user",
				})
				return webhookText("ok", 200)
			}
			const userId = rawId === undefined ? Option.none() : decodeUserId(rawId)
			if (Option.isNone(userId)) {
				yield* Effect.annotateCurrentSpan({
					"http.response.status_code": 400,
					"maple.webhook.outcome": "parse_rejected",
				})
				return webhookText("Unrecognized user payload", 400)
			}
			return yield* revoke(revocation.revokeUser(userId.value))
		}

		if (envelope.value.type === "user.created") {
			const user = yield* decodeClerkUserCreated(envelope.value.data).pipe(
				Effect.tapError((error) =>
					Effect.logInfo("Clerk user.created payload failed to decode").pipe(
						Effect.annotateLogs({ error: String(error) }),
					),
				),
				Effect.option,
			)
			if (Option.isSome(user)) {
				yield* productEvents.track(signupCompletedEvent(user.value, envelope.value.timestamp))
				yield* Effect.annotateCurrentSpan({ "maple.webhook.outcome": "handled" })
			} else {
				yield* Effect.annotateCurrentSpan({ "maple.webhook.outcome": "parse_rejected" })
			}
		} else {
			yield* Effect.annotateCurrentSpan({ "maple.webhook.outcome": "ignored" })
		}

		yield* Effect.annotateCurrentSpan({ "http.response.status_code": 200 })
		return webhookText("ok", 200)
	})
})

/**
 * The route with `MembershipRevocationService` still an open requirement, so a
 * test can drive the handler against a stub without a database.
 */
export const ClerkWebhookRoute = HttpRouter.use((router) =>
	Effect.gen(function* () {
		yield* router.add("POST", ROUTE, yield* handler)
	}),
)

export const ClerkWebhookRouter = ClerkWebhookRoute.pipe(
	// Provided here rather than in the HTTP graph: the sweep pulls in the edge
	// cache and the destination encryption key, and nothing else in the router
	// tree needs them.
	Layer.provide(MembershipRevocationService.layer),
)
