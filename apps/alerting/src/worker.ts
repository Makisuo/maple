/**
 * The alerting Worker in alchemy's single-module form: this file is both the
 * resource the root stack yields (`yield* Alerting`) and the bundle alchemy
 * deploys (`main: import.meta.url`). Stage-derived props read `MapleStack`;
 * `impl` runs once per isolate, on the first event, and registers one handler
 * per cron. The ticks live in `./scheduled`, imported on the first fire so
 * the api layer graph stays off the startup path — and out of the deploy
 * process, where init also runs.
 *
 * Alchemy's cron source reports every fire as successful, so the platform's
 * retry never engages here. Nothing is lost: the ticks already log and
 * swallow their own failures (`catchTickFailure`), the schedules re-fire on
 * their own, and a failure outside a tick (the layer build) is logged below.
 */
import {
	CLOUDFLARE_WORKER_PLACEMENT,
	ManagedMapleDb,
	MapleStack,
	type MapleStage,
	resolveWorkerName,
} from "@maple/infra/cloudflare"
import {
	apnsEnv,
	appUrlsEnv,
	authEnv,
	cloudflareOAuthEnv,
	ingestKeyCryptoEnv,
	merge,
	optionalPlain,
	optionalSecret,
	planetScaleOAuthEnv,
	selfObservabilityEnv,
	tinybirdEnv,
} from "@maple/infra/env"
import * as Cloudflare from "alchemy/Cloudflare"
import { Cause, Effect, Ref } from "effect"
import { HttpServerResponse } from "effect/unstable/http"

/**
 * The alerting worker's resource bindings, split from the `Config`-sourced env
 * so `InferEnv` can derive `AlertingWorkerEnv` below.
 */
const makeWorkerBindings = ({
	stage,
	mapleDb,
}: {
	stage: MapleStage
	mapleDb: Cloudflare.Hyperdrive.Connection | undefined
}) => ({
	// Ref stages attach MAPLE_DB via `bindMapleDbRef` in the root stack.
	...(mapleDb ? { MAPLE_DB: mapleDb } : undefined),
	// Cross-script binding to the investigation fan-out Workflow hosted by the
	// api worker. Alert, error, and anomaly ticks start investigations when
	// incidents open. The first arg is the physical workflow name; `scriptName`
	// makes this a reference-only binding (the api worker owns the workflow
	// resource).
	INVESTIGATION_FANOUT_WORKFLOW: Cloudflare.Workflow<{
		orgId: string
		investigationId: string
		maxWidth: number
		reservedPasses: number
		attempt: number
	}>(resolveWorkerName("investigation-fanout", stage), {
		className: "InvestigationFanoutWorkflow",
		scriptName: resolveWorkerName("api", stage),
	}),
	// Production only: preview/stg workers run the same email crons against
	// their own DB branches, so a binding here means every live stage sends
	// its own copy of onboarding/digest/alert emails to real users.
	...(stage.kind === "prd"
		? {
				EMAIL: Cloudflare.Email.SendEmail("email", {
					allowedSenderAddresses: ["notifications@noreply.maple.dev"],
				}),
			}
		: undefined),
})

/**
 * The alerting worker's runtime env, derived from the declaration above — one
 * source of truth, imported (type-only) by `./scheduled.ts`.
 *
 * `Partial` because a binding's absence is a real runtime state: ref stages
 * attach MAPLE_DB after the Worker exists, EMAIL is prd-only, and `alchemy
 * dev` emulation does not cover every binding. The configuration vars stay
 * `unknown` on purpose: config is read through the Effect ConfigProvider
 * (`layerFromEnv` → the shared `Env` service), never off `env` directly.
 */
export type AlertingWorkerEnv = Partial<Cloudflare.InferEnv<ReturnType<typeof makeWorkerBindings>>> &
	Record<string, unknown>

/**
 * Everything in the alerting worker's env that comes from configuration rather
 * than from a resource. Largely the api worker's set — the two share 32 keys,
 * which is why the groups live in `@maple/infra/env`.
 */
const configuredEnv = (stage: MapleStage) =>
	merge(
		// Alert-rule evaluation runs Tinybird-scoped raw SQL through
		// TinybirdOrgTokenService, so this is the same set the api worker binds.
		tinybirdEnv,
		authEnv,
		ingestKeyCryptoEnv,
		appUrlsEnv,
		// MAPLE_ENDPOINT / MAPLE_ENVIRONMENT / COMMIT_SHA / MAPLE_INGEST_KEY.
		// MAPLE_ENVIRONMENT is stage-derived and NOT env-overridable: it gates both
		// the non-prod cron skip below and EmailService.emailAllowed, so an override
		// would open both at once and leave the prd-only EMAIL binding as the sole
		// guard.
		selfObservabilityEnv(stage),
		// Non-prod stages skip all crons (they share live org data via the prod DB);
		// set to "1" on a stage to deliberately exercise crons there.
		optionalPlain("MAPLE_ALERTING_ALLOW_NONPROD"),
		// Dev-only escape hatch from per-org BYO rows (see apps/api/alchemy.run.ts).
		optionalPlain("MAPLE_IGNORE_ORG_CLICKHOUSE"),
		optionalSecret("AUTUMN_SECRET_KEY"),
		optionalSecret("INTERNAL_SERVICE_TOKEN"),
		// The alerting worker is where incidents open and resolve, so it is the one
		// that sends push (platform/Apns.ts) — and it runs the Cloudflare analytics
		// and PlanetScale inventory pollers, each of which resolves and refreshes
		// per-org OAuth tokens with the same config the api worker uses.
		apnsEnv,
		cloudflareOAuthEnv,
		planetScaleOAuthEnv,
	)

