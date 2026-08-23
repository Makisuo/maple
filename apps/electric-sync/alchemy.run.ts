import path from "node:path"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
import { CLOUDFLARE_WORKER_PLACEMENT, resolveWorkerName } from "@maple/infra/cloudflare"
import { authEnv, optionalPlain, optionalSecret, selfObservabilityEnv } from "@maple/infra/env"

export interface CreateElectricSyncWorkerOptions {
	stage: MapleStage
	domains: MapleDomains
}

// Standalone ElectricSQL shape-proxy worker. Deliberately DB-free: it authenticates
// callers from the Clerk / self-hosted session bearer only (no Hyperdrive / MAPLE_DB
// binding), pins each shape's org scope, and forwards to Electric.
export const createElectricSyncWorker = ({ stage, domains }: CreateElectricSyncWorkerOptions) =>
	Effect.gen(function* () {
		const worker = yield* Cloudflare.Worker("electric-sync", {
			name: resolveWorkerName("electric-sync", stage),
			main: path.join(import.meta.dirname, "src", "worker.ts"),
			compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
			placement: CLOUDFLARE_WORKER_PLACEMENT,
			workersDev: true,
			// Custom domain (not a zone route): routes don't create DNS records, so
			// pr-stage hostnames would be authoritative NXDOMAIN. Custom domains
			// provision DNS + edge certs automatically.
			domain: domains.sync,
			env: {
				// Auth (same AuthEnv subset the api worker sets; no DB).
				...authEnv(),
				...optionalPlain("MAPLE_ORG_ID_OVERRIDE"),
				// ElectricSQL upstream: base URL (Electric Cloud in prod) + Cloud source
				// credentials. The shape proxy 503s if URL is unset.
				//
				// PR previews get none of the three on purpose: they no longer have a
				// PlanetScale branch, so there is no per-PR Electric source to point at,
				// and inheriting the shared `dev` credentials would proxy preview shapes
				// against another stage's data. Absent ELECTRIC_URL → 503 → the web app
				// falls back to its effect-atom fetches.
				...(!(stage.kind === "pr")
					? {
							...optionalPlain("ELECTRIC_URL"),
							...optionalPlain("ELECTRIC_SOURCE_ID"),
							...optionalSecret("ELECTRIC_SECRET"),
						}
					: undefined),
				// Self-observability (OTLP export through the ingest gateway).
				// NOTE: MAPLE_ENVIRONMENT used to be `optionalPlain(…, stageDefault)` here,
				// which let `process.env` win — the exact override `api` and `alerting`
				// both guard against. It is stage-derived now, like theirs.
				...selfObservabilityEnv(stage),
			},
		})

		return worker
	})
