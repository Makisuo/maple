import { Effect, Option } from "effect"
import { HttpRouter, type HttpServerRequest } from "effect/unstable/http"
import { Env } from "@/platform/Env"
import {
	AUTUMN_BILLING_UPDATED,
	decodeAutumnBillingUpdated,
	decodeAutumnEnvelope,
	planEventsFromBillingUpdated,
} from "@/services/product-events/autumn-events"
import { ProductEventsService } from "@/services/product-events/ProductEventsService"
import { receiveSvixWebhook, webhookText } from "./svix-receiver"

/**
 * Autumn webhook receiver: `billing.updated` → `plan_started` / `plan_changed`
 * / `plan_cancelled` product events, `group_id` = the Autumn customer id, which
 * is the Maple org id. Public route; authenticity is the Svix signature
 * (`AUTUMN_WEBHOOK_SECRET`). Other event types are acknowledged with 200.
 */
const ROUTE = "/webhooks/autumn"

export const AutumnWebhookRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const productEvents = yield* ProductEventsService

		const handle = Effect.fn("AutumnWebhook.receive")(function* (
			req: HttpServerRequest.HttpServerRequest,
		) {
			yield* Effect.annotateCurrentSpan({ "http.request.method": req.method, "http.route": ROUTE })

			const received = yield* receiveSvixWebhook({
				provider: "autumn",
				secret: env.AUTUMN_WEBHOOK_SECRET,
				request: req,
			})
			if (received._tag === "rejected") return received.response

			const envelope = yield* decodeAutumnEnvelope(received.body).pipe(Effect.option)
			if (Option.isNone(envelope)) {
				yield* Effect.annotateCurrentSpan({
					"http.response.status_code": 400,
					"maple.webhook.outcome": "rejected",
					"maple.webhook.reason": "parse_rejected",
				})
				return webhookText("Unrecognized payload", 400)
			}
			yield* Effect.annotateCurrentSpan({ "maple.webhook.event": envelope.value.type })

			if (envelope.value.type === AUTUMN_BILLING_UPDATED) {
				const data = yield* decodeAutumnBillingUpdated(envelope.value.data).pipe(
					Effect.tapError((error) =>
						Effect.logInfo("Autumn billing.updated payload failed to decode").pipe(
							Effect.annotateLogs({ error: String(error) }),
						),
					),
					Effect.option,
				)
				if (Option.isSome(data)) {
					const events = planEventsFromBillingUpdated(data.value, {
						id: envelope.value.id ?? received.messageId,
						occurred_at: envelope.value.occurred_at,
					})
					yield* Effect.annotateCurrentSpan({
						orgId: data.value.customer_id,
						"maple.webhook.outcome": "handled",
						"maple.webhook.emitted": events.length,
					})
					yield* Effect.forEach(events, (event) => productEvents.track(event), { discard: true })
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