/**
 * Alchemy evaluates a Worker's props wherever the class is yielded — the
 * deployed bundle included, where they are inert. `__ALCHEMY_RUNTIME__` folds to
 * `true` there, so the stack-side branch below, and the `@maple/infra` modules
 * only it reaches, are dead-code-eliminated from what ships.
 */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const { stage, workerDev, devEnv } = yield* MapleStack
	// Dev stages only; stg/prd bind their own Hyperdrive config by id in the
	// root stack — `alerting` issues ~97% of the workers' Postgres traffic and
	// was starving the api's connection pool when the two shared one.
	const mapleDb = yield* ManagedMapleDb
	const env = yield* configuredEnv(stage)
	return {
		main: import.meta.url,
		name: resolveWorkerName("alerting", stage),
		compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		// Under `bun dev`: a sticky port the app's route follows.
		dev: workerDev("alerting"),
		workersDev: false,
		// `devEnv` last, so `.env.local` cannot override the inter-app URLs.
		env: { ...makeWorkerBindings({ stage, mapleDb }), ...env, ...devEnv },
	}
})

/**
 * The schedules, each attached to the Worker by its `cron` handler below and
 * dispatched to a tick group by `selectScheduledProgram`. `0 9 * * *` (the
 * onboarding drip) was retired when that sequence moved to maple-portal's
 * campaign system.
 */
const ALERTING_CRONS = ["* * * * *", "*/5 * * * *", "*/15 * * * *", "0 * * * *"] as const

/**
 * Non-prod stages (stg, PR previews) share live org data — stg's Hyperdrive
 * points at the prod database — so their crons would iterate real orgs with
 * stage-local Tinybird/Clerk credentials: every tick fails per-org and floods
 * the error dashboards (and historically sent duplicate emails, see #237).
 * Same gating philosophy as the prd-only EMAIL binding, with an explicit
 * override for deliberately exercising crons on a non-prod stage.
 */
const cronsEnabled = (env: Record<string, unknown>): boolean =>
	env.MAPLE_ENVIRONMENT === "production" ||
	env.MAPLE_ALERTING_ALLOW_NONPROD === "1" ||
	env.MAPLE_ALERTING_ALLOW_NONPROD === "true"

export default class Alerting extends Cloudflare.Worker<Alerting>()(
	"alerting",
	props,
	Effect.gen(function* () {
		const exec = yield* Cloudflare.WorkerExecutionContext
		// Imported on the first fire and kept for the isolate: `./scheduled`
		// carries the whole api layer graph, which has no business in startup
		// validation or in the deploy process.
		const scheduled = yield* Effect.cached(Effect.promise(() => import("./scheduled")))
		// Once per isolate, not once per fire.
		const loggedNonProdSkip = yield* Ref.make(false)

		const onFire = (controller: ScheduledController) =>
			Effect.gen(function* () {
				const env = yield* Cloudflare.WorkerEnvironment
				if (!cronsEnabled(env)) {
					if (!(yield* Ref.getAndSet(loggedNonProdSkip, true))) {
						yield* Effect.logInfo("Skipping alerting crons on non-production stage").pipe(
							Effect.annotateLogs({
								"maple.environment":
									typeof env.MAPLE_ENVIRONMENT === "string"
										? env.MAPLE_ENVIRONMENT
										: "unset",
								hint: "set MAPLE_ALERTING_ALLOW_NONPROD=1 to run them here",
							}),
						)
					}
					return
				}
				const { runScheduled, telemetry } = yield* scheduled
				yield* runScheduled(controller.cron, env).pipe(
					// Interrupts are isolate teardown: the schedule re-fires anyway, and
					// they must not be logged as a failed run (same rule as the ticks').
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.void
							: Effect.logError("Alerting scheduled run failed", cause).pipe(
									Effect.annotateLogs({ "maple.alerting.cron": controller.cron }),
								),
					),
					// Drain spans and logs once the fire has settled.
					Effect.ensuring(exec.waitUntil(Effect.promise(() => telemetry.flush(env)))),
				)
			})

		for (const cron of ALERTING_CRONS) {
			yield* Cloudflare.Workers.cron(cron, onFire)
		}

		return {
			fetch: Effect.succeed(HttpServerResponse.text("maple-alerting: scheduled only", { status: 404 })),
		}
		// The Worker's init IS the entry point: the cron source needs the host Worker,
		// which only exists here.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
	}).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive)),
) {}
