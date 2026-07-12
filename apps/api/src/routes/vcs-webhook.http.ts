import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Data, Effect, Option } from "effect"
import type { VcsProviderClient } from "../services/vcs/VcsProviderClient"
import { VcsProviderRegistry } from "../services/vcs/VcsProviderRegistry"
import { VcsSyncQueue } from "../services/vcs/VcsSyncQueue"

/**
 * In-memory sentinel: lets the span exit Error while the HTTP layer returns a
 * 500. Failed immediately after the span annotation, then caught outside the
 * span (never serialized).
 */
class EnqueueFailure extends Data.TaggedError("EnqueueFailure")<{
	readonly message: string
}> {}

// ---------------------------------------------------------------------------
// Public webhook receiver, one static route per registered provider
// (`/api/integrations/<provider>/webhook`). Generic pipeline: the provider
// verifies the signature + maps the event to jobs; this router just enqueues
// and returns 202. NOT behind auth — authenticity comes from the provider's
// signature check.
// ---------------------------------------------------------------------------

const textResponse = (body: string, status: number) => HttpServerResponse.text(body, { status })

export const VcsWebhookRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const registry = yield* VcsProviderRegistry
		const queue = yield* VcsSyncQueue

		const makeHandler =
			(provider: VcsProviderClient, route: string) => (req: HttpServerRequest.HttpServerRequest) => {
				return Effect.gen(function* () {
					const deliveryId = (req.headers as Record<string, string | undefined>)[
						"x-github-delivery"
					]
					yield* Effect.annotateCurrentSpan({
						"http.request.method": req.method,
						"http.route": route,
						...(deliveryId ? { "vcs.webhook.delivery_id": deliveryId } : {}),
					})

					const bodyOpt = yield* req.text.pipe(Effect.option)
					if (Option.isNone(bodyOpt) || bodyOpt.value.length === 0) {
						yield* Effect.annotateCurrentSpan({
							"http.response.status_code": 400,
							"otel.status_code": "Ok",
							"vcs.webhook.outcome": "rejected",
							"vcs.webhook.reason": "empty_body",
						})
						yield* Effect.logInfo("[VCS] webhook rejected: empty request body")
						return textResponse("Missing request body", 400)
					}
					const headers = req.headers as Record<string, string | undefined>

					return yield* provider.webhookToJobs({ headers, rawBody: bodyOpt.value }).pipe(
						Effect.flatMap((jobs) =>
							queue.sendBatch(jobs).pipe(
								Effect.flatMap(() =>
									Effect.annotateCurrentSpan({
										"http.response.status_code": 202,
										"otel.status_code": "Ok",
										"vcs.webhook.outcome": "handled",
										"vcs.webhook.jobs_enqueued": jobs.length,
									}),
								),
								Effect.as(textResponse("accepted", 202)),
							),
						),
						Effect.catchTags({
							"@maple/http/errors/VcsWebhookSignatureError": (error) =>
								Effect.annotateCurrentSpan({
									"http.response.status_code": 401,
									"otel.status_code": "Ok",
									"error.type": error._tag,
									"vcs.webhook.outcome": "rejected",
									"vcs.webhook.reason": "signature_rejected",
								}).pipe(Effect.as(textResponse(error.message, 401))),
							"@maple/http/errors/VcsWebhookParseError": (error) =>
								Effect.annotateCurrentSpan({
									"http.response.status_code": 400,
									"otel.status_code": "Ok",
									"error.type": error._tag,
									"vcs.webhook.outcome": "rejected",
									"vcs.webhook.reason": "parse_rejected",
								}).pipe(Effect.as(textResponse(error.message, 400))),
							// Annotate + fail so the span exits Error; caught below for the 500 body.
							"@maple/http/errors/VcsQueueError": (error) =>
								Effect.annotateCurrentSpan({
									"http.response.status_code": 500,
									"otel.status_code": "Error",
									"error.type": error._tag,
									"vcs.webhook.outcome": "failed",
									"vcs.webhook.reason": "enqueue_failed",
								}).pipe(
									Effect.flatMap(() =>
										Effect.logError("[VCS] failed to enqueue webhook jobs").pipe(
											Effect.annotateLogs({ error: error.message }),
										),
									),
									Effect.flatMap(() =>
								Effect.fail(new EnqueueFailure({ message: error.message })),
							),
								),
						}),
					)
				}).pipe(
					Effect.withSpan("VcsWebhook.receive", {
						attributes: { "vcs.provider": provider.id },
					}),
					// Catch OUTSIDE the span so the span exits Error but HTTP gets a 500.
					Effect.catchTag("EnqueueFailure", () =>
						Effect.succeed(textResponse("enqueue failed", 500)),
					),
				)
			}

			yield* Effect.forEach(
				registry.ids,
				(id) =>
					registry.resolve(id).pipe(
						Effect.flatMap((provider) =>
						router.add(
							"POST",
							`/api/integrations/${id}/webhook`,
							makeHandler(provider, `/api/integrations/${id}/webhook`),
						),
					),
				),
			{ discard: true },
		)
	}),
)
