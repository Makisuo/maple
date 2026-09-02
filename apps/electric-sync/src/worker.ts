/**
 * The electric-sync worker in Alchemy's Effect-native form. This module is the
 * bundle entry: its default export is the Worker construct the generated
 * runtime entry drives. The stack deploys the same `impl` through
 * `createElectricSyncWorker` in `../alchemy.run.ts`, which owns the
 * stage-derived props (constructing the minimal one below is inert — only the
 * factory's construct is ever yielded).
 */
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import * as Cloudflare from "alchemy/Cloudflare"
import { type Cause, Effect, Layer } from "effect"
import { FetchHttpClient, HttpMiddleware, HttpRouter } from "effect/unstable/http"
import * as HttpServerError from "effect/unstable/http/HttpServerError"

// Module scope stays near empty (fixed ~1s startup CPU budget); `layer` is
// stable, `flush(env)` resolves env lazily on first call.
const telemetry = MapleCloudflareSDK.make({
	serviceName: "electric-sync",
	serviceNamespace: "core",
	repositoryUrl: "https://github.com/MapleTechLabs/maple",
	anticipatedErrorIdentifiers: [...ANTICIPATED_ERROR_IDENTIFIERS],
})

// One macrotask before draining, so `HttpMiddleware.tracer`'s deferred
// `span.end` lands first — otherwise isolated requests silently drop the trace.
const flushTelemetry = async (env: Record<string, unknown>): Promise<void> => {
	await new Promise<void>((resolve) => setTimeout(resolve, 0))
	await telemetry.flush(env)
}

// The route/config graph builds `@maple/domain` Schema ASTs eagerly, so it is
// imported at layer build — init runs on the first event, off the startup
// budget. Everything here is value-shaped: the bridge's isolate build scope is
// never closed on workerd, so a scoped resource acquired at init never releases.
const AppLayer = Layer.unwrap(
	Effect.promise(async () => {
		const [{ ElectricSyncRouter }, { ElectricClient }, { TenantResolver }, { SyncConfig }] =
			await Promise.all([
				import("./routes/shape.http"),
				import("./electric/ElectricClient"),
				import("./auth/TenantResolver"),
				import("./config"),
			])
		return ElectricSyncRouter.pipe(
			Layer.provideMerge(
				HttpRouter.cors({
					allowedOrigins: ["*"],
					allowedMethods: ["GET", "OPTIONS"],
					allowedHeaders: ["*"],
					// Load-bearing, not hygiene: without these exposed headers
					// @electric-sql/client cannot advance the shape cursor through the
					// proxy, and every stream stalls after its first chunk.
					exposedHeaders: [
						"electric-handle",
						"electric-offset",
						"electric-schema",
						"electric-cursor",
						"electric-up-to-date",
					],
				}),
			),
			Layer.provideMerge(ElectricClient.layer.pipe(Layer.provide(FetchHttpClient.layer))),
			Layer.provideMerge(TenantResolver.layer),
			Layer.provideMerge(SyncConfig.layer),
			Layer.provideMerge(HttpRouter.layer),
		)
	}),
)

// Runs once per isolate (and once at plan time, where alchemy derives the shape).
export const impl = Effect.gen(function* () {
	const exec = yield* Cloudflare.WorkerExecutionContext
	const router = yield* HttpRouter.HttpRouter

	// Failures become responses BEFORE the tracer, as `toWebHandler` did: a 404
	// records an Ok span (effect's RouteNotFound is not a Maple anticipated
	// error, so letting it escape would error-mark every bot scan). 5xx
	// residuals log through the OTLP logger; expected 4xx stay quiet.
	const respond = Effect.fnUntraced(function* (cause: Cause.Cause<unknown>) {
		const [response, residual] = yield* HttpServerError.causeResponse(cause)
		if (response.status >= 500) {
			yield* Effect.logError("electric-sync handler failed", residual)
		}
		return response
	})

	const app = HttpMiddleware.tracer(router.asHttpEffect().pipe(Effect.catchCause(respond)))

	return {
		fetch: Effect.gen(function* () {
			const env = yield* Cloudflare.WorkerEnvironment
			const response = yield* app
			// Drain spans and logs after the response is on the wire.
			yield* exec.waitUntil(Effect.promise(() => flushTelemetry(env)))
			return response
		}).pipe(
			// The Tracer and Logger go on the handler: alchemy only admits Worker
			// services in a handler's requirements, and the layer is cheap.
			// oxlint-disable-next-line effecttsgo/strict-effect-provide
			Effect.provide(telemetry.layer),
		),
	}
	// This IS the worker's entry point: the bridge builds the provided layer
	// once per isolate.
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
}).pipe(Effect.provide(AppLayer))

export default Cloudflare.Worker("electric-sync", { main: import.meta.url }, impl)
