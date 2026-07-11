import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Option, Redacted, Schema } from "effect"
import { ScrapeTargetId } from "@maple/domain/http"
import { Env } from "../lib/Env"
import { ScrapeTargetsService } from "../services/ScrapeTargetsService"
import { isValidInternalBearer } from "../lib/internal-auth"

const decodeScrapeTargetIdEffect = Schema.decodeUnknownEffect(ScrapeTargetId)

const queryParamsFromRequest = (req: HttpServerRequest.HttpServerRequest) => {
	const url = new URL(req.url, "http://internal")
	return {
		targetId: url.searchParams.get("targetId"),
		// Sub-target discriminator for discovered targets (PlanetScale branches).
		sub: url.searchParams.get("sub") ?? undefined,
	}
}

const errorText = (message: string, status: number) =>
	HttpServerResponse.text(message, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8" },
	})

export const PrometheusScrapeProxyRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const service = yield* ScrapeTargetsService
		const internalToken = Option.match(env.SD_INTERNAL_TOKEN, {
			onNone: () => undefined,
			onSome: Redacted.value,
		})

		const handle = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				if (!internalToken) {
					return errorText("Prometheus scrape proxy is not configured", 401)
				}

				if (!isValidInternalBearer(req.headers.authorization, internalToken)) {
					return errorText("Unauthorized", 401)
				}

				const { targetId: rawTargetId, sub } = queryParamsFromRequest(req)
				// Annotate the existing request span (no new span — this route is on the
				// per-branch scrape hot path) so a flatlining scrape is filterable by
				// target instead of grepping lastScrapeError rows.
				yield* Effect.annotateCurrentSpan({
					"maple.scrape.target_id": rawTargetId ?? "",
					"maple.scrape.sub": sub ?? "",
				})
				if (!rawTargetId) {
					return errorText("Missing targetId", 400)
				}

				const targetId = yield* decodeScrapeTargetIdEffect(rawTargetId).pipe(Effect.option)
				if (Option.isNone(targetId)) {
					return errorText("Invalid targetId", 400)
				}

				return yield* service.scrapeForCollector(targetId.value, sub).pipe(
					Effect.tap((response) =>
						Effect.annotateCurrentSpan({ "maple.scrape.upstream_status": response.status }),
					),
					Effect.flatMap((response) =>
						Effect.succeed(
							HttpServerResponse.text(response.body, {
								status: response.status,
								headers: {
									"content-type": response.contentType,
									// Forward the upstream rate-limit hint so the scraper can
									// back off precisely on 429/503.
									...(response.retryAfterSeconds !== null
										? { "retry-after": String(response.retryAfterSeconds) }
										: {}),
								},
							}),
						),
					),
					// Map each concrete scrape error to its HTTP status: missing/disabled
					// target → 404, decryption failure → 500, persistence (our DB) → 502,
					// upstream (provider/discovery) → 502, OAuth token resolution → 502 with
					// the reason preserved in the body so a revoked grant stays diagnosable.
					Effect.catchTags({
						"@maple/http/errors/ScrapeTargetNotFoundError": (error) =>
							Effect.succeed(errorText(error.message, 404)),
						"@maple/http/errors/ScrapeTargetEncryptionError": (error) =>
							Effect.succeed(errorText(error.message, 500)),
						"@maple/http/errors/ScrapeTargetPersistenceError": (error) =>
							Effect.succeed(errorText(error.message, 502)),
						"@maple/http/errors/ScrapeTargetUpstreamError": (error) =>
							Effect.succeed(errorText(error.message, 502)),
						"@maple/http/errors/ScrapeTargetAuthError": (error) =>
							Effect.annotateCurrentSpan({ "maple.scrape.auth_failure_reason": error.reason }).pipe(
								Effect.as(errorText(`[auth:${error.reason}] ${error.message}`, 502)),
							),
					}),
				)
			})

		yield* router.add("GET", "/api/internal/prometheus-scrape", handle)
	}),
)
