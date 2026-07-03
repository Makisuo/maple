import path from "node:path"
import alchemy from "alchemy"
import { EmailSender, Worker, Workflow, type Hyperdrive } from "alchemy/cloudflare"
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

const optionalSecret = (key: string): Record<string, ReturnType<typeof alchemy.secret>> => {
	const value = process.env[key]?.trim()
	return value ? { [key]: alchemy.secret(value) } : {}
}

export interface CreateAlertingWorkerOptions {
	stage: MapleStage
	domains: MapleDomains
	mapleDb: Hyperdrive
}

export const createAlertingWorker = async ({ stage, mapleDb }: CreateAlertingWorkerOptions) => {
	// Cross-script binding to the AI triage Workflow hosted by the api worker —
	// the error/anomaly ticks enqueue triage runs when incidents open.
	const aiTriageWorkflow = Workflow<{
		orgId: string
		incidentKind: string
		incidentId: string
		issueId?: string
		runId: string
	}>("ai-triage-workflow", {
		workflowName: resolveWorkerName("ai-triage", stage),
		className: "AiTriageWorkflow",
		scriptName: resolveWorkerName("api", stage),
	})

	const worker = await Worker("alerting", {
		name: resolveWorkerName("alerting", stage),
		cwd: import.meta.dirname,
		entrypoint: path.join(import.meta.dirname, "src", "worker.ts"),
		compatibility: "node",
		compatibilityDate: "2026-04-08",
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		adopt: true,
		crons: ["* * * * *", "*/5 * * * *", "*/15 * * * *", "0 * * * *", "0 9 * * *"],
		bindings: {
			MAPLE_DB: mapleDb,
			AI_TRIAGE_WORKFLOW: aiTriageWorkflow,
			EMAIL: EmailSender({
				allowedSenderAddresses: ["notifications@noreply.maple.dev"],
				dev: { remote: true },
			}),
			TINYBIRD_HOST: requireEnv("TINYBIRD_HOST"),
			TINYBIRD_TOKEN: alchemy.secret(requireEnv("TINYBIRD_TOKEN")),
			MAPLE_AUTH_MODE: process.env.MAPLE_AUTH_MODE?.trim() || "self_hosted",
			MAPLE_DEFAULT_ORG_ID: process.env.MAPLE_DEFAULT_ORG_ID?.trim() || "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: alchemy.secret(requireEnv("MAPLE_INGEST_KEY_ENCRYPTION_KEY")),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: alchemy.secret(requireEnv("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY")),
			MAPLE_INGEST_PUBLIC_URL:
				process.env.MAPLE_INGEST_PUBLIC_URL?.trim() || "https://ingest.maple.dev",
			MAPLE_APP_BASE_URL: process.env.MAPLE_APP_BASE_URL?.trim() || "https://app.maple.dev",
			EMAIL_FROM: process.env.EMAIL_FROM?.trim() || "Maple <notifications@noreply.maple.dev>",
			...optionalPlain("MAPLE_ENDPOINT"),
			...optionalPlain("MAPLE_ENVIRONMENT", resolveDeploymentEnvironment(stage)),
			...optionalPlain("COMMIT_SHA"),
			MAPLE_INGEST_KEY: alchemy.secret(requireEnv("MAPLE_OTEL_INGEST_KEY")),
			...optionalSecret("MAPLE_ROOT_PASSWORD"),
			...optionalSecret("CLERK_SECRET_KEY"),
			...optionalPlain("CLERK_PUBLISHABLE_KEY"),
			...optionalSecret("CLERK_JWT_KEY"),
			...optionalSecret("AUTUMN_SECRET_KEY"),
			...optionalSecret("INTERNAL_SERVICE_TOKEN"),
		},
	})

	return worker
}
