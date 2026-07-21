import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import { WorkerConfigProviderLayer } from "@maple/effect-cloudflare"
import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

const WorkerFileSystemLive = FileSystem.layerNoop({})

const WorkerHttpPlatformLive = Layer.effect(
	HttpPlatform.HttpPlatform,
	HttpPlatform.make({
		fileResponse: (_path, status, statusText, headers) =>
			HttpServerResponse.text("File responses are unavailable in the worker runtime", {
				status,
				statusText,
				headers,
			}),
		fileWebResponse: (_file, status, statusText, headers) =>
			HttpServerResponse.text("File responses are unavailable in the worker runtime", {
				status,
				statusText,
				headers,
			}),
	}),
).pipe(Layer.provideMerge(WorkerFileSystemLive), Layer.provideMerge(Etag.layer))

const WorkerPlatformLive = Layer.mergeAll(
	Path.layer,
	Etag.layer,
	WorkerFileSystemLive,
	WorkerHttpPlatformLive,
)

// Construct telemetry once at module scope — `layer` is stable, `flush(env)`
// resolves env lazily on first call. Including `telemetry.layer` in the handler's
// layer composition is the critical bit: the Tracer reference must live in the
// same runtime as the route that emits spans.
const telemetry = MapleCloudflareSDK.make({
	serviceName: "electric-sync",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/Makisuo/maple",
	anticipatedErrorIdentifiers: [...ANTICIPATED_ERROR_IDENTIFIERS],
})

// `HttpMiddleware.tracer` ends the root server span on a deferred macrotask, but
// `telemetry.flush` drains synchronously. Yield one macrotask first so `span.end`
// runs before we drain, otherwise isolated requests silently drop the trace.
const flushTelemetry = async (env: Record<string, unknown>): Promise<void> => {
	await new Promise<void>((resolve) => setTimeout(resolve, 0))
	await telemetry.flush(env)
}

// Providing ANY middleware — even a pass-through — avoids the `toWebHandler`
// scope-propagation hang seen on Cloudflare Workers. Paired with
// `disableLogger: true` so Effect's default logger does not double-log;
// application logs flow through the OTLP logger installed by `telemetry.layer`.
const passThroughMiddleware: HttpMiddleware.HttpMiddleware = (httpApp) => httpApp

// The route + config are imported DYNAMICALLY, not at module scope: the graph
// reachable from `./routes/shape.http` eagerly builds `@maple/domain` Effect
// Schema ASTs (via the shared auth helper) at module-evaluation time, and
// Cloudflare runs only top-level module scope during upload validation (fixed
// ~1s startup CPU budget). Deferring behind `import()` keeps the top level near
// empty; the cost moves to the first request's far larger CPU budget.
const buildHandler = async () => {
	const { ElectricSyncRouter } = await import("./routes/shape.http")
	const { SyncConfig } = await import("./config")
	return HttpRouter.toWebHandler(
		ElectricSyncRouter.pipe(
			Layer.provideMerge(
				HttpRouter.cors({
					allowedOrigins: ["*"],
					allowedMethods: ["GET", "OPTIONS"],
					allowedHeaders: ["*"],
					// electric-* headers must be readable cross-origin so
					// @electric-sql/client can advance the shape cursor
					// (handle/offset/up-to-date) through the proxy.
					exposedHeaders: [
						"electric-handle",
						"electric-offset",
						"electric-schema",
						"electric-cursor",
						"electric-up-to-date",
					],
				}),
			),
			Layer.provideMerge(SyncConfig.layer),
			Layer.provideMerge(WorkerPlatformLive),
			Layer.provideMerge(telemetry.layer),
			Layer.provideMerge(WorkerConfigProviderLayer),
		),
		{ middleware: passThroughMiddleware, disableLogger: true },
	)
}

// Single isolate-wide handler — `toWebHandler` builds its own ManagedRuntime
// lazily and keeps it for the isolate's lifetime. Memoized via the build promise
// so concurrent first requests share one build.
let handlerPromise: ReturnType<typeof buildHandler> | undefined
const getHandler = () => (handlerPromise ??= buildHandler())

const handle = async (
	request: Request,
	env: Record<string, unknown>,
	ctx: ExecutionContext,
): Promise<Response> => {
	const { handler } = await getHandler()
	try {
		const response = await handler(request, Context.empty() as never)
		ctx.waitUntil(flushTelemetry(env))
		return response
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		// Route the fatal-handler error through the OTLP logger installed by
		// `telemetry.layer` (drained by `flushTelemetry` below) rather than a raw
		// `console.error` the exporter can't see. This runs outside the handler's
		// runtime (the `toWebHandler` promise already rejected), so provide the
		// telemetry layer to a one-shot fiber; its log record lands in the same
		// in-isolate buffer the flush drains.
		Effect.runFork(
			Effect.logError("electric-sync handler failed").pipe(
				Effect.annotateLogs({ error: message }),
				Effect.provide(telemetry.layer),
			),
		)
		ctx.waitUntil(flushTelemetry(env))
		return new Response(`worker handler error: ${message}`, { status: 504 })
	}
}

export default {
	fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) =>
		handle(request, env, ctx),
}
