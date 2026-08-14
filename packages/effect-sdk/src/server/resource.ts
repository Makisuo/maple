import { Effect, Option, Redacted } from "effect"
import * as EnvConfig from "./config.js"
import { getAutoPlatformAttributes } from "./platform.js"

/**
 * Public Maple ingest endpoint. Used as the default when no endpoint is
 * configured via `config.endpoint`, `MAPLE_ENDPOINT`, or
 * `OTEL_EXPORTER_OTLP_ENDPOINT` — so end users only need to supply an ingest
 * key, not an URL.
 */
const DEFAULT_MAPLE_ENDPOINT = "https://ingest.maple.dev"

const stringOrUndefined = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined

/**
 * Per-process (per-isolate, on Cloudflare Workers) service instance ID. Stamped
 * onto every resource so downstream dashboards can attribute traces/metrics to
 * the specific replica that emitted them — required by maple-telemetry-
 * conventions to match the Rust ingest gateway, which also emits a fresh UUID
 * per process. `crypto.randomUUID` is available in Node ≥19 and on workerd.
 *
 * Generated lazily on first use rather than at module load: Cloudflare Workers
 * disallow random generation (and other I/O) in global scope during script
 * upload validation. The UUID is memoized so it stays stable for the isolate's
 * lifetime — `resolveResource` runs inside a request handler, so the first call
 * stamps the ID and every subsequent resource reuses it.
 */
let serviceInstanceId: string | undefined
const getServiceInstanceId = (): string => (serviceInstanceId ??= crypto.randomUUID())

/**
 * Subset of `MapleConfig` consumed by `resolveResource` — declared inline so
 * this module doesn't have to import the full server `MapleConfig`/
 * `CloudflareConfig` type and create a circular import.
 */
export interface ResourceConfigInput {
	readonly serviceName?: string | undefined
	readonly serviceVersion?: string | undefined
	/**
	 * Logical group this service belongs to, emitted as the OTel
	 * `service.namespace` resource attribute. Optional — only stamped when set,
	 * so external apps choose their own (or none). Can also be supplied via
	 * `OTEL_RESOURCE_ATTRIBUTES=service.namespace=…`, which overrides this.
	 */
	readonly serviceNamespace?: string | undefined
	readonly environment?: string | undefined
	readonly endpoint?: string | undefined
	readonly ingestKey?: string | undefined
	readonly attributes?: Record<string, unknown> | undefined
	readonly sdkType?: "server" | "cloudflare" | "client" | undefined
	/**
	 * Canonical https URL of the source repository, emitted as the OTel
	 * `vcs.repository.url.full` resource attribute. When omitted, falls back to
	 * `MAPLE_REPOSITORY_URL`, then GitHub Actions / Vercel git env metadata.
	 */
	readonly repositoryUrl?: string | undefined
}

/**
 * Best-effort guard for `vcs.ref.head.revision`: only stamp values that look
 * like a git commit SHA — `serviceVersion` may legitimately be a semver
 * release string, which belongs in `service.version` but not in `vcs.*`.
 */
const isCommitSha = (value: string | undefined): value is string =>
	value !== undefined && /^[0-9a-f]{7,40}$/i.test(value)

