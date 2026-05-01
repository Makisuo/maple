// ---------------------------------------------------------------------------
// Auto-detected platform / runtime resource attributes
//
// Maps `std-env` runtime + provider detection plus a small set of
// platform-specific environment variables onto OpenTelemetry semantic-
// convention resource attributes (cloud.*, faas.*, process.runtime.*, os.*).
//
// Spec references:
// - Cloud:    https://opentelemetry.io/docs/specs/semconv/resource/cloud/
// - FaaS:     https://opentelemetry.io/docs/specs/semconv/resource/faas/
// - Process:  https://opentelemetry.io/docs/specs/semconv/resource/process/
// - OS / Host: https://opentelemetry.io/docs/specs/semconv/resource/os/
//
// `cloud.provider = "cloudflare"` and `cloud.platform = "cloudflare.workers"`
// are not formally enumerated by the OTel spec but are the de-facto convention
// adopted by the Cloudflare Workers community / instrumentation libraries; the
// Maple dashboard's hosting-icon resolver matches them.
//
// AWS Lambda detection is done via env vars (`AWS_LAMBDA_FUNCTION_NAME`)
// because std-env's `provider` doesn't enumerate Lambda — Lambda runs node on
// EC2-managed hosts and isn't a CI/CD provider in std-env's taxonomy.
// ---------------------------------------------------------------------------

import { Match } from "effect"
import { platform, provider, runtime } from "std-env"

export interface PlatformInputs {
	/** `std-env` runtime: "node" | "bun" | "deno" | "workerd" | "edge-light" | "fastly" | "netlify" | string. */
	readonly runtime: string
	/** `std-env` provider: "cloudflare_workers" | "vercel" | "google_cloudrun" | …, or "" / "unknown". */
	readonly provider: string
	/** `std-env` `platform` (Node `process.platform`): "linux" | "darwin" | "win32" | …. */
	readonly platform: string
	/**
	 * Process architecture from `process.arch` ("x64", "arm64", …). Empty when
	 * unavailable (e.g. browser or workerd). Mapped to `host.arch`.
	 */
	readonly arch: string
	/** Subset of `process.env` we care about. Reading the whole object would be wasteful and risky. */
	readonly env: Readonly<Record<string, string | undefined>>
}

type Attrs = Record<string, string>
const empty: Attrs = {}

// `std-env`'s runtime ⇒ OTel canonical `process.runtime.name`. node maps to
// "nodejs"; everything else is passed through verbatim because there's no
// canonical OTel value for workerd / edge-light / fastly.
const runtimeAttrs = (rt: string): Attrs =>
	Match.value(rt).pipe(
		Match.when("node", () => ({ "process.runtime.name": "nodejs" })),
		Match.whenOr("bun", "deno", "workerd", "edge-light", "fastly", (name) => ({
			"process.runtime.name": name,
		})),
		Match.orElse((): Attrs => empty),
	)

// Node `process.platform` ⇒ OTel `os.type`.
const osAttrs = (plat: string): Attrs =>
	Match.value(plat).pipe(
		Match.when("win32", () => ({ "os.type": "windows" })),
		Match.whenOr("darwin", "linux", "freebsd", "openbsd", "netbsd", (p) => ({ "os.type": p })),
		Match.orElse((): Attrs => empty),
	)

// Node `process.arch` ⇒ OTel `host.arch`.
const archAttrs = (a: string): Attrs =>
	a === ""
		? empty
		: {
				"host.arch": Match.value(a).pipe(
					Match.when("x64", () => "amd64"),
					Match.when("ia32", () => "x86"),
					Match.orElse((other) => other),
				),
			}

