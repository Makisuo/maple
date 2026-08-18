#!/usr/bin/env bun
/**
 * The Notifier service: the third node in the demo topology, called by
 * `todo-api` over HTTP whenever a todo changes.
 *
 * It exists to make traces interesting — the inbound request continues the
 * trace the browser started (Effect's HTTP client/server propagate
 * `traceparent` automatically), and inside it the dispatcher adds cache spans,
 * a simulated outbound webhook span, a slow tail, and its own error class.
 *
 * Telemetry → Maple local mode (OTLP ingest on http://127.0.0.1:4318).
 */
import { BunHttpServer } from "@effect/platform-bun"
import { Maple } from "@maple-dev/effect-sdk/server"
import { Effect, Layer } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { NotifierApi } from "../shared/notifier-api.ts"
import { NotificationService } from "./NotificationService.ts"

const PORT = Number(process.env.NOTIFIER_PORT ?? 4502)
const MAPLE_ENDPOINT = process.env.MAPLE_ENDPOINT ?? "http://127.0.0.1:4318"

const telemetryLayer = Maple.layer({
	serviceName: "todo-notifier",
	serviceNamespace: "examples",
	environment: "development",
	endpoint: MAPLE_ENDPOINT,
	tracerExportInterval: "2 seconds",
	loggerExportInterval: "2 seconds",
	metricsExportInterval: "10 seconds",
})

const NotificationsLive = HttpApiBuilder.group(NotifierApi, "notifications", (handlers) =>
	Effect.gen(function* () {
		const notifications = yield* NotificationService
		return handlers.handle("dispatch", ({ payload }) => notifications.dispatch(payload))
	}),
)

// Service-to-service only — no browser talks to this one, so no CORS needed.
const ObservabilityLive = Layer.succeed(
	HttpMiddleware.TracerDisabledWhen,
	(request: { url: string; method: string }) => request.method === "OPTIONS",
)

const AppLive = HttpApiBuilder.layer(NotifierApi).pipe(
	Layer.provide(NotificationsLive),
	Layer.provideMerge(NotificationService.layer),
	Layer.provideMerge(telemetryLayer),
	Layer.provideMerge(ObservabilityLive),
	Layer.provideMerge(BunHttpServer.layerHttpServices),
)

const { handler, dispose } = HttpRouter.toWebHandler(AppLive, { disableLogger: true })

const server = Bun.serve({
	port: PORT,
	hostname: "127.0.0.1",
	fetch: (request) => handler(request),
})

console.log(`📣  Todo Notifier listening on http://localhost:${server.port}`)
console.log(`    telemetry → ${MAPLE_ENDPOINT} (run \`maple start\`)`)

const shutdown = () => {
	void dispose()
		.finally(() => server.stop(true))
		.finally(() => process.exit(0))
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
