// The Maple stack: one `create*` factory per app, composed here.
//
// Comments in these files explain what a reader needs in order not to break the
// code. The history behind those decisions — the #378 deploy hang, the
// CONNECT_TIMEOUT cold-start regression, the Hyperdrive split measurements, the
// v1→v2 equivalences, the cost calls, and the local-dev/`alchemy dev` state of
// play — lives in `docs/infra.md`.
import { appendFileSync } from "node:fs"
import path from "node:path"
import * as Alchemy from "alchemy"
import * as AWS from "alchemy/AWS"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Output from "alchemy/Output"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
	parseMapleRegion,
	resolveAwsRegion,
	stageDeploysElectric,
	stageDeploysIngest,
} from "@maple/infra/aws"
import {
	formatMapleStage,
	parseMapleStage,
	resolveDatabaseMode,
	resolveMapleDomains,
} from "@maple/infra/cloudflare"
import * as Portless from "@maple/alchemy-portless"
import { DEV_PROCESS_APPS, selectedDevApps, type DevApp } from "@maple/infra/dev-urls"
import { requiredPlain } from "@maple/infra/env"
import { createAlertingWorker } from "./apps/alerting/alchemy.run.ts"
import { createManagedMapleDb, createMapleApi, createReplayBlobStore } from "./apps/api/alchemy.run.ts"
import { createMapleElectric } from "./apps/electric/alchemy.run.ts"
import { createElectricSyncWorker } from "./apps/electric-sync/alchemy.run.ts"
import { createMapleIngest } from "./apps/ingest/alchemy.run.ts"
import { createLandingWorker } from "./apps/landing/alchemy.run.ts"
import { createLocalUiWorker } from "./apps/local-ui/alchemy.run.ts"
import { createMapleWeb } from "./apps/web/alchemy.run.ts"

// v1 read the account id from CLOUDFLARE_DEFAULT_ACCOUNT_ID (the name Infisical
// still defines); v2's auth provider reads CLOUDFLARE_ACCOUNT_ID. Bridge the
// old name so CI keeps working without an Infisical rename.
if (!process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID) {
	process.env.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID
}

// Inter-app URLs must be plain strings at plan time: alchemy v2 resource
// attributes (e.g. `worker.url`) are lazy Outputs that only resolve when fed
// into other resources' props — they cannot be string-interpolated here. Every
// deployed stage therefore gets custom domains (see resolveMapleDomains); dev
// stages fall back to env-supplied URLs (cloud-deploying a dev stage is rare —
// local dev runs through wrangler/portless instead).
const resolveUrl = (domain: string | undefined, envKey: string, fallback = ""): string =>
	domain ? `https://${domain}` : process.env[envKey]?.trim() || fallback

/** Append `key=value` lines to the GitHub Actions step-output file, if any. */
const appendStepOutputs = (lines: string[]): void => {
	const file = process.env.GITHUB_OUTPUT
	if (file) {
		appendFileSync(file, `${lines.join("\n")}\n`)
	}
}

/**
 * `alchemy dev` sets ALCHEMY_DEV on its exec child. Not stage-derived: a dev
 * stage can still be deployed, and this must stay false when it is.
 */
const isDevServer = process.env.ALCHEMY_DEV === "true"

/** The apps this dev run serves; undefined on a deploy, which is never partial. */
const devApps = isDevServer ? selectedDevApps() : undefined

/**
 * A child process is handed its route's port. A Worker binds its port in
 * `precreate`, before Outputs resolve, so its route follows the Worker instead.
 */
const createDevRoute = (app: DevApp) => Portless.Route(`${app}-route`, { name: app })

/** Every resource is declared on every run; a subset run only leaves the others unserved. */
const workerDev = (app: DevApp) =>
	devApps === undefined ? undefined : devApps.has(app) ? Portless.workerDev(app) : Portless.workerUnserved

const serveWorker = (app: DevApp, worker: Cloudflare.Worker) =>
	devApps?.has(app)
		? Effect.asVoid(Portless.Route(`${app}-route`, { name: app, port: Portless.workerPort(worker.url) }))
		: Effect.void

