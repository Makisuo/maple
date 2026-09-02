#!/usr/bin/env bun
/**
 * The Maple Prometheus scraper: a small standalone cron server that replaces
 * the prometheus receiver of the removed OTel collector.
 *
 * It polls the Maple API for enabled scrape targets (each carrying the URL to
 * fetch and its already-decrypted auth headers), runs one scrape loop per
 * target at its configured interval (5–300s), fetches exposition text
 * directly with SSRF protection, converts it to OTLP for the ingest gateway,
 * and reports scrape outcomes back to the API. A `/health` endpoint serves
 * the container healthcheck.
 */
import { BunRuntime } from "@effect/platform-bun"
import { Maple } from "@maple-dev/effect-sdk/server"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ApiClient } from "./ApiClient"
import { OtlpIngest } from "./OtlpIngest"
import { ScraperEnv } from "./Env"
import { ScrapeScheduler } from "./ScrapeScheduler"
import { TargetFetcher } from "./TargetFetcher"

const TelemetryLayer = Maple.layer({
	serviceName: "scraper",
	serviceNamespace: "core",
	repositoryUrl: "https://github.com/MapleTechLabs/maple",
	shutdownTimeout: "3 seconds",
})

const MainLayer = ScrapeScheduler.layer.pipe(
	Layer.provide(Layer.mergeAll(ApiClient.layer, OtlpIngest.layer, TargetFetcher.layer)),
	Layer.provideMerge(ScraperEnv.layer),
	Layer.provide(FetchHttpClient.layer),
)

const healthServer = Effect.gen(function* () {
	const env = yield* ScraperEnv
	const scheduler = yield* ScrapeScheduler
	const runPromise = Effect.runPromiseWith(yield* Effect.context())

	const server = yield* Effect.acquireRelease(
		Effect.sync(() =>
			Bun.serve({
				port: env.PORT,
				hostname: "0.0.0.0",
				fetch: async (request) => {
					const url = new URL(request.url)
					if (url.pathname === "/health") {
						const stats = await runPromise(scheduler.stats)
						return new Response(JSON.stringify({ status: "ok", ...stats }), {
							headers: { "content-type": "application/json" },
						})
					}
					return new Response("maple-scraper", { status: 404 })
				},
			}),
		),
		(running) => Effect.promise(() => running.stop()),
	)

	yield* Effect.logInfo("Health endpoint listening").pipe(Effect.annotateLogs({ port: server.port }))
})

const program = Effect.gen(function* () {
	yield* healthServer
	const scheduler = yield* ScrapeScheduler
	yield* Effect.logInfo("Maple Prometheus scraper starting")
	return yield* scheduler.run
})

// Telemetry intentionally owns the outer scope so its exporter flushes after MainLayer closes.
/* oxlint-disable effecttsgo/multiple-effect-provide */
/* oxlint-disable effecttsgo/strict-effect-provide */
program.pipe(Effect.scoped, Effect.provide(MainLayer), Effect.provide(TelemetryLayer), BunRuntime.runMain)
/* oxlint-enable effecttsgo/strict-effect-provide */
/* oxlint-enable effecttsgo/multiple-effect-provide */
