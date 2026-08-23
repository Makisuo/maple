import { Clock, Effect, Option, Redacted, Result } from "effect"
import { HttpServerResponse, type HttpServerRequest } from "effect/unstable/http"
import { readSvixHeaders, verifySvixSignature } from "@/services/product-events/svix"

/**
 * Shared receive step for Svix-delivered webhooks (Clerk, Autumn). NOT behind
 * auth — authenticity is the Svix signature over the raw body. Every outcome is
 * an HTTP response: 503 while the secret is unset (so the provider retries once
 * it is configured), 401 on a bad/stale signature, 400 on an empty body, and
 * `{ _tag: "verified" }` with the raw body for the caller to decode. Span
 * attributes carry the outcome so a misconfigured secret is visible in traces.
 */

export type SvixReceiveOutcome =
	| { readonly _tag: "verified"; readonly body: string; readonly messageId: string }
	| { readonly _tag: "rejected"; readonly response: HttpServerResponse.HttpServerResponse }

const textResponse = (body: string, status: number) => HttpServerResponse.text(body, { status })

export const receiveSvixWebhook = (options: {
	readonly provider: "clerk" | "autumn"
	readonly secret: Option.Option<Redacted.Redacted<string>>
	readonly request: HttpServerRequest.HttpServerRequest
}): Effect.Effect<SvixReceiveOutcome> =>
	Effect.gen(function* () {
		const attr = (key: string) => `maple.webhook.${key}`
		yield* Effect.annotateCurrentSpan({ [attr("provider")]: options.provider })

		const reject = (status: number, reason: string, body: string) =>
			Effect.annotateCurrentSpan({
				"http.response.status_code": status,
				[attr("outcome")]: "rejected",
				[attr("reason")]: reason,
			}).pipe(Effect.as<SvixReceiveOutcome>({ _tag: "rejected", response: textResponse(body, status) }))

		if (Option.isNone(options.secret)) {
			return yield* reject(503, "secret_unset", "Webhook receiver is not configured")
		}

		const bodyOpt = yield* options.request.text.pipe(Effect.option)
		if (Option.isNone(bodyOpt) || bodyOpt.value.length === 0) {
			return yield* reject(400, "empty_body", "Missing request body")
		}

		const headers = readSvixHeaders(options.request.headers)
		const nowMs = yield* Clock.currentTimeMillis
		const verified = yield* Effect.result(
			verifySvixSignature({
				secret: Redacted.value(options.secret.value),
				headers,
				body: bodyOpt.value,
				nowMs,
			}),
		)
		if (Result.isFailure(verified)) {
			return yield* reject(401, verified.failure.reason, "Invalid signature")
		}

		yield* Effect.annotateCurrentSpan({ [attr("message_id")]: headers.id ?? "" })
		return { _tag: "verified", body: bodyOpt.value, messageId: headers.id ?? "" }
	})

export const webhookText = textResponse
