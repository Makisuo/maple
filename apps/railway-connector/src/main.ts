#!/usr/bin/env bun
/**
 * The Maple Railway connector: a small standalone service that pulls
 * customer telemetry from Railway's public GraphQL API.
 *
 * It polls the Maple API for enabled Railway targets (org-connected
 * project/environments), streams each environment's runtime logs over a
 * graphql-transport-ws subscription, polls per-service resource metrics
 * (CPU/memory/network/disk), converts both to OTLP/JSON, and pushes them
 * through the Maple ingest gateway with each org's public ingest key so the
 * data is billed and warehouse-routed like customer OTLP. Outcomes and
 * watermarks are reported back to the API. A `/health` endpoint serves the
 * Railway healthcheck.
 */
import { BunRuntime } from "@effect/platform-bun"
import { Maple } from "@maple-dev/effect-sdk/server"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ApiClient } from "./ApiClient"
import { RailwayConnectorEnv } from "./Env"
import { OtlpIngest } from "./OtlpIngest"
import { RailwayGraphql } from "./RailwayGraphql"
import { RailwayScheduler } from "./Scheduler"

const TelemetryLayer = Maple.layer({
	serviceName: "railway-connector",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/Makisuo/maple",
	shutdownTimeout: "3 seconds",
})

const MainLayer = RailwayScheduler.layer.pipe(
	Layer.provide(Layer.mergeAll(ApiClient.layer, OtlpIngest.layer, RailwayGraphql.layer)),
	Layer.provideMerge(RailwayConnectorEnv.layer),
	Layer.provide(FetchHttpClient.layer),
)

const healthServer = Effect.gen(function* () {
	const env = yield* RailwayConnectorEnv
	const scheduler = yield* RailwayScheduler

	const server = yield* Effect.acquireRelease(
		Effect.sync(() =>
			Bun.serve({
				port: env.PORT,
				hostname: "0.0.0.0",
				fetch: async (request) => {
					const url = new URL(request.url)
					if (url.pathname === "/health") {
						const stats = await Effect.runPromise(scheduler.stats)
						return new Response(JSON.stringify({ status: "ok", ...stats }), {
							headers: { "content-type": "application/json" },
						})
					}
					return new Response("maple-railway-connector", { status: 404 })
				},
			}),
		),
		(running) => Effect.promise(() => running.stop()),
	)

	yield* Effect.logInfo("Health endpoint listening").pipe(Effect.annotateLogs({ port: server.port }))
})

const program = Effect.gen(function* () {
	yield* healthServer
	const scheduler = yield* RailwayScheduler
	yield* Effect.logInfo("Maple Railway connector starting")
	return yield* scheduler.run
})

program.pipe(Effect.scoped, Effect.provide(MainLayer), Effect.provide(TelemetryLayer), BunRuntime.runMain)
