import path from "node:path"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as Portless from "@maple/alchemy-portless"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
import {
	CLOUDFLARE_WORKER_PLACEMENT,
	resolveHyperdriveRefId,
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

export interface CreateAlertingWorkerOptions {
	stage: MapleStage
	domains: MapleDomains
	/** The managed application database from the root (`createManagedMapleDb`); undefined on ref stages (stg/prd). */
	mapleDb: Cloudflare.Hyperdrive.Connection | undefined
	/** Local dev-server block from `Portless.workerDev` under `bun dev`; undefined on a deploy. */
	dev?: Portless.WorkerDev | undefined
}

/**
 * Everything in the alerting worker's env that comes from configuration rather
 * than from a resource. Largely the api worker's set — the two share 32 keys,
 * which is why the groups live in `@maple/infra/env`.
 */
const alertingConfiguredEnv = (stage: MapleStage) =>
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

export const createAlertingWorker = ({ stage, mapleDb, dev }: CreateAlertingWorkerOptions) =>
	Effect.gen(function* () {
		const configuredEnv = yield* alertingConfiguredEnv(stage)
		// `alerting` binds its own Hyperdrive config on prd — it issues ~97% of the
		// workers' Postgres traffic and was starving the api's connection pool.
		const hyperdriveRefId = resolveHyperdriveRefId(stage, "alerting")
		// Cross-script binding to the investigation fan-out Workflow hosted by the
		// api worker. Alert, error, and anomaly ticks start investigations when
		// incidents open. The
		// first arg is the physical workflow name; `scriptName` makes this a
		// reference-only binding (the api worker owns the workflow resource).
		const investigationFanoutWorkflow = Cloudflare.Workflow<{
			orgId: string
			investigationId: string
			maxWidth: number
			reservedPasses: number
			attempt: number
		}>(resolveWorkerName("investigation-fanout", stage), {
			className: "InvestigationFanoutWorkflow",
			scriptName: resolveWorkerName("api", stage),
		})

		const worker = yield* Cloudflare.Worker("alerting", {
			name: resolveWorkerName("alerting", stage),
			main: path.join(import.meta.dirname, "src", "worker.ts"),
			compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
			placement: CLOUDFLARE_WORKER_PLACEMENT,
			// Under `bun dev`: a sticky local port the app's portless route follows; undefined
			// outside the dev server (and under a bare `alchemy dev`, where alchemy picks one).
			dev,
			workersDev: false,
			// `0 9 * * *` (the onboarding drip) was retired when that sequence moved to
			// maple-portal's campaign system. Removing it here is what stops the two
			// from both sending during cutover.
			crons: ["* * * * *", "*/5 * * * *", "*/15 * * * *", "0 * * * *"],
			env: {
				// Ref stages attach MAPLE_DB via worker.bind below.
				...(mapleDb ? { MAPLE_DB: mapleDb } : undefined),
				INVESTIGATION_FANOUT_WORKFLOW: investigationFanoutWorkflow,
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
				...configuredEnv,
			},
		})

		if (hyperdriveRefId) {
			// v1 `HyperdriveRef` equivalent: bind the dashboard-managed config by ID
			// (see apps/api/alchemy.run.ts for the full rationale).
			yield* worker.bind("MAPLE_DB", {
				bindings: [{ type: "hyperdrive", name: "MAPLE_DB", id: hyperdriveRefId }],
			})
		}

		return worker
	})
