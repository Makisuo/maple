import { HttpRouter, HttpServerResponse, type HttpServerRequest } from "effect/unstable/http"
import { IntegrationsPersistenceError, OrgId } from "@maple/domain/http"
import { planetscaleConnections } from "@maple/db"
import { eq } from "drizzle-orm"
import { Clock, Effect, Option, Redacted, Schema } from "effect"
import { decryptAes256Gcm, parseBase64Aes256GcmKey } from "@/platform/Crypto"
import { Database } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import {
	classifyPlanetScaleEvent,
	decodePlanetScaleWebhookPayload,
	projectPlanetScaleWebhookEvent,
	planetScaleWebhookTimestampMillis,
	verifyPlanetScaleSignature,
} from "@/services/integrations/planetscale/webhook-events"
import {
	MAX_PLANETSCALE_WEBHOOK_QUEUE_BYTES,
	PlanetScaleWebhookQueue,
	planetScaleWebhookQueueJobBytes,
} from "@/services/integrations/planetscale/PlanetScaleWebhookQueue"

// Public PlanetScale webhook receiver. NOT behind auth — authenticity comes
// from the per-connection HMAC secret (`X-PlanetScale-Signature`, SHA-256 hex
// of the raw body), following the VCS webhook pattern. The connection id in
// the path resolves which org (and which secret) the delivery belongs to.
//
// Health events (OOM, storage thresholds, anomalies) become kind="integration"
// triage issues through a durable queue; lifecycle events are acknowledged and
// logged. Queue failures return 503 so PlanetScale retries the delivery.

const ROUTE = "/api/integrations/planetscale/webhook/:connectionId"

const textResponse = (body: string, status: number) => HttpServerResponse.text(body, { status })

const decodeOrgIdSync = Schema.decodeUnknownSync(OrgId)

class PlanetScaleWebhookUnavailable extends Schema.TaggedError<PlanetScaleWebhookUnavailable>()(
	"@maple/api/routes/PlanetScaleWebhookUnavailable",
	{ message: Schema.String },
) {}