const lambdaAttrs = (env: PlatformInputs["env"]): Attrs => ({
	"cloud.provider": "aws",
	"cloud.platform": "aws_lambda",
	"faas.name": env.AWS_LAMBDA_FUNCTION_NAME!,
	...(env.AWS_LAMBDA_FUNCTION_VERSION && { "faas.version": env.AWS_LAMBDA_FUNCTION_VERSION }),
	...(env.AWS_LAMBDA_LOG_STREAM_NAME && { "faas.instance": env.AWS_LAMBDA_LOG_STREAM_NAME }),
	...(env.AWS_REGION
		? { "cloud.region": env.AWS_REGION }
		: env.AWS_DEFAULT_REGION
			? { "cloud.region": env.AWS_DEFAULT_REGION }
			: {}),
})

// `std-env` provider ⇒ OTel cloud.provider / cloud.platform / faas.* /
// cloud.region. Each branch returns the partial record it contributes; the
// caller spreads it into the final attrs object.
const providerAttrs = (prov: string, env: PlatformInputs["env"]): Attrs =>
	Match.value(prov).pipe(
		Match.when(
			"cloudflare_workers",
			(): Attrs => ({ "cloud.provider": "cloudflare", "cloud.platform": "cloudflare.workers" }),
		),
		Match.when(
			"cloudflare_pages",
			(): Attrs => ({ "cloud.provider": "cloudflare", "cloud.platform": "cloudflare.pages" }),
		),
		Match.when(
			"vercel",
			(): Attrs => ({
				"cloud.provider": "vercel",
				"cloud.platform": "vercel",
				...(env.VERCEL_REGION && { "cloud.region": env.VERCEL_REGION }),
				...(env.VERCEL_DEPLOYMENT_ID && { "faas.instance": env.VERCEL_DEPLOYMENT_ID }),
			}),
		),
		Match.when("netlify", (): Attrs => ({ "cloud.provider": "netlify", "cloud.platform": "netlify" })),
		Match.whenOr(
			"google_cloudrun",
			"google_cloudrun_job",
			(): Attrs => ({
				"cloud.provider": "gcp",
				"cloud.platform": "gcp_cloud_run",
				...(env.K_SERVICE && { "faas.name": env.K_SERVICE }),
				...(env.K_REVISION && { "faas.version": env.K_REVISION }),
				...(env.CLOUD_RUN_REGION && { "cloud.region": env.CLOUD_RUN_REGION }),
			}),
		),
		Match.when(
			"firebase_app_hosting",
			(): Attrs => ({ "cloud.provider": "gcp", "cloud.platform": "gcp_firebase_app_hosting" }),
		),
		Match.when(
			"aws_amplify",
			(): Attrs => ({ "cloud.provider": "aws", "cloud.platform": "aws_amplify" }),
		),
		Match.when(
			"deno-deploy",
			(): Attrs => ({
				"cloud.provider": "deno",
				"cloud.platform": "deno_deploy",
				...(env.DENO_REGION && { "cloud.region": env.DENO_REGION }),
				...(env.DENO_DEPLOYMENT_ID && { "faas.instance": env.DENO_DEPLOYMENT_ID }),
			}),
		),
		Match.when(
			"render",
			(): Attrs => ({
				"cloud.provider": "render",
				"cloud.platform": "render",
				...(env.RENDER_INSTANCE_ID && { "faas.instance": env.RENDER_INSTANCE_ID }),
			}),
		),
		Match.when(
			"railway",
			(): Attrs => ({
				"cloud.provider": "railway",
				"cloud.platform": "railway",
				...(env.RAILWAY_REPLICA_ID && { "faas.instance": env.RAILWAY_REPLICA_ID }),
			}),
		),
		Match.when(
			"edgeone_pages",
			(): Attrs => ({ "cloud.provider": "tencent_cloud", "cloud.platform": "tencent_edgeone_pages" }),
		),
		Match.orElse((): Attrs => empty),
	)

