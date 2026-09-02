/**
 * The alerting Worker as an alchemy class: the root stack yields it
 * (`yield* Alerting`) and its stage-derived props read `MapleStack`. The entry
 * stays the hand-written async module at `src/worker.ts`: its crons rely on
 * the platform's failure-and-retry semantics, which alchemy's Effect-native
 * cron source does not carry (a failing handler there is caught and never
 * reported). So unlike electric-sync this module is stack-side only — nothing
 * here ships in the bundle.
 */
import path from "node:path"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
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
 * source of truth, imported (type-only) by `src/worker.ts`.
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
		// this worker's scheduled() early-return and EmailService.emailAllowed, so an
		// override would open both at once and leave the prd-only EMAIL binding as
		// the sole guard.
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

const props = Effect.gen(function* () {
	const { stage, workerDev, devEnv } = yield* MapleStack
	// Dev stages only; stg/prd bind their own Hyperdrive config by id in the
	// root stack — `alerting` issues ~97% of the workers' Postgres traffic and
	// was starving the api's connection pool when the two shared one.
	const mapleDb = yield* ManagedMapleDb
	const env = yield* configuredEnv(stage)
	return {
		name: resolveWorkerName("alerting", stage),
		main: path.join(import.meta.dirname, "src", "worker.ts"),
		compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		// Under `bun dev`: a sticky port the app's route follows.
		dev: workerDev("alerting"),
		workersDev: false,
		// `0 9 * * *` (the onboarding drip) was retired when that sequence moved to
		// maple-portal's campaign system. Removing it here is what stops the two
		// from both sending during cutover.
		crons: ["* * * * *", "*/5 * * * *", "*/15 * * * *", "0 * * * *"],
		// `devEnv` last, so `.env.local` cannot override the inter-app URLs.
		env: { ...makeWorkerBindings({ stage, mapleDb }), ...env, ...devEnv },
	}
})

export default class Alerting extends Cloudflare.Worker<Alerting>()("alerting", props) {}
