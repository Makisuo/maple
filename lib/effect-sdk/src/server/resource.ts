import { Effect, Option, Redacted } from "effect"
import * as EnvConfig from "./config.js"
import { getAutoPlatformAttributes } from "./platform.js"

/**
 * Public Maple ingest endpoint. Used as the default when no endpoint is
 * configured via `config.endpoint`, `MAPLE_ENDPOINT`, or
 * `OTEL_EXPORTER_OTLP_ENDPOINT` — so end users only need to supply an ingest
 * key, not an URL.
 */
export const DEFAULT_MAPLE_ENDPOINT = "https://ingest.maple.dev"

const stringOrUndefined = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined

/**
 * Subset of `MapleConfig` consumed by `resolveResource` — declared inline so
 * this module doesn't have to import the full server `MapleConfig`/
 * `CloudflareConfig` type and create a circular import.
 */
export interface ResourceConfigInput {
	readonly serviceName?: string | undefined
	readonly serviceVersion?: string | undefined
	readonly environment?: string | undefined
	readonly endpoint?: string | undefined
	readonly ingestKey?: string | undefined
	readonly attributes?: Record<string, unknown> | undefined
	readonly sdkType?: "server" | "cloudflare" | "client" | undefined
}

export interface ResolvedResource {
	readonly endpoint: string | undefined
	readonly ingestKey: Redacted.Redacted<string> | undefined
	readonly resource: {
		readonly serviceName: string
		readonly serviceVersion: string | undefined
		readonly attributes: Record<string, unknown>
	}
	readonly environment: string | undefined
}

/**
 * Resolve the OpenTelemetry resource (service name, version, environment,
 * attributes) and ingest endpoint/key from a mix of programmatic config,
 * Maple-specific env vars, OTel-spec env vars, and the auto-detected platform
 * attributes.
 *
 * Precedence for resource attributes (lowest → highest):
 *   1. Auto-detected OTel platform attributes (`std-env` + well-known env vars)
 *   2. SDK-baked attributes (`maple.sdk.type`, `deployment.*`)
 *   3. `OTEL_RESOURCE_ATTRIBUTES` env var (e.g. maple-k8s-infra chart's
 *      downward-API pod metadata injection)
 *   4. Programmatic `config.attributes`
 *
 * Matches the OTel spec's "later writers win" rule. Shared by the server preset
 * (`Otlp.layerJson`-based) and the Cloudflare preset (custom flushable
 * tracer/logger) so both stamp identical resources on outgoing telemetry.
 */
export const resolveResource = (config: ResourceConfigInput): Effect.Effect<ResolvedResource> =>
	Effect.gen(function* () {
		const envEndpoint = yield* EnvConfig.endpoint
		const endpoint =
			config.endpoint ?? Option.getOrUndefined(envEndpoint) ?? DEFAULT_MAPLE_ENDPOINT

		const envIngestKey = yield* EnvConfig.ingestKey
		const ingestKey = config.ingestKey
			? Redacted.make(config.ingestKey)
			: Option.getOrUndefined(envIngestKey)

		const envServiceVersion = yield* EnvConfig.serviceVersion
		const serviceVersion = config.serviceVersion ?? Option.getOrUndefined(envServiceVersion)

		const envEnvironment = yield* EnvConfig.environment
		const environment = config.environment ?? Option.getOrUndefined(envEnvironment)

		const envOtelServiceName = yield* EnvConfig.otelServiceName
		const serviceName = config.serviceName ?? Option.getOrUndefined(envOtelServiceName) ?? "unknown"

		const envResourceAttributes = yield* EnvConfig.otelResourceAttributes

		const attributes: Record<string, unknown> = {}
		Object.assign(attributes, getAutoPlatformAttributes())
		attributes["maple.sdk.type"] = config.sdkType ?? "server"
		if (environment) {
			attributes["deployment.environment"] = environment
			attributes["deployment.environment.name"] = environment
		}
		if (serviceVersion) attributes["deployment.commit_sha"] = serviceVersion
		Object.assign(attributes, envResourceAttributes)
		if (config.attributes) Object.assign(attributes, config.attributes)

		return {
			endpoint,
			ingestKey,
			environment,
			resource: { serviceName, serviceVersion, attributes },
		} satisfies ResolvedResource
	}).pipe(Effect.orDie)

/**
 * Synchronous resource resolver for environments where reading from a
 * ConfigProvider would be overkill — specifically Cloudflare Workers, where
 * the per-isolate `env` binding is a plain `Record<string, unknown>` of
 * strings.
 *
 * Identical precedence rules to `resolveResource`, just reading from `env`
 * directly instead of `Config.string`. Used so the Cloudflare preset can be
 * built lazily-once-per-isolate without forcing the build itself to be wrapped
 * in an Effect.
 */
export const resolveResourceFromEnv = (
	env: Record<string, unknown>,
	config: ResourceConfigInput,
): ResolvedResource => {
	const endpoint =
		config.endpoint ??
		stringOrUndefined(env.MAPLE_ENDPOINT) ??
		stringOrUndefined(env.OTEL_EXPORTER_OTLP_ENDPOINT) ??
		DEFAULT_MAPLE_ENDPOINT

	const rawIngestKey = stringOrUndefined(env.MAPLE_INGEST_KEY)
	const ingestKey = config.ingestKey
		? Redacted.make(config.ingestKey)
		: rawIngestKey
			? Redacted.make(rawIngestKey)
			: undefined

	const serviceVersion =
		config.serviceVersion ??
		stringOrUndefined(env.COMMIT_SHA) ??
		stringOrUndefined(env.RAILWAY_GIT_COMMIT_SHA) ??
		stringOrUndefined(env.VERCEL_GIT_COMMIT_SHA) ??
		stringOrUndefined(env.CF_PAGES_COMMIT_SHA) ??
		stringOrUndefined(env.RENDER_GIT_COMMIT)

	const environment =
		config.environment ??
		stringOrUndefined(env.MAPLE_ENVIRONMENT) ??
		stringOrUndefined(env.RAILWAY_ENVIRONMENT) ??
		stringOrUndefined(env.VERCEL_ENV) ??
		stringOrUndefined(env.NODE_ENV)

	const serviceName =
		config.serviceName ?? stringOrUndefined(env.OTEL_SERVICE_NAME) ?? "unknown"

	const rawResourceAttributes = stringOrUndefined(env.OTEL_RESOURCE_ATTRIBUTES)
	const envResourceAttributes = rawResourceAttributes
		? EnvConfig.parseOtelResourceAttributes(rawResourceAttributes)
		: {}

	const attributes: Record<string, unknown> = {}
	Object.assign(attributes, getAutoPlatformAttributes())
	attributes["maple.sdk.type"] = config.sdkType ?? "server"
	if (environment) {
		attributes["deployment.environment"] = environment
		attributes["deployment.environment.name"] = environment
	}
	if (serviceVersion) attributes["deployment.commit_sha"] = serviceVersion
	Object.assign(attributes, envResourceAttributes)
	if (config.attributes) Object.assign(attributes, config.attributes)

	return {
		endpoint,
		ingestKey,
		environment,
		resource: { serviceName, serviceVersion, attributes },
	}
}