export interface ResolvedResource {
	/**
	 * Always resolves — `DEFAULT_MAPLE_ENDPOINT` is the final fallback, so this
	 * is deliberately NOT optional. Presets disable themselves on a missing
	 * ingest key, never on a missing endpoint.
	 */
	readonly endpoint: string
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
export const resolveResource = Effect.fn("resolveResource")(function* (config: ResourceConfigInput) {
	const envEndpoint = yield* EnvConfig.endpoint
	const endpoint = config.endpoint ?? Option.getOrUndefined(envEndpoint) ?? DEFAULT_MAPLE_ENDPOINT

	const envIngestKey = yield* EnvConfig.ingestKey
	const ingestKey = config.ingestKey ? Redacted.make(config.ingestKey) : Option.getOrUndefined(envIngestKey)

	const envServiceVersion = yield* EnvConfig.serviceVersion
	const serviceVersion = config.serviceVersion ?? Option.getOrUndefined(envServiceVersion)

	const envRepositoryUrl = yield* EnvConfig.repositoryUrl
	const repositoryUrl = config.repositoryUrl ?? envRepositoryUrl
	// Prefer the platform-provided commit SHA; fall back to serviceVersion only
	// when it is itself SHA-shaped. Never shell out to git at runtime.
	const headRevision =
		Option.getOrUndefined(envServiceVersion) ?? (isCommitSha(serviceVersion) ? serviceVersion : undefined)

	const envEnvironment = yield* EnvConfig.environment
	const environment = config.environment ?? envEnvironment

	const envOtelServiceName = yield* EnvConfig.otelServiceName
	const serviceName = config.serviceName ?? Option.getOrUndefined(envOtelServiceName) ?? "unknown"

	const envResourceAttributes = yield* EnvConfig.otelResourceAttributes

	const attributes: Record<string, unknown> = {}
	Object.assign(attributes, getAutoPlatformAttributes())
	attributes["maple.sdk.type"] = config.sdkType ?? "server"
	attributes["service.instance.id"] = getServiceInstanceId()
	if (environment) {
		// Dual-emit: every Tinybird MV (`service_overview_spans_mv` et al.)
		// pre-extracts the legacy `deployment.environment` key, but query
		// consumers in `packages/query-engine/src/ch/queries/infra.ts` already
		// select on `deployment.environment.name` (the OTel-canonical key).
		// Emit both until the MVs migrate to `coalesce()`.
		attributes["deployment.environment"] = environment
		attributes["deployment.environment.name"] = environment
	}
	if (serviceVersion) attributes["deployment.commit_sha"] = serviceVersion
	if (repositoryUrl) attributes["vcs.repository.url.full"] = repositoryUrl
	if (headRevision) attributes["vcs.ref.head.revision"] = headRevision
	if (config.serviceNamespace) attributes["service.namespace"] = config.serviceNamespace
	Object.assign(attributes, envResourceAttributes)
	if (config.attributes) Object.assign(attributes, config.attributes)

	return {
		endpoint,
		ingestKey,
		environment,
		resource: { serviceName, serviceVersion, attributes },
	} satisfies ResolvedResource
}, Effect.orDie)

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

	const envCommitSha =
		stringOrUndefined(env.COMMIT_SHA) ??
		stringOrUndefined(env.RAILWAY_GIT_COMMIT_SHA) ??
		stringOrUndefined(env.VERCEL_GIT_COMMIT_SHA) ??
		stringOrUndefined(env.CF_PAGES_COMMIT_SHA) ??
		stringOrUndefined(env.RENDER_GIT_COMMIT)
	const serviceVersion = config.serviceVersion ?? envCommitSha

	const repositoryUrl =
		config.repositoryUrl ?? EnvConfig.resolveRepositoryUrl((key) => stringOrUndefined(env[key]))
	// Prefer the platform-provided commit SHA; fall back to serviceVersion only
	// when it is itself SHA-shaped. Never shell out to git at runtime.
	const headRevision = envCommitSha ?? (isCommitSha(serviceVersion) ? serviceVersion : undefined)

	const environment =
		config.environment ??
		stringOrUndefined(env.MAPLE_ENVIRONMENT) ??
		stringOrUndefined(env.RAILWAY_ENVIRONMENT_NAME) ??
		stringOrUndefined(env.DEPLOYMENT_ENV) ??
		"development"

	const serviceName = config.serviceName ?? stringOrUndefined(env.OTEL_SERVICE_NAME) ?? "unknown"

	const rawResourceAttributes = stringOrUndefined(env.OTEL_RESOURCE_ATTRIBUTES)
	const envResourceAttributes = rawResourceAttributes
		? EnvConfig.parseOtelResourceAttributes(rawResourceAttributes)
		: {}

	const attributes: Record<string, unknown> = {}
	Object.assign(attributes, getAutoPlatformAttributes())
	attributes["maple.sdk.type"] = config.sdkType ?? "server"
	attributes["service.instance.id"] = getServiceInstanceId()
	if (environment) {
		// See resolveResource — dual-emit both keys until MVs coalesce.
		attributes["deployment.environment"] = environment
		attributes["deployment.environment.name"] = environment
	}
	if (serviceVersion) attributes["deployment.commit_sha"] = serviceVersion
	if (repositoryUrl) attributes["vcs.repository.url.full"] = repositoryUrl
	if (headRevision) attributes["vcs.ref.head.revision"] = headRevision
	if (config.serviceNamespace) attributes["service.namespace"] = config.serviceNamespace
	Object.assign(attributes, envResourceAttributes)
	if (config.attributes) Object.assign(attributes, config.attributes)

	return {
		endpoint,
		ingestKey,
		environment,
		resource: { serviceName, serviceVersion, attributes },
	}
}
