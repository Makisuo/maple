import { Effect, Option, Schema } from "effect"
import { HttpRouter, type HttpServerRequest } from "effect/unstable/http"
import { Env } from "@/platform/Env"
import {
	CLERK_MEMBERSHIP_EVENTS,
	decodeClerkEnvelope,
	decodeClerkOrganizationMembership,
	decodeClerkUserCreated,
	isClerkMembershipEvent,
	signupCompletedEvent,
} from "@/services/product-events/clerk-events"
import type { ClerkOrganizationMembershipData } from "@/services/product-events/clerk-events"
import { ProductEventsService } from "@/services/product-events/ProductEventsService"
import { AuditLogService } from "@/services/audit/AuditLogService"
import { OrgId, UserId } from "@maple/domain/primitives"
import { receiveSvixWebhook, webhookText } from "./svix-receiver"

/**
 * Clerk webhook receiver: `user.created` → `signup_completed` product event,
 * and `organizationMembership.*` → an org audit entry. Public route;
 * authenticity is the Svix signature (`CLERK_WEBHOOK_SECRET`). Any other event
 * type is acknowledged with 200 so Clerk does not retry it.
 *
 * Membership is the one org change the web app makes in Clerk rather than
 * through Maple's API, so this receiver is the only writer of `affected_user`.
 * Enabling the three `organizationMembership.*` events in the Clerk dashboard
 * is what turns it on — until then Clerk simply never delivers them.
 */
const ROUTE = "/webhooks/clerk"

const decodeOrgId = Schema.decodeUnknownEffect(OrgId)
const decodeUserId = Schema.decodeUnknownEffect(UserId)

/**
 * Brand the two Clerk IDs together so a payload with either one malformed is
 * dropped whole, rather than recording an entry against a half-known subject.
 */
const decodeMembershipIds = (data: ClerkOrganizationMembershipData) =>
	Effect.all({
		orgId: decodeOrgId(data.organization.id),
		userId: decodeUserId(data.public_user_data.user_id),
	})

export const ClerkWebhookRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const productEvents = yield* ProductEventsService
		const audit = yield* AuditLogService

		const handle = Effect.fn("ClerkWebhook.receive")(function* (
			req: HttpServerRequest.HttpServerRequest,
		) {
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
			} else if (isClerkMembershipEvent(envelope.value.type)) {
				const membership = yield* decodeClerkOrganizationMembership(envelope.value.data).pipe(
					Effect.tapError((error) =>
						Effect.logInfo("Clerk membership payload failed to decode").pipe(
							Effect.annotateLogs({ event: envelope.value.type, error: String(error) }),
						),
					),
					Effect.option,
				)
				if (Option.isSome(membership)) {
					const ids = yield* decodeMembershipIds(membership.value).pipe(Effect.option)
					if (Option.isSome(ids)) {
						// Clerk's payload names the member, never the admin who acted, so
						// attributing this to a user would be a guess. `system` says
						// truthfully that Maple learned of the change rather than made it.
						yield* audit.record({
							orgId: ids.value.orgId,
							actor: { type: "system" },
							source: "system",
							action: `member.${CLERK_MEMBERSHIP_EVENTS[envelope.value.type]}`,
							affectedUserId: ids.value.userId,
							...(membership.value.role !== undefined
								? { metadata: { role: membership.value.role } }
								: undefined),
						})
						yield* Effect.annotateCurrentSpan({ "maple.webhook.outcome": "handled" })
					} else {
						yield* Effect.annotateCurrentSpan({ "maple.webhook.outcome": "parse_rejected" })
					}
				} else {
					yield* Effect.annotateCurrentSpan({ "maple.webhook.outcome": "parse_rejected" })
				}
			} else {
				yield* Effect.annotateCurrentSpan({ "maple.webhook.outcome": "ignored" })
			}

			yield* Effect.annotateCurrentSpan({ "http.response.status_code": 200 })
			return webhookText("ok", 200)
		})

		yield* router.add("POST", ROUTE, handle)
	}),
)
