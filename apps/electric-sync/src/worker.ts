/**
 * The electric-sync Worker in alchemy's single-module form: this file is both
 * the resource the root stack yields (`yield* ElectricSync`) and the bundle
 * alchemy deploys (`main: import.meta.url`). Stage-derived props come from
 * `MapleStack`, which the stack provides; `impl` runs once per isolate, on the
 * first event.
 *
 * A standalone ElectricSQL shape proxy, deliberately DB-free: it authenticates
 * callers from the Clerk / self-hosted session bearer only (no Hyperdrive /
 * MAPLE_DB binding), pins each shape's org scope, and forwards to Electric.
 */
import {
	CLOUDFLARE_WORKER_PLACEMENT,
	MapleStack,
	type MapleStage,
	resolveWorkerName,
} from "@maple/infra/cloudflare"
import { authEnv, merge, optionalPlain, optionalSecret, selfObservabilityEnv } from "@maple/infra/env"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer, Scope } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"

const configuredEnv = (stage: MapleStage) =>
	merge(
		// Auth (same AuthEnv subset the api worker sets; no DB).
		authEnv,
		optionalPlain("MAPLE_ORG_ID_OVERRIDE"),
		// ElectricSQL upstream: base URL (Electric Cloud in prod) + Cloud source
		// credentials. The shape proxy 503s if URL is unset.
		//
		// PR previews get none of the three on purpose: they no longer have a
		// PlanetScale branch, so there is no per-PR Electric source to point at, and
		// inheriting the shared `dev` credentials would proxy preview shapes against
		// another stage's data. Absent ELECTRIC_URL → 503 → the web app falls back
		// to its effect-atom fetches.
		...(stage.kind === "pr"
			? []
			: [
					optionalPlain("ELECTRIC_URL"),
					optionalPlain("ELECTRIC_SOURCE_ID"),
					optionalSecret("ELECTRIC_SECRET"),
				]),
		// Self-observability (OTLP export through the ingest gateway).
		// NOTE: MAPLE_ENVIRONMENT used to be `optionalPlain(…, stageDefault)` here,
		// which let the environment win — the exact override `api` and `alerting`
		// both guard against. It is stage-derived now, like theirs.
		selfObservabilityEnv(stage),
	)

/**
 * Alchemy evaluates a Worker's props wherever the class is yielded — the
 * deployed bundle included, where they are inert. `__ALCHEMY_RUNTIME__` folds to
 * `true` there, so the stack-side branch below, and the `@maple/infra` modules
 * only it reaches, are dead-code-eliminated from what ships.
 */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const { stage, domains, workerDev } = yield* MapleStack
	return {
		main: import.meta.url,
		name: resolveWorkerName("electric-sync", stage),
		compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		// Under `bun dev`: a sticky port the app's route follows.
		dev: workerDev("electric-sync"),
		workersDev: true,
		// Custom domain (not a zone route): routes don't create DNS records, so
		// pr-stage hostnames would be authoritative NXDOMAIN. Custom domains
		// provision DNS + edge certs automatically.
		domain: domains.sync,
		env: yield* configuredEnv(stage),
	}
})

// The route graph builds `@maple/domain` Schema ASTs eagerly, so it is imported
// here rather than at module scope: Cloudflare runs only the top level during
// upload validation, against the fixed startup-CPU budget.
const AppLayer = Layer.unwrap(
	Effect.promise(async () => {
		const [{ ElectricSyncRouter }, { ElectricClient }, { TenantResolver }, { SyncConfig }] =
			await Promise.all([
				import("./routes/shape.http"),
				import("./electric/ElectricClient"),
				import("./auth/TenantResolver"),
				import("./config"),
			])
		return ElectricSyncRouter.pipe(
			Layer.provideMerge(
				HttpRouter.cors({
					allowedOrigins: ["*"],
					allowedMethods: ["GET", "OPTIONS"],
					allowedHeaders: ["*"],
					// Load-bearing, not hygiene: without these exposed headers
					// @electric-sql/client cannot advance the shape cursor through the
					// proxy, and every stream stalls after its first chunk.
					exposedHeaders: [
						"electric-handle",
						"electric-offset",
						"electric-schema",
						"electric-cursor",
						"electric-up-to-date",
					],
				}),
			),
			// The route depends on these two services rather than constructing them,
			// so tests can substitute either one; this is the only place the real
			// implementations (and the real `fetch`) are wired in.
			Layer.provideMerge(ElectricClient.layer.pipe(Layer.provide(FetchHttpClient.layer))),
			Layer.provideMerge(TenantResolver.layer),
			Layer.provideMerge(SyncConfig.layer),
			Layer.provideMerge(HttpRouter.layer),
		)
	}),
)

export default class ElectricSync extends Cloudflare.Worker<ElectricSync>()(
	"electric-sync",
	props,
	Effect.gen(function* () {
		// Built on the first request and kept for the isolate — not here, in init:
		// init also runs at plan time, where alchemy auto-binds every `Config` it
		// sees read onto the Worker, and this Worker's env is declared in full by
		// `props`. The build scope is never closed (workerd has no isolate
		// teardown), so everything in the layer stays value-shaped.
		//
		// A `ConfigError` here is a misconfigured deploy — `SyncConfig` already dies
		// on the fatal ones — so the build dies too, and the bridge answers 500
		// until the isolate is replaced. The handler itself keeps the router's
		// typed failures: the bridge renders them before its tracer runs, so an
		// unmatched route is an Ok span with a 404, and a defect a 500 that the SDK
		// records as an Error server span (`worker-bridge.test.ts` pins both).
		const app = yield* Effect.cached(
			Effect.gen(function* () {
				const scope = yield* Scope.make()
				return yield* HttpRouter.toHttpEffect(AppLayer).pipe(Scope.provide(scope))
			}).pipe(Effect.orDie),
		)

		return { fetch: app }
	}).pipe(
		// The Worker init is the entry point; the bridge builds the telemetry into
		// each event's scope and flushes it after the response.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(WorkerTelemetry({ serviceName: "electric-sync" })),
	),
) {}