/** Inter-app URLs handed to the Workers as env, so `.env.local` cannot override them. */
const devEnv = devApps
	? {
			MAPLE_API_BASE_URL: Portless.routeUrl("api"),
			MAPLE_APP_BASE_URL: Portless.routeUrl("web"),
			MAPLE_ELECTRIC_SYNC_URL: Portless.routeUrl("electric-sync"),
		}
	: undefined

/** A non-Worker app's own `dev` script under `Command.Dev`, which is a no-op on deploys. */
const createDevProcess = (app: DevApp, route: Portless.Route) =>
	Command.Dev(`${app}-dev`, {
		command: "bun run --silent dev",
		cwd: path.join(import.meta.dirname, "apps", app),
		env: {
			PORT: Output.map(Output.asOutput(route.port), String),
			HOST: "127.0.0.1",
			PORTLESS_URL: Portless.routeUrl(app),
			MAPLE_API_URL: Portless.routeUrl("api"),
		},
	})

const createProductionSharedResources = (stage: ReturnType<typeof parseMapleStage>) =>
	Effect.gen(function* () {
		// Bootstrap these account/zone-wide resources in production first. Other
		// stages keep their existing bindings until the production state has been
		// deployed, after which they can safely resolve these logical IDs via ref().
		if (stage.kind !== "prd") {
			return {}
		}

		const ingestEndpoint = (process.env.MAPLE_ENDPOINT?.trim() || "https://ingest.maple.dev").replace(
			/\/+$/,
			"",
		)
		const headers = { authorization: `Bearer ${yield* requiredPlain("MAPLE_OTEL_INGEST_KEY")}` }
		const tracesDestination = yield* Cloudflare.Workers.ObservabilityDestination(
			"workers-observability-traces",
			{
				name: "maple-workers-traces",
				url: `${ingestEndpoint}/v1/traces`,
				headers,
				logpushDataset: "opentelemetry-traces",
				enabled: true,
			},
		).pipe(RemovalPolicy.retain())
		const logsDestination = yield* Cloudflare.Workers.ObservabilityDestination(
			"workers-observability-logs",
			{
				name: "maple-workers-logs",
				url: `${ingestEndpoint}/v1/logs`,
				headers,
				logpushDataset: "opentelemetry-logs",
				enabled: true,
			},
		).pipe(RemovalPolicy.retain())

		return { logsDestination, tracesDestination }
	})

type StackProviderServices =
	| Layer.Services<ReturnType<typeof Cloudflare.providers>>
	| Layer.Services<ReturnType<typeof AWS.providers>>
	| Layer.Services<ReturnType<typeof Portless.providers>>

/**
 * Both clouds, unconditionally.
 *
 * `providers` is part of the `Alchemy.Stack` options, which are evaluated
 * before `Alchemy.Stage` is readable inside the stack effect, so this cannot be
 * stage-derived — every stage registers the AWS provider surface even when it
 * creates no AWS resource. Whether a stage actually gets an ingest fleet is
 * `stageDeploysIngest`, below.
 */
const providers: Layer.Layer<StackProviderServices, never, Alchemy.StackServices> =
	Cloudflare.providers().pipe(Layer.provideMerge(AWS.providers()), Layer.provideMerge(Portless.providers()))

