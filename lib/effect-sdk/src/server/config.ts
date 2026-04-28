import { Config, Effect, Option } from "effect"

/**
 * Resolve the ingest endpoint.
 *
 * Priority: MAPLE_ENDPOINT > OTEL_EXPORTER_OTLP_ENDPOINT.
 *
 * The OTel-standard env var is included as a fallback so the maple-k8s-infra
 * chart's auto-instrumentation (which sets OTEL_EXPORTER_OTLP_ENDPOINT to the
 * in-cluster agent) configures Maple's SDK with no extra app-side wiring. The
 * Maple-specific name still wins when set, to preserve existing setups.
 */
export const endpoint = Effect.gen(function* () {
	const maple = yield* Config.option(Config.string("MAPLE_ENDPOINT"))
	if (Option.isSome(maple)) return maple
	return yield* Config.option(Config.string("OTEL_EXPORTER_OTLP_ENDPOINT"))
})

/** Resolve the Maple ingest key from environment. */
export const ingestKey = Config.option(Config.redacted("MAPLE_INGEST_KEY"))

/**
 * Resolve service version / commit SHA from platform-specific env vars.
 *
 * Priority: COMMIT_SHA > RAILWAY_GIT_COMMIT_SHA > VERCEL_GIT_COMMIT_SHA
 *         > CF_PAGES_COMMIT_SHA > RENDER_GIT_COMMIT
 */
export const serviceVersion = Config.option(
	Config.string("COMMIT_SHA").pipe(
		Config.orElse(() => Config.string("RAILWAY_GIT_COMMIT_SHA")),
		Config.orElse(() => Config.string("VERCEL_GIT_COMMIT_SHA")),
		Config.orElse(() => Config.string("CF_PAGES_COMMIT_SHA")),
		Config.orElse(() => Config.string("RENDER_GIT_COMMIT")),
	),
)

/**
 * Resolve deployment environment from platform-specific env vars.
 *
 * Priority: MAPLE_ENVIRONMENT > RAILWAY_ENVIRONMENT > VERCEL_ENV > NODE_ENV
 */
export const environment = Config.option(
	Config.string("MAPLE_ENVIRONMENT").pipe(
		Config.orElse(() => Config.string("RAILWAY_ENVIRONMENT")),
		Config.orElse(() => Config.string("VERCEL_ENV")),
		Config.orElse(() => Config.string("NODE_ENV")),
	),
)

/** OTel-standard service name override. */
export const otelServiceName = Config.option(Config.string("OTEL_SERVICE_NAME"))

/**
 * Parse the OTel-standard `OTEL_RESOURCE_ATTRIBUTES` env var.
 *
 * Format per the OTel spec: comma-separated `key=value` pairs, values may be
 * URL-encoded. Used by the maple-k8s-infra chart to inject k8s.pod.ip /
 * k8s.pod.uid / k8s.namespace.name etc. via the downward API. We parse
 * defensively — malformed pairs are skipped, unparseable URL-encoded values
 * fall back to the raw string.
 */
export const parseOtelResourceAttributes = (input: string): Record<string, string> => {
	const result: Record<string, string> = {}
	for (const pair of input.split(",")) {
		const eq = pair.indexOf("=")
		if (eq === -1) continue
		const key = pair.slice(0, eq).trim()
		if (!key) continue
		const raw = pair.slice(eq + 1).trim()
		let value = raw
		try {
			value = decodeURIComponent(raw)
		} catch {
			// Spec allows URL-encoded values but doesn't require them; fall back to
			// the raw string when decoding fails (e.g. literal `%` in the value).
		}
		result[key] = value
	}
	return result
}

/** Resolve and parse `OTEL_RESOURCE_ATTRIBUTES`. */
export const otelResourceAttributes = Effect.gen(function* () {
	const raw = yield* Config.option(Config.string("OTEL_RESOURCE_ATTRIBUTES"))
	return Option.match(raw, {
		onSome: (value) => parseOtelResourceAttributes(value),
		onNone: () => ({}) as Record<string, string>,
	})
})
