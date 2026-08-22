import { Effect, Option } from "effect"
import { HttpRouter, type HttpServerRequest } from "effect/unstable/http"
import { Env } from "@/platform/Env"
import {
	decodeClerkEnvelope,
	decodeClerkUserCreated,
	signupCompletedEvent,
} from "@/services/product-events/clerk-events"
import { ProductEventsService } from "@/services/product-events/ProductEventsService"
import { receiveSvixWebhook, webhookText } from "./svix-receiver"

/**
 * Clerk webhook receiver: `user.created` → `signup_completed` product event.
 * Public route; authenticity is the Svix signature (`CLERK_WEBHOOK_SECRET`).
 * Any other event type is acknowledged with 200 so Clerk does not retry it.
 */
const ROUTE = "/webhooks/clerk"

export const ClerkWebhookRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const productEvents = yield* ProductEventsService

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
			} else {
				yield* Effect.annotateCurrentSpan({ "maple.webhook.outcome": "ignored" })
			}

			yield* Effect.annotateCurrentSpan({ "http.response.status_code": 200 })
			return webhookText("ok", 200)
		})

		yield* router.add("POST", ROUTE, handle)
	}),
)
