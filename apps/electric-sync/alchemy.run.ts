import path from "node:path"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
import {
	CLOUDFLARE_WORKER_PLACEMENT,
	resolveDeploymentEnvironment,
	resolveWorkerName,
} from "@maple/infra/cloudflare"

const requireEnv = (key: string): string => {
	const value = process.env[key]?.trim()
	if (!value) {
		throw new Error(`Missing required deployment env: ${key}`)
	}
	return value
}

const optionalPlain = (key: string, fallback?: string): Record<string, string> => {
	const value = process.env[key]?.trim() || fallback
	return value ? { [key]: value } : {}
}

const optionalSecret = (key: string): Record<string, Redacted.Redacted<string>> => {
	const value = process.env[key]?.trim()
	return value ? { [key]: Redacted.make(value) } : {}
}

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
			url: true,
			// Custom domain (not a zone route): routes don't create DNS records, so
			// pr-stage hostnames would be authoritative NXDOMAIN. Custom domains
			// provision DNS + edge certs automatically.
			domain: domains.sync,
			env: {
				// Auth (same AuthEnv subset the api worker sets; no DB).
				MAPLE_AUTH_MODE: process.env.MAPLE_AUTH_MODE?.trim() || "self_hosted",
				MAPLE_DEFAULT_ORG_ID: process.env.MAPLE_DEFAULT_ORG_ID?.trim() || "default",
				...optionalPlain("MAPLE_ORG_ID_OVERRIDE"),
				...optionalSecret("MAPLE_ROOT_PASSWORD"),
				...optionalSecret("CLERK_SECRET_KEY"),
				...optionalPlain("CLERK_PUBLISHABLE_KEY"),
				...optionalSecret("CLERK_JWT_KEY"),
				// ElectricSQL upstream: base URL (Electric Cloud in prod) + Cloud source
				// credentials. The shape proxy 503s if URL is unset.
				...optionalPlain("ELECTRIC_URL"),
				...optionalPlain("ELECTRIC_SOURCE_ID"),
				...optionalSecret("ELECTRIC_SECRET"),
				// Self-observability (OTLP export through the ingest gateway).
				MAPLE_INGEST_KEY: Redacted.make(requireEnv("MAPLE_OTEL_INGEST_KEY")),
				...optionalPlain("MAPLE_ENDPOINT"),
				...optionalPlain("MAPLE_ENVIRONMENT", resolveDeploymentEnvironment(stage)),
				...optionalPlain("COMMIT_SHA"),
			},
		})

		return worker
	})
