import path from "node:path"
import alchemy from "alchemy"
import {
	EmailSender,
	Hyperdrive,
	HyperdriveRef,
	KVNamespace,
	Queue,
	Worker,
	WorkerStub,
	Workflow,
} from "alchemy/cloudflare"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
import {
	CLOUDFLARE_WORKER_PLACEMENT,
	resolveDeploymentEnvironment,
	resolveHyperdriveName,
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

// Managed Hyperdrive for non-prod stages (stg / per-PR preview / local dev): the
// origin is pushed from MAPLE_PG_URL (a standard Postgres connection string, direct
// port 5432) — the same env var the CI `drizzle-kit migrate` step + import scripts
// use. Cloudflare Hyperdrive needs a STRUCTURED origin (discrete host/user/…), not a
// URL, so we parse it here. Schema migrations run in CI before deploy, never at boot.
const makeManagedHyperdrive = (stage: MapleStage) => {
	const pgUrl = new URL(requireEnv("MAPLE_PG_URL"))
	return Hyperdrive("maple-db", {
		name: resolveHyperdriveName(stage),
		adopt: true,
		origin: {
			host: pgUrl.hostname,
			port: Number(pgUrl.port || "5432"),
			// Connect-time db (`postgres`, the PlanetScale cluster default), not the
			// PS resource name.
			database: pgUrl.pathname.replace(/^\//, "") || "postgres",
			user: decodeURIComponent(pgUrl.username),
			password: alchemy.secret(decodeURIComponent(pgUrl.password)),
		},
		// Read-after-write everywhere (alert state CAS, dashboard versioning) —
		// revisit caching once read paths that tolerate staleness are identified.
		caching: { disabled: true },
		dev: {
			origin: {
				host: "localhost",
				port: 5499,
				database: "maple",
				user: "maple",
				password: "maple",
			},
		},
	})
}

export interface CreateMapleApiOptions {
	stage: MapleStage
	domains: MapleDomains
}

export const createMapleApi = async ({ stage, domains }: CreateMapleApiOptions) => {
	// Prod binds to the PRE-CONFIGURED Hyperdrive `maple-prd` — its origin and
	// credentials are managed directly in the Cloudflare dashboard, NOT pushed
	// from MAPLE_PG_URL. Reference it by name so a deploy never rewrites (or needs
	// to know) the prod database connection. Other stages manage their own
	// Hyperdrive from MAPLE_PG_URL below.
	const mapleDb =
		stage.kind === "prd"
			? await HyperdriveRef({ name: resolveHyperdriveName(stage) })
			: await makeManagedHyperdrive(stage)

	const mcpSessions = await KVNamespace("MCP_SESSIONS", {
		title: resolveWorkerName("mcp-sessions", stage),
		adopt: true,
	})

	// Long-running schema-apply: chunks heavy backfill migrations across durable
	// steps so they never hit the Worker request budget. Class is exported from
	// src/worker.ts.
	const schemaApplyWorkflow = Workflow<{ orgId: string }>("clickhouse-schema-apply-workflow", {
		workflowName: resolveWorkerName("schema-apply", stage),
		className: "ClickHouseSchemaApplyWorkflow",
	})

	// Headless AI triage agent: investigates freshly opened incidents (error or
	// anomaly) with read-only tools and writes a structured summary back to the
	// run row. Class is exported from src/worker.ts.
	const aiTriageWorkflow = Workflow<{
		orgId: string
		incidentKind: string
		incidentId: string
		issueId?: string
		runId: string
	}>("ai-triage-workflow", {
		workflowName: resolveWorkerName("ai-triage", stage),
		className: "AiTriageWorkflow",
	})

	// Vendor-agnostic VCS sync queue (commit backfill + webhook deltas). The same
	// `api` worker is both producer (binding) and consumer (eventSources). Local
	// dev is wired separately in wrangler.jsonc so miniflare runs it in-process.
	const vcsSyncQueue = await Queue("vcs-sync", {
		name: resolveWorkerName("vcs-sync", stage),
		adopt: true,
	})

	// Service binding to the chat-flue worker that hosts the Flue `triage`
	// workflow (the AI triage agent's investigation step). chat-flue is created
	// AFTER api in the root alchemy.run.ts (it needs api's URL), so a plain
	// service-binding ref to its name fails the api upload with CF error 10143
	// ("references Worker ... which was not found"). Reserve the name with an
	// empty WorkerStub first; chat-flue's real deploy adopts it (adopt: true).
	// This breaks the api↔chat-flue cycle without a URL dependency.
	const chatFlue = await WorkerStub("chat-flue-stub", {
		name: resolveWorkerName("chat-flue", stage),
		url: false,
	})

	const worker = await Worker("api", {
		name: resolveWorkerName("api", stage),
		cwd: import.meta.dirname,
		entrypoint: path.join(import.meta.dirname, "src", "worker.ts"),
		compatibility: "node",
		compatibilityDate: "2026-04-08",
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		url: true,
		adopt: true,
		routes: domains.api ? [{ pattern: `${domains.api}/*`, adopt: true }] : undefined,
		// Periodic VCS sync backstop (every 12h) — enqueues a refresh per installation; see worker.ts `scheduled`.
		crons: ["0 */12 * * *"],
		eventSources: [
			{
				queue: vcsSyncQueue,
				settings: {
					batchSize: 10,
					maxConcurrency: 2,
					maxRetries: 3,
					maxWaitTimeMs: 5000,
				},
			},
		],
		bindings: {
			MAPLE_DB: mapleDb,
			MCP_SESSIONS: mcpSessions,
			VCS_SYNC_QUEUE: vcsSyncQueue,
			CLICKHOUSE_SCHEMA_APPLY_WORKFLOW: schemaApplyWorkflow,
			AI_TRIAGE_WORKFLOW: aiTriageWorkflow,
			CHAT_FLUE: chatFlue,
			EMAIL: EmailSender({
				allowedSenderAddresses: ["notifications@noreply.maple.dev"],
				dev: { remote: true },
			}),
			TINYBIRD_HOST: requireEnv("TINYBIRD_HOST"),
			TINYBIRD_TOKEN: alchemy.secret(requireEnv("TINYBIRD_TOKEN")),
			...optionalPlain("CLICKHOUSE_URL"),
			...optionalPlain("CLICKHOUSE_USER"),
			...optionalPlain("CLICKHOUSE_DATABASE"),
			...optionalSecret("CLICKHOUSE_PASSWORD"),
			MAPLE_AUTH_MODE: process.env.MAPLE_AUTH_MODE?.trim() || "self_hosted",
			MAPLE_DEFAULT_ORG_ID: process.env.MAPLE_DEFAULT_ORG_ID?.trim() || "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: alchemy.secret(requireEnv("MAPLE_INGEST_KEY_ENCRYPTION_KEY")),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: alchemy.secret(requireEnv("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY")),
			MAPLE_INGEST_PUBLIC_URL:
				process.env.MAPLE_INGEST_PUBLIC_URL?.trim() || "https://ingest.maple.dev",
			MAPLE_APP_BASE_URL: process.env.MAPLE_APP_BASE_URL?.trim() || "https://app.maple.dev",
			EMAIL_FROM: process.env.EMAIL_FROM?.trim() || "Maple <notifications@noreply.maple.dev>",
			// Bucket-cache knobs: on by default in deployed stages. Override via
			// deploy-time env (e.g. `QE_BUCKET_CACHE_ENABLED=false`) if needed.
			QE_BUCKET_CACHE_ENABLED: process.env.QE_BUCKET_CACHE_ENABLED?.trim() || "true",
			QE_BUCKET_CACHE_TTL_SECONDS: process.env.QE_BUCKET_CACHE_TTL_SECONDS?.trim() || "86400",
			QE_BUCKET_CACHE_FLUX_SECONDS: process.env.QE_BUCKET_CACHE_FLUX_SECONDS?.trim() || "60",
			...optionalPlain("MAPLE_ENDPOINT"),
			...optionalPlain("MAPLE_ENVIRONMENT", resolveDeploymentEnvironment(stage)),
			...optionalPlain("COMMIT_SHA"),
			MAPLE_INGEST_KEY: alchemy.secret(requireEnv("MAPLE_OTEL_INGEST_KEY")),
			...optionalSecret("MAPLE_ROOT_PASSWORD"),
			...optionalSecret("CLERK_SECRET_KEY"),
			...optionalPlain("CLERK_PUBLISHABLE_KEY"),
			...optionalSecret("CLERK_JWT_KEY"),
			...optionalSecret("AUTUMN_SECRET_KEY"),
			...optionalSecret("SD_INTERNAL_TOKEN"),
			...optionalSecret("INTERNAL_SERVICE_TOKEN"),
			...optionalPlain("HAZEL_API_BASE_URL"),
			...optionalPlain("HAZEL_OAUTH_DISCOVERY_URL"),
			...optionalPlain("HAZEL_OAUTH_CLIENT_ID"),
			...optionalSecret("HAZEL_OAUTH_CLIENT_SECRET"),
			...optionalPlain("HAZEL_OAUTH_SCOPES"),
			...optionalPlain("GITHUB_APP_ID"),
			...optionalPlain("GITHUB_APP_SLUG"),
			...optionalSecret("GITHUB_APP_PRIVATE_KEY"),
			...optionalPlain("GITHUB_APP_CLIENT_ID"),
			...optionalSecret("GITHUB_APP_CLIENT_SECRET"),
			...optionalSecret("GITHUB_APP_WEBHOOK_SECRET"),
			...optionalPlain("GITHUB_API_BASE_URL"),
			// Cloudflare integration (account OAuth — Authorization Code + PKCE)
			...optionalPlain("CLOUDFLARE_OAUTH_CLIENT_ID"),
			...optionalSecret("CLOUDFLARE_OAUTH_CLIENT_SECRET"),
			...optionalPlain("CLOUDFLARE_OAUTH_SCOPES"),
			...optionalPlain("CLOUDFLARE_OAUTH_AUTHORIZE_URL"),
			...optionalPlain("CLOUDFLARE_OAUTH_TOKEN_URL"),
			...optionalPlain("CLOUDFLARE_OAUTH_REVOKE_URL"),
			...optionalPlain("MAPLE_CLOUDFLARE_API_BASE_URL"),
		},
	})

	return { worker, db: mapleDb }
}
