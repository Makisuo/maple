import { timingSafeEqual } from "node:crypto"
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Clock, Effect, Option, Redacted } from "effect"
import { BillingSuspensionService } from "../services/BillingSuspensionService"
import { Env } from "../lib/Env"

// ---------------------------------------------------------------------------
// Public Autumn webhook receiver (`POST /api/billing/autumn/webhook`). Autumn
// delivers via Svix; we verify the `svix-*` headers against AUTUMN_WEBHOOK_SECRET
// (Web Crypto HMAC-SHA256, mirroring the GitHub webhook verifier) and, for a
// `billing.updated` event, re-derive the customer's overdue state from Autumn
// and reconcile its `org_billing_suspensions` row. NOT behind auth — authenticity
// is the signature. See docs/* and the suspension service for the policy.
// ---------------------------------------------------------------------------

const ROUTE = "/api/billing/autumn/webhook"

const textResponse = (body: string, status: number) => HttpServerResponse.text(body, { status })

// Constant-time equality of two byte buffers via the platform primitive. The
// length check is on decoded digests (public, fixed 32-byte format) — not on any
// secret — so it leaks nothing; node's timingSafeEqual throws on unequal lengths.
const bytesEqual = (a: Buffer, b: Buffer): boolean =>
	a.length === b.length && timingSafeEqual(a, b)

// Svix rejects deliveries whose timestamp is outside a tolerance window to
// prevent replay of an intercepted (still validly-signed) webhook. 5 minutes
// matches the Svix library default.
const SVIX_TOLERANCE_SECONDS = 5 * 60

// Verify a Svix signature: first reject a timestamp outside the tolerance window
// (anti-replay), then HMAC-SHA256 over `${id}.${timestamp}.${body}` keyed by the
// base64-decoded secret (the part after the `whsec_` prefix), base64 compared
// against any `v1,<sig>` token in the space-separated header. Returns false on a
// stale/malformed timestamp or any crypto failure rather than throwing.
export const verifySvixSignature = (input: {
	readonly secret: string
	readonly svixId: string
	readonly svixTimestamp: string
	readonly body: string
	readonly signatureHeader: string
	readonly nowMs: number
	readonly toleranceSeconds?: number
}) =>
	Effect.gen(function* () {
		// Anti-replay: the timestamp is signed (tampering breaks the HMAC), so an
		// attacker can only replay the original — reject once it's outside the window.
		const timestampSeconds = Number(input.svixTimestamp)
		if (!Number.isFinite(timestampSeconds)) return false
		const toleranceMs = (input.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS) * 1000
		if (Math.abs(input.nowMs - timestampSeconds * 1000) > toleranceMs) return false

		const rawSecret = input.secret.startsWith("whsec_")
			? input.secret.slice("whsec_".length)
			: input.secret
		const keyBytes = Buffer.from(rawSecret, "base64")
		const key = yield* Effect.tryPromise({
			try: () =>
				crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
					"sign",
				]),
			catch: () => "import_failed" as const,
		}).pipe(Effect.option)
		if (Option.isNone(key)) return false

		const signedContent = `${input.svixId}.${input.svixTimestamp}.${input.body}`
		const mac = yield* Effect.tryPromise({
			try: () => crypto.subtle.sign("HMAC", key.value, new TextEncoder().encode(signedContent)),
			catch: () => "sign_failed" as const,
		}).pipe(Effect.option)
		if (Option.isNone(mac)) return false

		const expectedBytes = Buffer.from(mac.value)
		// Header: space-separated tokens like "v1,<base64sig> v1a,<base64sig>".
		// Compare the decoded 32-byte digests (not base64 strings) in constant time.
		const candidates = input.signatureHeader.split(" ").map((token) => {
			const comma = token.indexOf(",")
			return comma === -1 ? token : token.slice(comma + 1)
		})
		return candidates.some(
			(candidate) =>
				candidate.length > 0 && bytesEqual(Buffer.from(candidate, "base64"), expectedBytes),
		)
	})

// Pull the org (Autumn customer_id) out of a `billing.updated` payload. Autumn
// nests the changed entity under `data`; tolerate the common id placements so a
// minor shape change doesn't silently drop events.
export const extractCustomerId = (event: unknown): string | null => {
	if (typeof event !== "object" || event === null) return null
	const data = (event as { data?: unknown }).data
	const containers = [data, event].filter(
		(value): value is Record<string, unknown> => typeof value === "object" && value !== null,
	)
	for (const container of containers) {
		const direct = container.customer_id ?? container.customerId
		if (typeof direct === "string" && direct.length > 0) return direct
		const customer = container.customer
		if (typeof customer === "object" && customer !== null) {
			const nested = (customer as { id?: unknown }).id
			if (typeof nested === "string" && nested.length > 0) return nested
		}
	}
	return null
}

