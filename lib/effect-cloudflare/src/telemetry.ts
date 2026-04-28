import { Config, type Duration, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Otlp } from "effect/unstable/observability"

const readOtelConfig = Effect.gen(function* () {
	const baseUrl = yield* Config.option(Config.string("OTEL_BASE_URL"))
	const environment = yield* Config.option(Config.string("OTEL_ENVIRONMENT"))
	const ingestKey = yield* Config.option(Config.redacted("MAPLE_OTEL_INGEST_KEY"))
	const commitSha = yield* Config.option(Config.string("COMMIT_SHA"))
	const env = Option.getOrElse(environment, () => "local")
	// Any non-"local" environment with a baseUrl enables export. Setting
	// OTEL_BASE_URL without an environment name is treated as intent-to-export
	// (defaults env to "unknown"), because the URL is what actually matters.
	const enabled = Option.isSome(baseUrl) && env !== "local"
	return { enabled, baseUrl, env, ingestKey, commitSha } as const
})

// Wraps globalThis.fetch so every OTLP HTTP call is visible in CF logs. This
// makes silent failure modes (401/403/network) observable without touching
// Effect's internals.
const loggingFetch: typeof globalThis.fetch = async (input, init) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
	const started = Date.now()
	try {
		const res = await globalThis.fetch(input, init)
		const ms = Date.now() - started
		if (res.ok) {
			console.log(`[telemetry] ${init?.method ?? "GET"} ${url} → ${res.status} (${ms}ms)`)
		} else {
			const body = await res
				.clone()
				.text()
				.catch(() => "<no body>")
			console.error(
				`[telemetry] ${init?.method ?? "GET"} ${url} → ${res.status} (${ms}ms) body: ${body.slice(0, 500)}`,
			)
		}
		return res
	} catch (err) {
		const ms = Date.now() - started
		console.error(`[telemetry] ${init?.method ?? "GET"} ${url} FAILED after ${ms}ms:`, err)
		throw err
	}
}

const LoggingFetchLayer = FetchHttpClient.layer.pipe(
	Layer.provide(Layer.succeed(FetchHttpClient.Fetch, loggingFetch)),
)

export interface MakeTelemetryLayerOptions {
	/** Push the exporter's background interval out so the shutdown finalizer
	 * becomes the only flush path. Default `true` — appropriate for CF Workers
	 * where the background export-interval fiber does not progress between
	 * invocations. Set to `false` only for long-lived runtimes (Node servers,
	 * Bun processes) where the interval can actually tick. */
	readonly exportOnShutdownOnly?: boolean
	/** Upper bound on how long the shutdown finalizer (the actual OTLP POST)
	 * may take before being timed out. CF `waitUntil` allows ~30s total. */
	readonly shutdownTimeout?: Duration.Input
}

/**
 * Build the OTLP tracer/logger/metrics layer for a Cloudflare Worker.
 *
 * Requires `ConfigProvider` in scope to read `OTEL_BASE_URL`,
 * `OTEL_ENVIRONMENT`, `MAPLE_OTEL_INGEST_KEY`, and `COMMIT_SHA` from the
 * worker's env. Returns `Layer.empty` if OTEL is not configured or the
 * environment is `"local"`.
 */
export const makeTelemetryLayer = (serviceName: string, options: MakeTelemetryLayerOptions = {}) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const cfg = yield* readOtelConfig
			if (!cfg.enabled || Option.isNone(cfg.baseUrl)) return Layer.empty

			const exportOnShutdownOnly = options.exportOnShutdownOnly ?? true
			const interval: Duration.Input | undefined = exportOnShutdownOnly ? "1 hour" : undefined
			const shutdownTimeout: Duration.Input = options.shutdownTimeout ?? "15 seconds"
			return Otlp.layerJson({
				baseUrl: cfg.baseUrl.value,
				resource: {
					serviceName,
					serviceVersion: Option.getOrElse(cfg.commitSha, () => "dev"),
					attributes: { "deployment.environment": cfg.env },
				},
				headers: Option.match(cfg.ingestKey, {
					onNone: () => undefined,
					onSome: (key) => ({
						Authorization: `Bearer ${Redacted.value(key)}`,
					}),
				}),
				tracerExportInterval: interval,
				loggerExportInterval: interval,
				metricsExportInterval: interval,
				shutdownTimeout,
			}).pipe(Layer.provide(LoggingFetchLayer))
		}),
	)

// Log the detected config once per isolate so operators can verify env wiring.
let configLogged = false
export const logTelemetryConfigOnce = (env: Record<string, unknown>) => {
	if (configLogged) return
	configLogged = true
	const has = (k: string) => (env[k] != null && String(env[k]) !== "" ? "set" : "MISSING")
	console.log(
		`[telemetry] config — OTEL_BASE_URL=${has("OTEL_BASE_URL")} OTEL_ENVIRONMENT=${has("OTEL_ENVIRONMENT")} MAPLE_OTEL_INGEST_KEY=${has("MAPLE_OTEL_INGEST_KEY")} baseUrl=${env.OTEL_BASE_URL ?? "(none)"} environment=${env.OTEL_ENVIRONMENT ?? "(none)"}`,
	)
}