// Cloudflare Workers: in some bundlers (Wrangler dev / Pages Functions)
// std-env's `provider` doesn't fire but `runtime === "workerd"` does. Fill in
// the cloud.* attrs so the dashboard still classifies the service correctly.
const workerdFallback = (rt: string, alreadyResolved: boolean): Attrs =>
	rt === "workerd" && !alreadyResolved
		? { "cloud.provider": "cloudflare", "cloud.platform": "cloudflare.workers" }
		: empty

// Vercel Edge runtime: similar fallback when std-env's `provider` is unset
// but the VERCEL env var is.
const vercelEdgeFallback = (rt: string, alreadyResolved: boolean, env: PlatformInputs["env"]): Attrs =>
	rt === "edge-light" && !alreadyResolved && env.VERCEL
		? { "cloud.provider": "vercel", "cloud.platform": "vercel" }
		: empty

/**
 * Derive OpenTelemetry resource attributes from `std-env` outputs and
 * platform-specific environment variables. Pure: no I/O, no globals.
 *
 * Returned keys follow OTel semantic conventions:
 * - `cloud.provider`, `cloud.platform`, `cloud.region`
 * - `faas.name`, `faas.version`, `faas.instance`
 * - `process.runtime.name`
 * - `os.type`, `host.arch`
 *
 * Plus Maple-specific provenance keys (`maple.runtime`, `maple.provider`)
 * preserved for back-compat with existing dashboards.
 */
export const derivePlatformAttributes = (inputs: PlatformInputs): PlatformAttributes => {
	const { runtime: rt, provider: prov, platform: plat, arch, env } = inputs

	// Lambda overrides std-env's provider when present; matches the original
	// short-circuit semantics. Otherwise std-env's provider drives cloud.*.
	const cloudAttrs = env.AWS_LAMBDA_FUNCTION_NAME ? lambdaAttrs(env) : providerAttrs(prov, env)
	const cloudResolved = "cloud.provider" in cloudAttrs

	return {
		...(rt && { "maple.runtime": rt }),
		...(prov && { "maple.provider": prov }),
		...runtimeAttrs(rt),
		...osAttrs(plat),
		...archAttrs(arch),
		...cloudAttrs,
		...workerdFallback(rt, cloudResolved),
		...vercelEdgeFallback(rt, cloudResolved, env),
	}
}

export type PlatformAttributes = Attrs

/**
 * Whitelist of env-var keys read by `derivePlatformAttributes`. Limiting reads
 * to this set keeps the SDK from accidentally observing unrelated secrets and
 * keeps the test surface explicit.
 */
const PLATFORM_ENV_KEYS = [
	// AWS Lambda
	"AWS_LAMBDA_FUNCTION_NAME",
	"AWS_LAMBDA_FUNCTION_VERSION",
	"AWS_LAMBDA_LOG_STREAM_NAME",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	// Vercel
	"VERCEL",
	"VERCEL_REGION",
	"VERCEL_DEPLOYMENT_ID",
	// Cloud Run / Firebase
	"K_SERVICE",
	"K_REVISION",
	"CLOUD_RUN_REGION",
	// Deno Deploy
	"DENO_REGION",
	"DENO_DEPLOYMENT_ID",
	// Render
	"RENDER_INSTANCE_ID",
	// Railway
	"RAILWAY_REPLICA_ID",
] as const

/**
 * Read live std-env + process.env state and derive OTel platform attributes.
 * Safe to call on any runtime — falls back to empty string for missing inputs
 * rather than throwing.
 */
export const getAutoPlatformAttributes = (): PlatformAttributes => {
	const proc = (globalThis as { process?: { env?: Record<string, string | undefined>; arch?: string } })
		.process
	const procEnv = proc?.env ?? {}
	const env: Record<string, string | undefined> = {}
	for (const key of PLATFORM_ENV_KEYS) env[key] = procEnv[key]

	return derivePlatformAttributes({
		runtime: runtime ?? "",
		provider: provider ?? "",
		platform: platform ?? "",
		arch: proc?.arch ?? "",
		env,
	})
}