export const PlanetScaleWebhookRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const webhookQueue = yield* PlanetScaleWebhookQueue
		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) => new IntegrationsPersistenceError({ message }),
		)

		const handle = Effect.fn("PlanetScaleWebhook.receive")(function* (
			req: HttpServerRequest.HttpServerRequest,
		) {
			const params = yield* HttpRouter.params
			const connectionId = params.connectionId ?? ""
			yield* Effect.annotateCurrentSpan({
				"http.request.method": req.method,
				"http.route": ROUTE,
			})

			const reject = (status: number, reason: string, body: string) =>
				Effect.annotateCurrentSpan({
					"http.response.status_code": status,
					"maple.planetscale.webhook.outcome": "rejected",
					"maple.planetscale.webhook.reason": reason,
				}).pipe(Effect.as(textResponse(body, status)))

			const unavailable = (
				reason: string,
				body: string,
			): Effect.Effect<never, PlanetScaleWebhookUnavailable> =>
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan({
						"http.response.status_code": 503,
						"error.type": "@maple/api/routes/PlanetScaleWebhookUnavailable",
						"maple.planetscale.webhook.outcome": "enqueue_failed",
						"maple.planetscale.webhook.reason": reason,
					})
					return yield* new PlanetScaleWebhookUnavailable({ message: body })
				})

			if (connectionId.length === 0) {
				return yield* reject(404, "missing_connection", "Unknown webhook endpoint")
			}

			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(planetscaleConnections)
						.where(eq(planetscaleConnections.id, connectionId))
						.limit(1),
				)
				.pipe(
					Effect.mapError(
						(error) =>
							new IntegrationsPersistenceError({
								message:
									error instanceof Error
										? error.message
										: "Failed to load webhook connection",
							}),
					),
				)
			const connection = rows[0]
			if (
				connection === undefined ||
				connection.webhookSecretCiphertext === null ||
				connection.webhookSecretIv === null ||
				connection.webhookSecretTag === null
			) {
				return yield* reject(404, "unknown_connection", "Unknown webhook endpoint")
			}
			yield* Effect.annotateCurrentSpan({ orgId: connection.orgId })

			const bodyOpt = yield* req.text.pipe(Effect.option)
			if (Option.isNone(bodyOpt) || bodyOpt.value.length === 0) {
				return yield* reject(400, "empty_body", "Missing request body")
			}
			const rawBody = bodyOpt.value

			const secret = yield* decryptAes256Gcm(
				{
					ciphertext: connection.webhookSecretCiphertext,
					iv: connection.webhookSecretIv,
					tag: connection.webhookSecretTag,
				},
				encryptionKey,
				() =>
					new IntegrationsPersistenceError({
						message: "Failed to decrypt webhook secret",
					}),
			)

			const headers = req.headers as Record<string, string | undefined>
			const signature = headers["x-planetscale-signature"]
			if (!verifyPlanetScaleSignature(rawBody, secret, signature)) {
				return yield* reject(401, "signature_rejected", "Invalid signature")
			}

			const payloadResult = yield* decodePlanetScaleWebhookPayload(rawBody).pipe(
				// Log which field failed to decode — this is a public endpoint and
				// "Unrecognized payload" alone is undebuggable.
				Effect.tapError((error) =>
					Effect.logInfo("PlanetScale webhook payload failed to decode").pipe(
						Effect.annotateLogs({ connectionId, orgId: connection.orgId, error: String(error) }),
					),
				),
				Effect.option,
			)
			if (Option.isNone(payloadResult)) {
				return yield* reject(400, "parse_rejected", "Unrecognized payload")
			}
			const payload = payloadResult.value

			const classified = classifyPlanetScaleEvent(payload.event)
			yield* Effect.annotateCurrentSpan({
				"maple.planetscale.webhook.event": payload.event,
				"maple.planetscale.webhook.database": payload.database ?? "",
				"maple.planetscale.webhook.action": classified.action,
			})

			if (classified.action === "test") {
				yield* Effect.annotateCurrentSpan({
					"http.response.status_code": 200,
					"maple.planetscale.webhook.outcome": "handled",
				})
				return textResponse("ok", 200)
			}
			if (planetScaleWebhookTimestampMillis(payload) === null)
				return yield* reject(400, "timestamp_rejected", "Webhook timestamp is required")

			// Every verified factual event is normalized and projected before the
			// durable queue boundary. The queued CloudEvent is the stable contract.
			{
				const now = yield* Clock.currentTimeMillis
				const orgId = decodeOrgIdSync(connection.orgId)
				const event = yield* Effect.try({
					try: () =>
						projectPlanetScaleWebhookEvent({
							orgId,
							connectionId,
							payload,
							receivedAt: now,
						}),
					catch: () =>
						new PlanetScaleWebhookUnavailable({
							message: "Webhook event projection unavailable",
						}),
				})
				const job = {
					kind: "planetscale-webhook" as const,
					orgId,
					connectionId,
					receivedAt: now,
					event,
				}
				if (planetScaleWebhookQueueJobBytes(job) > MAX_PLANETSCALE_WEBHOOK_QUEUE_BYTES)
					return yield* reject(
						413,
						"queue_message_too_large",
						"Webhook payload exceeds the durable queue limit",
					)
				const enqueued = yield* webhookQueue.send(job).pipe(
					Effect.tapError((error) =>
						Effect.logError("PlanetScale webhook enqueue failed").pipe(
							Effect.annotateLogs({
								orgId: connection.orgId,
								connectionId,
								event: payload.event,
								error: error.message,
							}),
						),
					),
					Effect.option,
				)
				if (Option.isNone(enqueued)) {
					return yield* unavailable("queue_unavailable", "Webhook queue unavailable")
				}
				yield* Effect.logInfo("PlanetScale webhook event enqueued").pipe(
					Effect.annotateLogs({
						orgId: connection.orgId,
						connectionId,
						event: payload.event,
					}),
				)
			}

			yield* Effect.annotateCurrentSpan({
				"http.response.status_code": 202,
				"maple.planetscale.webhook.outcome": "handled",
			})
			return textResponse("accepted", 202)
		})

		yield* router.add("POST", ROUTE, (req) =>
			handle(req).pipe(
				Effect.catchTags({
					"@maple/api/routes/PlanetScaleWebhookUnavailable": ({ message }) =>
						Effect.succeed(textResponse(message, 503)),
					"@maple/http/errors/IntegrationsPersistenceError": (error) =>
						Effect.logError("PlanetScale webhook persistence failed").pipe(
							Effect.annotateLogs({ message: error.message }),
							Effect.as(textResponse("Webhook service unavailable", 503)),
						),
				}),
			),
		)
	}),
)
