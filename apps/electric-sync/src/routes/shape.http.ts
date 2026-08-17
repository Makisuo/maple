import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { TenantResolver } from "../auth/TenantResolver"
import { ElectricClient } from "../electric/ElectricClient"
import { errorResponse, type SyncError, Unauthorized } from "../errors"
import { decodeSyncRequest } from "../shapes/request"
import { syncResponseHeaders } from "./headers"

/**
 * ElectricSQL shape proxy — the standalone `apps/electric-sync` worker.
 *
 * Electric serves per-table "shapes" over HTTP but has no auth of its own — the
 * documented pattern is to proxy shape requests through your own service, which
 * pins the shape definition (table, WHERE, columns) server-side so a client can
 * only sub-filter within it. This route is that proxy. It is deliberately thin:
 * the whitelist lives in `shapes/registry`, validation in `shapes/request`, the
 * upstream (URL, credentials, timeout, 5xx policy) in `electric/ElectricClient`,
 * auth in `auth/TenantResolver`, and the failure → HTTP mapping in `errors`. What
 * is left here is the order those happen in, which is the only part that is
 * genuinely about being an HTTP route.
 *
 * The client sends `?shape=<name>` (a Maple param, plus `?scope=` for the scoped
 * shapes) alongside Electric's own offset/handle/live/cursor; it never sees or
 * sets the table, WHERE, or columns.
 */

/** The base is synthetic: `req.url` is origin-relative and only its query matters here. */
const INTERNAL_URL_BASE = "http://internal"

/** Records the outcome on the `electric_sync.shape` span. Must run inside it. */
const annotate = (error: SyncError) => {
	const { status, errorType } = errorResponse(error)
	return Effect.annotateCurrentSpan({
		"http.response.status_code": status,
		"error.type": errorType,
	})
}

const respond = (error: SyncError) => {
	const { status, body, headers } = errorResponse(error)
	return HttpServerResponse.raw(body, { status, headers })
}

/** Annotate and answer, without failing the span — see the 4xx note below. */
const rejectClient = (error: SyncError) => annotate(error).pipe(Effect.as(respond(error)))

export const ElectricSyncRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const electric = yield* ElectricClient
		const tenants = yield* TenantResolver

		const handle = Effect.fnUntraced(function* (req: HttpServerRequest.HttpServerRequest) {
			const clientParams = new URL(req.url, INTERNAL_URL_BASE).searchParams

			const request = yield* Effect.fromResult(decodeSyncRequest(clientParams))
			yield* Effect.annotateCurrentSpan("maple.sync.shape", request.shape)

			// The configuration gate sits ahead of auth on purpose: a deploy with no
			// Electric (self-hosted without the container, or a half-configured Cloud
			// deploy) answers 503 to everyone, and the web app's collections watch for
			// exactly that to degrade to their existing effect-atom fetches. Making it
			// conditional on a valid bearer would leave an unauthenticated client
			// unable to tell "sync is off" from "your session expired".
			yield* electric.ensureConfigured

			const tenant = yield* tenants
				.resolve(req.headers)
				.pipe(Effect.mapError((error) => new Unauthorized({ message: error.message })))
			yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)

			const upstream = yield* electric.fetchShape(request, tenant.orgId)

			// Cache-isolate the org-scoped body (Vary: Authorization + no public
			// caching) and drop headers that misdescribe the re-serialized body.
			return HttpServerResponse.raw(upstream.body, {
				status: upstream.status,
				headers: syncResponseHeaders(upstream.headers),
			})
		})

		yield* router.add("GET", "/api/sync/shape", (req) =>
			handle(req).pipe(
				// Every failure is annotated on the span and shaped by the same mapper;
				// they differ only in whether the span itself fails. Per OTEL HTTP
				// semconv for SERVER spans (and the rule `apps/ingest` already follows),
				// a 4xx is a rejection the service handled correctly, so it is caught
				// INSIDE the span and leaves it `Ok` — otherwise routine unknown-shape
				// and expired-session requests would flood the error dashboards.
				Effect.catchTags({
					"@maple/electric-sync/ShapeRequestInvalid": rejectClient,
					"@maple/electric-sync/Unauthorized": rejectClient,
				}),
				// The rest are real failures. Annotate while the span is still current,
				// then let them through it so it carries `Error` + the error's message,
				// and only turn them into a response outside.
				Effect.tapError(annotate),
				Effect.withSpan("electric_sync.shape"),
				Effect.catchTags({
					"@maple/electric-sync/ElectricNotConfigured": (error) => Effect.succeed(respond(error)),
					"@maple/electric-sync/ElectricUpstreamUnreachable": (error) =>
						Effect.succeed(respond(error)),
					"@maple/electric-sync/ElectricUpstreamError": (error) => Effect.succeed(respond(error)),
				}),
			),
		)
	}),
)