export default Alchemy.Stack(
	"maple",
	{
		// Cloudflare hosts the Workers/DO/R2 surface; AWS hosts the Rust OTLP
		// gateway on ECS (`apps/ingest`). AWS credentials arrive as env vars from
		// Infisical exactly like the Cloudflare ones — `AWS.providers()` reads
		// AWS_REGION / AWS_ACCOUNT_ID / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
		//
		// AWS_ACCOUNT_ID is REQUIRED in CI. Without it alchemy's env-credential
		// path looks the account up over STS from inside its own environment
		// construction and deadlocks silently, with no log line and no network
		// I/O — the #378 hang. Every deploy workflow sets it; see deploy-prd.yml.
		providers,
		// Shared account-wide state store (Worker + DO SQLite) — bootstrapped once
		// per Cloudflare account (`alchemy bootstrap cloudflare` or the first
		// `deploy --yes`). ALCHEMY_LOCAL_STATE=1 opts into .alchemy/ file state for
		// throwaway local experiments (dev stages) without touching the account.
		state: process.env.ALCHEMY_LOCAL_STATE ? Alchemy.localState() : Cloudflare.state(),
	},
	Effect.gen(function* () {
		const stage = parseMapleStage(yield* Alchemy.Stage)
		const domains = resolveMapleDomains(stage)
		const shared = yield* createProductionSharedResources(stage)

		// Child-process routes; the Workers' routes follow their Workers below.
		const routes = new Map<DevApp, Portless.Route>()
		for (const app of DEV_PROCESS_APPS) {
			if (devApps?.has(app)) routes.set(app, yield* createDevRoute(app))
		}

		const apiUrl = devEnv?.MAPLE_API_BASE_URL ?? resolveUrl(domains.api, "MAPLE_API_BASE_URL")
		const electricSyncUrl =
			devEnv?.MAPLE_ELECTRIC_SYNC_URL ?? resolveUrl(domains.sync, "MAPLE_ELECTRIC_SYNC_URL")
		// Geographic instance this deploy belongs to. `us` today; an EU instance is
		// the same stack deployed with MAPLE_REGION=eu against that instance's own
		// Tinybird workspace and application database. Guarded here because a
		// mismatch between MAPLE_REGION and AWS_REGION would put the ACM
		// certificate in a different region from the ALB that must use it — and
		// worse, would export telemetry across the residency boundary the EU
		// instance exists to enforce.
		const region = parseMapleRegion(process.env.MAPLE_REGION)
		const expectedAwsRegion = resolveAwsRegion(region)
		const configuredAwsRegion = process.env.AWS_REGION?.trim()
		if (configuredAwsRegion && configuredAwsRegion !== expectedAwsRegion) {
			throw new Error(
				`AWS_REGION="${configuredAwsRegion}" does not match MAPLE_REGION="${region}" (expects "${expectedAwsRegion}").`,
			)
		}

		// The Rust OTLP gateway on ECS Fargate (prd/stg/pr — dev stages run it
		// through docker-compose instead). On prd/stg `domains.ingest` reaches it
		// via a Cloudflare CNAME at the ALB, so the URL below stays a plain string
		// and does not depend on the service resource; a PR preview gets no ingest
		// domain, so its ALB answers plain HTTP on 80 at `ingest.serviceUrl`.
		// Hoisted above BOTH consumers on purpose. The bucket is read by the api
		// Worker over its native binding and written by the Rust gateway on ECS over
		// the S3 API, and the gateway is constructed first — so neither factory can
		// own it. `credentials` is undefined on stages that keep replay payloads
		// inline (`stageEnablesReplayBlobs`). Skipped when a dev run leaves the api
		// out: the bucket is a live account resource even under `alchemy dev`.
		const replayBlobStore = yield* createReplayBlobStore({ stage })

		const ingest = stageDeploysIngest(stage)
			? yield* createMapleIngest({
					stage,
					domains,
					region,
					replayBlobs: replayBlobStore.credentials,
				})
			: undefined

		const ingestUrl = resolveUrl(domains.ingest, "VITE_INGEST_URL", "https://ingest.maple.dev")

		// Shared by api and alerting. Managed here on dev stages; stg/prd bind a
		// dashboard config by id in their factories; PR previews get none.
		const mapleDb =
			resolveDatabaseMode(stage) === "managed" ? yield* createManagedMapleDb(stage) : undefined

		// Chat and AI triage run inside the api worker (ChatSession Durable Object),
		// so there is no separate chat worker to sequence against any more.
		const api = yield* createMapleApi({
			stage,
			domains,
			mapleDb,
			replayBlobs: replayBlobStore.bucket,
			dev: workerDev("api"),
			devEnv,
		})
		yield* serveWorker("api", api)

		// Self-hosted ElectricSQL on ECS Fargate (prd/stg — dev stages use the
		// docker `electric` service, and PR previews have no database to replicate
		// from). Deliberately NOT wired into the sync worker's env here: the worker
		// reads `ELECTRIC_URL` from the secret store, so standing this service up
		// and cutting over to it are two separate, independently revertible acts.
		// Point `ELECTRIC_URL` at `https://${domains.electric}` once it is verified.
		// `ingest &&` is not a stage gate — it is the VPC dependency. Electric runs
		// in the ingest fleet's network (see `createMapleElectric`), so a stage
		// without ingest has no VPC to put it in. Every stage that deploys Electric
		// deploys ingest, so this never silently drops it.
		const electric =
			ingest && stageDeploysElectric(stage)
				? yield* createMapleElectric({ stage, domains, region, network: ingest.network })
				: undefined

		// Standalone ElectricSQL shape-proxy worker (DB-free); its public origin is
		// baked into the web build (VITE_ELECTRIC_SYNC_URL).
		const electricSync = yield* createElectricSyncWorker({
			stage,
			domains,
			dev: workerDev("electric-sync"),
		})
		yield* serveWorker("electric-sync", electricSync)

		// See `isDevServer`: each of these three is gated on a production
		// `Command.Build`, so including them would make `alchemy dev` build the
		// whole frontend before serving anything.
		const web = isDevServer
			? undefined
			: yield* createMapleWeb({
					stage,
					domains,
					apiUrl,
					ingestUrl,
					electricSyncUrl,
				})

		const landing = isDevServer
			? undefined
			: yield* createLandingWorker({
					stage,
					domains,
					ingestUrl,
					logsDestination: shared.logsDestination,
					tracesDestination: shared.tracesDestination,
				})

		const localUi = isDevServer
			? undefined
			: yield* createLocalUiWorker({
					stage,
					domains,
					logsDestination: shared.logsDestination,
					tracesDestination: shared.tracesDestination,
				})

		const alerting = yield* createAlertingWorker({
			stage,
			domains,
			mapleDb,
			dev: workerDev("alerting"),
			devEnv,
		})
		yield* serveWorker("alerting", alerting)

		// Dev only: the vite/astro dev servers, `cargo run`, and the scraper.
		for (const app of DEV_PROCESS_APPS) {
			const route = routes.get(app)
			if (route) yield* createDevProcess(app, route)
		}

		const summary = {
			stage: formatMapleStage(stage),
			apiUrl,
			ingestUrl,
			electricSyncUrl,
			webUrl: domains.web ? `https://${domains.web}` : "",
			landingUrl: domains.landing ? `https://${domains.landing}` : "",
			localUiUrl: domains.local ? `https://${domains.local}` : "",
		}

		// In GitHub Actions, expose the deployed URLs as step outputs so the
		// workflow can attach the web preview to the PR as a clickable deployment.
		// Only plan-time strings belong here — an Output cannot be interpolated
		// (see resolveUrl above); the ingest URL is written after the deploy below.
		yield* Effect.sync(() =>
			appendStepOutputs([
				`web_url=${summary.webUrl}`,
				`api_url=${summary.apiUrl}`,
				`sync_url=${summary.electricSyncUrl}`,
				`landing_url=${summary.landingUrl}`,
			]),
		)

		// Reference the remaining workers so nothing is tree-shaken out of the plan
		// and the summary carries their identity for the CLI output.
		return {
			...summary,
			// ALB hostname to CNAME `domains.ingest` at, plus the one-time ACM
			// validation record — both are manual entries in the Cloudflare
			// `maple.dev` zone, surfaced here so they come out of the deploy rather
			// than the AWS console.
			// The ALB hostname only exists once the service does, so `ingest_url`
			// is emitted as this output resolves — after apply — rather than at
			// plan time with the URLs above. On a PR preview this is the ALB's
			// plain-HTTP hostname: the preview has no ingest domain, so there is
			// no certificate and no CNAME.
			ingestServiceUrl: ingest
				? Output.mapEffect((serviceUrl: string | undefined) =>
						Effect.sync(() => {
							appendStepOutputs([`ingest_url=${serviceUrl ?? ""}`])
							return serviceUrl
						}),
					)(ingest.serviceUrl)
				: undefined,
			ingestCollectorEndpoint: ingest?.collectorEndpoint,
			// Same manual-DNS story as ingest: CNAME `domains.electric` at this ALB
			// (proxied), and add the ACM validation record once.
			electricServiceUrl: electric?.serviceUrl,
			electricCertificateValidation: electric?.certificateValidation,
			ingestCertificateValidation: ingest?.certificateValidation,
			apiWorker: api.workerName,
			electricSyncWorker: electricSync.workerName,
			webWorker: web?.workerName,
			landingWorker: landing?.workerName,
			localUiWorker: localUi?.workerName,
			alertingWorker: alerting.workerName,
		}
	}),
)
