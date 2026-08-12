#!/usr/bin/env bun
/**
 * The Todo API: an Effect HTTP server (Bun) implementing the shared `TodoApi`
 * contract, instrumented with the Maple server SDK.
 *
 * Telemetry → Maple local mode (OTLP ingest on http://127.0.0.1:4318). Start
 * the sink first with `maple start`, then `bun run server`.
 *
 * Serve strategy mirrors patterns already proven in this repo at this exact
 * Effect version: build a web handler from the `HttpApiBuilder` layer + CORS +
 * telemetry (like apps/api/src/worker.ts), then hand it to `Bun.serve`.
 */
import { BunHttpServer } from "@effect/platform-bun"
import { Maple } from "@maple-dev/effect-sdk/server"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpMiddleware, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { TodoApi } from "../shared/api.ts"
import { NotifierClient, notifierBaseUrl } from "./NotifierClient.ts"
import { TodoService } from "./TodoService.ts"

const PORT = Number(process.env.PORT ?? 4500)

// Background-exports traces + logs to Maple every couple of seconds. A no-op
// unless `endpoint` resolves, so we set it explicitly to the local-mode sink.
const telemetryLayer = Maple.layer({
	serviceName: "todo-api",
	serviceNamespace: "examples",
	environment: "development",
	endpoint: process.env.MAPLE_ENDPOINT ?? "http://127.0.0.1:4318",
	tracerExportInterval: "2 seconds",
	loggerExportInterval: "2 seconds",
	metricsExportInterval: "10 seconds",
})

// Implement the contract. Path params arrive as `params`, bodies as `payload`.
const TodosLive = HttpApiBuilder.group(TodoApi, "todos", (handlers) =>
	Effect.gen(function* () {
		const todos = yield* TodoService
		return handlers
			.handle("list", () => todos.list())
			.handle("create", ({ payload }) => todos.create(payload.title))
			.handle("toggle", ({ params }) => todos.toggle(params.id))
			.handle("remove", ({ params }) => todos.remove(params.id))
	}),
)

// Keep CORS-preflight (OPTIONS) requests out of the trace stream.
const ObservabilityLive = Layer.succeed(
	HttpMiddleware.TracerDisabledWhen,
	(request: { url: string; method: string }) => request.method === "OPTIONS",
)

const AppLive = HttpApiBuilder.layer(TodoApi).pipe(
	Layer.provide(TodosLive),
	// Omitting `allowedHeaders` makes the CORS middleware reflect whatever the
	// browser asks for — so the auto-injected `traceparent`/`b3` headers always
	// clear preflight. That cross-origin trace propagation is what stitches the
	// browser span and this server's span into ONE distributed trace.
	Layer.provideMerge(HttpRouter.cors({ allowedMethods: ["GET", "POST", "DELETE", "OPTIONS"] })),
	Layer.provideMerge(TodoService.layer),
	// The outbound hop to `todo-notifier`. `FetchHttpClient` is what wraps the
	// call in a CLIENT span and injects `traceparent`, so the notifier's spans
	// join the same trace the browser started.
	Layer.provideMerge(NotifierClient.layer),
	Layer.provideMerge(FetchHttpClient.layer),
	Layer.provideMerge(telemetryLayer),
	Layer.provideMerge(ObservabilityLive),
	// HttpApiBuilder needs HttpPlatform/Etag/FileSystem/Path; toWebHandler only
	// supplies HttpRouter. These Bun platform services cover the rest.
	Layer.provideMerge(BunHttpServer.layerHttpServices),
)

// `disableLogger: true` suppresses per-request access logs so only our
// semantic `todo.*` logs reach Maple. The handler runtime (incl. the OTLP
// export fiber) lives for the lifetime of the process.
const { handler, dispose } = HttpRouter.toWebHandler(AppLive, { disableLogger: true })

const server = Bun.serve({
	port: PORT,
	hostname: "127.0.0.1",
	fetch: (request) => handler(request),
})

console.log(`🌳  Todo API listening on http://localhost:${server.port}`)
console.log(`    telemetry → ${process.env.MAPLE_ENDPOINT ?? "http://127.0.0.1:4318"} (run \`maple start\`)`)
console.log(`    notifier  → ${notifierBaseUrl} (run \`bun run notifier\`)`)

const shutdown = () => {
	void dispose()
		.finally(() => server.stop(true))
		.finally(() => process.exit(0))
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
