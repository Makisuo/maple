import { HttpRouter, HttpServerResponse, type HttpServerRequest } from "effect/unstable/http"
import { IntegrationsPersistenceError, OrgId } from "@maple/domain/http"
import { planetscaleConnections } from "@maple/db"
import { eq } from "drizzle-orm"
import { Clock, Effect, Option, Redacted, Schema } from "effect"
import { decryptAes256Gcm, parseBase64Aes256GcmKey } from "../lib/Crypto"
import { Database } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"
import {
	classifyPlanetScaleEvent,
	decodePlanetScaleWebhookPayload,
	upsertPlanetScaleIssue,
	verifyPlanetScaleSignature,
} from "../services/planetscale/webhook-events"

// ---------------------------------------------------------------------------
// Public PlanetScale webhook receiver. NOT behind auth — authenticity comes
// from the per-connection HMAC secret (`X-PlanetScale-Signature`, SHA-256 hex
// of the raw body), following the VCS webhook pattern. The connection id in
// the path resolves which org (and which secret) the delivery belongs to.
//
// Health events (OOM, storage thresholds, anomalies) become kind="integration"
// triage issues; lifecycle events are acknowledged and logged. Always 2xx for
// verified deliveries so PlanetScale doesn't retry-storm on downstream issues.
// ---------------------------------------------------------------------------

const ROUTE = "/api/integrations/planetscale/webhook/:connectionId"

const textResponse = (body: string, status: number) => HttpServerResponse.text(body, { status })

const decodeOrgIdSync = Schema.decodeUnknownSync(OrgId)

export const PlanetScaleWebhookRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
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
						"otel.status_code": "Ok",
						"maple.planetscale.webhook.outcome": "rejected",
						"maple.planetscale.webhook.reason": reason,
					}).pipe(Effect.as(textResponse(body, status)))

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
									message: error instanceof Error ? error.message : "Failed to load webhook connection",
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
						"otel.status_code": "Ok",
						"maple.planetscale.webhook.outcome": "handled",
					})
					return textResponse("ok", 200)
				}

				if (classified.action === "issue") {
					const now = yield* Clock.currentTimeMillis
					const timestamp =
						payload.timestamp != null && payload.timestamp > 0 ? payload.timestamp * 1000 : now
					const result = yield* upsertPlanetScaleIssue({
						orgId: decodeOrgIdSync(connection.orgId),
						payload,
						severity: classified.severity,
						title: classified.title,
						description: classified.describe(payload),
						timestamp,
					})
					yield* Effect.annotateCurrentSpan({
						"maple.planetscale.webhook.issue_action": result.action,
					})
					yield* Effect.logInfo("PlanetScale webhook event handled").pipe(
						Effect.annotateLogs({
							orgId: connection.orgId,
							event: payload.event,
							issueAction: result.action,
						}),
					)
				} else {
					yield* Effect.logInfo("PlanetScale webhook lifecycle event acknowledged").pipe(
						Effect.annotateLogs({ orgId: connection.orgId, event: payload.event }),
					)
				}

				yield* Effect.annotateCurrentSpan({
					"http.response.status_code": 202,
					"otel.status_code": "Ok",
					"maple.planetscale.webhook.outcome": "handled",
				})
				return textResponse("accepted", 202)
		})

		yield* router.add("POST", ROUTE, handle)
	}),
)