const safeJsonParse = (body: string): unknown => {
	try {
		return JSON.parse(body)
	} catch {
		return null
	}
}

export const BillingWebhookRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const service = yield* BillingSuspensionService

		yield* router.add("POST", ROUTE, (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				yield* Effect.annotateCurrentSpan({
					"http.request.method": req.method,
					"http.route": ROUTE,
				})
				const headers = req.headers as Record<string, string | undefined>

				if (Option.isNone(env.AUTUMN_WEBHOOK_SECRET)) {
					yield* Effect.logWarning(
						"[billing] webhook rejected: AUTUMN_WEBHOOK_SECRET not configured",
					)
					yield* Effect.annotateCurrentSpan({
						"http.response.status_code": 401,
						"otel.status_code": "Ok",
						"billing.webhook.outcome": "rejected",
						"billing.webhook.reason": "secret_not_configured",
					})
					return textResponse("Webhook secret not configured", 401)
				}

				const svixId = headers["svix-id"]
				const svixTimestamp = headers["svix-timestamp"]
				const svixSignature = headers["svix-signature"]
				const bodyOpt = yield* req.text.pipe(Effect.option)
				if (Option.isNone(bodyOpt) || bodyOpt.value.length === 0) {
					yield* Effect.annotateCurrentSpan({
						"http.response.status_code": 400,
						"otel.status_code": "Ok",
						"billing.webhook.outcome": "rejected",
						"billing.webhook.reason": "empty_body",
					})
					return textResponse("Missing request body", 400)
				}
				if (!svixId || !svixTimestamp || !svixSignature) {
					yield* Effect.annotateCurrentSpan({
						"http.response.status_code": 400,
						"otel.status_code": "Ok",
						"billing.webhook.outcome": "rejected",
						"billing.webhook.reason": "missing_headers",
					})
					return textResponse("Missing svix signature headers", 400)
				}

				const nowMs = yield* Clock.currentTimeMillis
				const valid = yield* verifySvixSignature({
					secret: Redacted.value(env.AUTUMN_WEBHOOK_SECRET.value),
					svixId,
					svixTimestamp,
					body: bodyOpt.value,
					signatureHeader: svixSignature,
					nowMs,
				})
				if (!valid) {
					yield* Effect.annotateCurrentSpan({
						"http.response.status_code": 401,
						"otel.status_code": "Ok",
						"billing.webhook.outcome": "rejected",
						"billing.webhook.reason": "signature_mismatch",
					})
					return textResponse("Invalid signature", 401)
				}

				const event = safeJsonParse(bodyOpt.value)
				const eventType =
					typeof event === "object" && event !== null
						? (event as { type?: unknown }).type
						: undefined
				if (eventType !== "billing.updated") {
					yield* Effect.annotateCurrentSpan({
						"http.response.status_code": 200,
						"otel.status_code": "Ok",
						"billing.webhook.outcome": "ignored",
						"billing.webhook.event_type": typeof eventType === "string" ? eventType : "unknown",
					})
					return textResponse("ignored", 200)
				}

				const orgId = extractCustomerId(event)
				if (!orgId) {
					yield* Effect.annotateCurrentSpan({
						"http.response.status_code": 200,
						"otel.status_code": "Ok",
						"billing.webhook.outcome": "ignored",
						"billing.webhook.reason": "no_customer_id",
					})
					return textResponse("ignored", 200)
				}

				// Failure here returns 500 so Svix retries — the row insert must be
				// reliable, otherwise the org would never be picked up by the cron.
				return yield* service.refreshOverdueState(orgId).pipe(
					Effect.flatMap(() =>
						Effect.annotateCurrentSpan({
							"http.response.status_code": 200,
							"otel.status_code": "Ok",
							"billing.webhook.outcome": "handled",
							"billing.org_id": orgId,
						}).pipe(Effect.as(textResponse("ok", 200))),
					),
					Effect.catch((error) =>
						Effect.annotateCurrentSpan({
							"http.response.status_code": 500,
							"otel.status_code": "Error",
							"billing.webhook.outcome": "failed",
							"billing.org_id": orgId,
						}).pipe(
							Effect.flatMap(() =>
								Effect.logError("[billing] webhook processing failed").pipe(
									Effect.annotateLogs({
										orgId,
										error: error instanceof Error ? error.message : String(error),
									}),
								),
							),
							Effect.as(textResponse("processing failed", 500)),
						),
					),
				)
			}).pipe(Effect.withSpan("BillingWebhook.receive")),
		)
	}),
)
