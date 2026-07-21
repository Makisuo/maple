import path from "node:path"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
import {
	CLOUDFLARE_WORKER_PLACEMENT,
	resolveDeploymentEnvironment,
	resolveHyperdriveRefId,
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

export interface CreateAlertingWorkerOptions {
	stage: MapleStage
	domains: MapleDomains
	/** Managed per-branch Hyperdrive from the api factory; undefined on ref stages (stg/prd). */
	mapleDb: Cloudflare.Hyperdrive.Connection | undefined
}

export const createAlertingWorker = ({ stage, mapleDb }: CreateAlertingWorkerOptions) =>
	Effect.gen(function* () {
		const hyperdriveRefId = resolveHyperdriveRefId(stage)
		// Cross-script binding to the AI triage Workflow hosted by the api worker —
		// the error/anomaly ticks enqueue triage runs when incidents open. The
		// first arg is the physical workflow name; `scriptName` makes this a
		// reference-only binding (the api worker owns the workflow resource).
		const aiTriageWorkflow = Cloudflare.Workflow<{
			orgId: string
			incidentKind: string
			incidentId: string
			issueId?: string
			runId: string
		}>(resolveWorkerName("ai-triage", stage), {
			className: "AiTriageWorkflow",
			scriptName: resolveWorkerName("api", stage),
		})

		const worker = yield* Cloudflare.Worker("alerting", {
			name: resolveWorkerName("alerting", stage),
			main: path.join(import.meta.dirname, "src", "worker.ts"),
			compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
			placement: CLOUDFLARE_WORKER_PLACEMENT,
			url: false,
			crons: ["* * * * *", "*/5 * * * *", "*/15 * * * *", "0 * * * *", "0 9 * * *"],
			env: {
				// Ref stages attach MAPLE_DB via worker.bind below.
				...(mapleDb ? { MAPLE_DB: mapleDb } : {}),
				AI_TRIAGE_WORKFLOW: aiTriageWorkflow,
				// Production only: preview/stg workers run the same email crons against
				// their own DB branches, so a binding here means every live stage sends
				// its own copy of onboarding/digest/alert emails to real users.
				...(stage.kind === "prd"
					? {
							EMAIL: Cloudflare.Email.SendEmail("email", {
								allowedSenderAddresses: ["notifications@noreply.maple.dev"],
							}),
						}
					: {}),
				TINYBIRD_HOST: requireEnv("TINYBIRD_HOST"),
				TINYBIRD_TOKEN: Redacted.make(requireEnv("TINYBIRD_TOKEN")),
				// Alert-rule evaluation runs Tinybird-scoped raw SQL through
				// TinybirdOrgTokenService, which requires both of these — without them
				// every tick fails with "TINYBIRD_SIGNING_KEY is required for
				// Tinybird-scoped raw SQL" (same bindings as the api worker).
				...optionalSecret("TINYBIRD_SIGNING_KEY"),
				...optionalPlain("TINYBIRD_WORKSPACE_ID"),
				MAPLE_AUTH_MODE: process.env.MAPLE_AUTH_MODE?.trim() || "self_hosted",
				MAPLE_DEFAULT_ORG_ID: process.env.MAPLE_DEFAULT_ORG_ID?.trim() || "default",
				MAPLE_INGEST_KEY_ENCRYPTION_KEY: Redacted.make(requireEnv("MAPLE_INGEST_KEY_ENCRYPTION_KEY")),
				MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: Redacted.make(
					requireEnv("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"),
				),
				MAPLE_INGEST_PUBLIC_URL:
					process.env.MAPLE_INGEST_PUBLIC_URL?.trim() || "https://ingest.maple.dev",
				MAPLE_APP_BASE_URL: process.env.MAPLE_APP_BASE_URL?.trim() || "https://app.maple.dev",
				EMAIL_FROM: process.env.EMAIL_FROM?.trim() || "Maple <notifications@noreply.maple.dev>",
				...optionalPlain("MAPLE_ENDPOINT"),
				...optionalPlain("MAPLE_ENVIRONMENT", resolveDeploymentEnvironment(stage)),
			// Non-prod stages skip all crons (they share live org data via the prod
			// DB); set to "1" on a stage to deliberately exercise crons there.
			...optionalPlain("MAPLE_ALERTING_ALLOW_NONPROD"),
				...optionalPlain("COMMIT_SHA"),
				MAPLE_INGEST_KEY: Redacted.make(requireEnv("MAPLE_OTEL_INGEST_KEY")),
				...optionalSecret("MAPLE_ROOT_PASSWORD"),
				...optionalSecret("CLERK_SECRET_KEY"),
				...optionalPlain("CLERK_PUBLISHABLE_KEY"),
				...optionalSecret("CLERK_JWT_KEY"),
				...optionalSecret("AUTUMN_SECRET_KEY"),
				...optionalSecret("INTERNAL_SERVICE_TOKEN"),
				// Cloudflare integration (account OAuth — Authorization Code + PKCE).
				// The alerting worker runs the cloudflare analytics poller (cloudflareAnalyticsTick
				// → CloudflareAnalyticsService.pollAllOrgs), which resolves + refreshes each org's
				// OAuth token via CloudflareOAuthService and needs the same config as the api worker.
				...optionalPlain("CLOUDFLARE_OAUTH_CLIENT_ID"),
				...optionalSecret("CLOUDFLARE_OAUTH_CLIENT_SECRET"),
				...optionalPlain("CLOUDFLARE_OAUTH_SCOPES"),
				...optionalPlain("CLOUDFLARE_OAUTH_AUTHORIZE_URL"),
				...optionalPlain("CLOUDFLARE_OAUTH_TOKEN_URL"),
				...optionalPlain("CLOUDFLARE_OAUTH_REVOKE_URL"),
				...optionalPlain("MAPLE_CLOUDFLARE_API_BASE_URL"),
				// PlanetScale integration (OAuth application — confidential client). The
				// alerting worker runs the inventory poller (planetScaleTick →
				// PlanetScaleService.pollAllOrgs), which resolves + refreshes each org's
				// OAuth token via PlanetScaleOAuthService and needs the same config as
				// the api worker.
				...optionalPlain("PLANETSCALE_OAUTH_CLIENT_ID"),
				...optionalSecret("PLANETSCALE_OAUTH_CLIENT_SECRET"),
				...optionalPlain("PLANETSCALE_OAUTH_AUTHORIZE_URL"),
				...optionalPlain("PLANETSCALE_OAUTH_TOKEN_URL"),
				...optionalPlain("MAPLE_PLANETSCALE_API_BASE_URL"),
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
