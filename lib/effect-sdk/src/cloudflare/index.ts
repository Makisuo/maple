// ---------------------------------------------------------------------------
// Cloudflare Workers preset
//
// Replaces upstream `effect/unstable/observability/Otlp.layerJson()` with a
// fork that has no scheduled background fiber. Returns `{ layer, flush }`:
//   - `layer` installs the custom OTLP tracer + Effect logger into the runtime
//   - `flush` is an Effect the worker runs inside `ctx.waitUntil` after
//     responding, draining the in-isolate buffers to the OTLP collector.
//
// Wire it via `withRequestRuntime` / `runScheduledEffect` from
// `@maple/effect-cloudflare` — they accept a `flushables` option that schedules
// the flush automatically.
// ---------------------------------------------------------------------------

import { Effect, Layer, Redacted } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { resolveResourceFromEnv } from "../server/resource.js"
import {
	type FlushableLogger,
	makeFlushableLogger,
	noopLogger,
} from "./flushable-logger.js"
import {
	type FlushableTracer,
	makeFlushableTracer,
	noopTracer,
} from "./flushable-tracer.js"

export interface CloudflareConfig {
	/**
	 * Service name reported in traces and logs. When omitted, falls back to
	 * `env.OTEL_SERVICE_NAME`, then `"unknown"`.
	 */
	readonly serviceName?: string | undefined
	readonly serviceVersion?: string | undefined
	readonly environment?: string | undefined
	/**
	 * Ingest endpoint URL (base, no path). When omitted, falls back to
	 * `env.MAPLE_ENDPOINT` then `env.OTEL_EXPORTER_OTLP_ENDPOINT`.
	 */
	readonly endpoint?: string | undefined
	/** Maple ingest key. Overrides `env.MAPLE_INGEST_KEY`. */
	readonly ingestKey?: string | undefined
	readonly attributes?: Record<string, unknown> | undefined
	/** Skip Effect log spans in OTLP log attributes. Defaults to `false`. */
	readonly excludeLogSpans?: boolean | undefined
	/** Override the OTLP traces path (relative to `endpoint`). Default `/v1/traces`. */
	readonly tracesPath?: string | undefined
	/** Override the OTLP logs path (relative to `endpoint`). Default `/v1/logs`. */
	readonly logsPath?: string | undefined
}

export interface CloudflareTelemetry {
	readonly layer: Layer.Layer<never>
	readonly flush: Effect.Effect<void, never, HttpClient.HttpClient>
}

const NOOP_TELEMETRY: CloudflareTelemetry = {
	layer: Layer.mergeAll(noopTracer.layer, noopLogger.layer),
	flush: Effect.void,
}

/**
 * Build a Cloudflare-Workers-tuned telemetry bundle (custom OTLP tracer +
 * Effect logger). Returns `{ layer, flush }`. Plug `layer` into your request
 * runtime and `flush` into `ctx.waitUntil` (via `flushables` on
 * `withRequestRuntime` / `runScheduledEffect`).
 *
 * `env` is the worker's `env` binding — read directly so this can run at
 * module / first-request scope without needing an Effect ConfigProvider.
 *
 * @example
 * ```ts
 * import * as Cloudflare from "@maple-dev/effect-sdk/cloudflare"
 * import { withRequestRuntime } from "@maple/effect-cloudflare"
 *
 * let telemetry: Cloudflare.CloudflareTelemetry | undefined
 * const getTelemetry = (env: Record<string, unknown>) =>
 *   (telemetry ??= Cloudflare.make(env, { serviceName: "my-worker" }))
 *
 * export default {
 *   fetch: withRequestRuntime(
 *     (env) => SomeAppLayer.pipe(Layer.provideMerge(getTelemetry(env).layer)),
 *     async (req, services, env) => { ... },
 *     { flushables: (env) => [getTelemetry(env)] },
 *   ),
 * }
 * ```
 */
export const make = (
	env: Record<string, unknown>,
	config: CloudflareConfig = {},
): CloudflareTelemetry => {
	const resolved = resolveResourceFromEnv(env, { ...config, sdkType: "cloudflare" })
	if (!resolved.endpoint) return NOOP_TELEMETRY

	const baseUrl = resolved.endpoint.endsWith("/")
		? resolved.endpoint.slice(0, -1)
		: resolved.endpoint
	const tracesPath = config.tracesPath ?? "/v1/traces"
	const logsPath = config.logsPath ?? "/v1/logs"

	const headers: Record<string, string> | undefined = resolved.ingestKey
		? { Authorization: `Bearer ${Redacted.value(resolved.ingestKey)}` }
		: undefined

	const tracer: FlushableTracer = makeFlushableTracer({
		url: `${baseUrl}${tracesPath}`,
		resource: resolved.resource,
		headers,
	})

	const logger: FlushableLogger = makeFlushableLogger({
		url: `${baseUrl}${logsPath}`,
		resource: resolved.resource,
		headers,
		excludeLogSpans: config.excludeLogSpans,
	})

	return {
		layer: Layer.mergeAll(tracer.layer, logger.layer),
		flush: Effect.all([tracer.flush, logger.flush], { concurrency: "unbounded", discard: true }),
	}
}

/**
 * @deprecated Replaced by `make(env, config)`. Calling this throws so missed
 * callsites surface loudly during the rollout. Switch to:
 *
 *   const telemetry = Cloudflare.make(env, { serviceName: "..." })
 *   // pass telemetry.layer to your runtime
 *   // pass [telemetry] as `flushables` to withRequestRuntime
 */
export const layer = (_config: CloudflareConfig = {}): never => {
	throw new Error(
		"@maple-dev/effect-sdk/cloudflare: `layer()` was replaced by `make(env, config)`. " +
			"See the JSDoc on `make` for the new wiring.",
	)
}
