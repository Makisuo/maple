import path from "node:path"
import * as Cloudflare from "alchemy/Cloudflare"
import type { Rpc } from "alchemy/Rpc"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { MapleApiRpcShape } from "@maple/domain/internal-rpc"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
import {
	CLOUDFLARE_WORKER_PLACEMENT,
	formatMapleStage,
	resolveDeploymentEnvironment,
	resolveHyperdriveName,
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

export interface CreateMapleApiOptions {
	stage: MapleStage
	domains: MapleDomains
}

/** Alchemy resource type carried across the chat-flue service binding. */
export type MapleApiWorker = Cloudflare.Worker & Rpc<MapleApiRpcShape>

export const createMapleApi = ({ stage, domains }: CreateMapleApiOptions) =>
	Effect.gen(function* () {
		// MAPLE_DB Hyperdrive comes in two flavors:
		//
		// - stg/prd bind a DASHBOARD-MANAGED config by ID (v1's `HyperdriveRef`,
		//   which v2 lacks — the binding is attached as raw `{ type: "hyperdrive",
		//   id }` metadata after the Worker exists, see below). Origin/credentials
		//   live only in the Cloudflare dashboard; deploys never see them and
		//   MAPLE_PG_URL is not required.
		//
		// - pr/dev stages get an alchemy-MANAGED per-branch Hyperdrive whose origin
		//   is pushed from MAPLE_PG_URL (a standard Postgres connection string,
		//   direct port 5432) — the same env var the CI `drizzle-kit migrate` step
		//   + import scripts use. Cloudflare Hyperdrive needs a STRUCTURED origin
		//   (discrete host/user/…), not a URL, so we parse it here. Schema
		//   migrations run in CI before deploy, never at boot.
		const hyperdriveRefId = resolveHyperdriveRefId(stage)
		const mapleDb = hyperdriveRefId
			? undefined
			: yield* Effect.gen(function* () {
					const pgUrl = new URL(requireEnv("MAPLE_PG_URL"))
					return yield* Cloudflare.Hyperdrive.Connection("maple-db", {
						name: resolveHyperdriveName(stage),
						origin: {
							scheme: "postgres",
							host: pgUrl.hostname,
							port: Number(pgUrl.port || "5432"),
							// Connect-time db (`postgres`, the PlanetScale cluster default),
							// not the PS resource name.
							database: pgUrl.pathname.replace(/^\//, "") || "postgres",
							user: decodeURIComponent(pgUrl.username),
							password: Redacted.make(decodeURIComponent(pgUrl.password)),
						},
						// Read-after-write everywhere (alert state CAS, dashboard versioning) —
						// revisit caching once read paths that tolerate staleness are identified.
						caching: { disabled: true },
						dev: {
							scheme: "postgres",
							host: "localhost",
							port: 5499,
							database: "maple",
							user: "maple",
							password: Redacted.make("maple"),
						},
					})
				})

		const mcpSessions = yield* Cloudflare.KV.Namespace("MCP_SESSIONS", {
			title: resolveWorkerName("mcp-sessions", stage),
		})

		// Long-running schema-apply: chunks heavy backfill migrations across durable
		// steps so they never hit the Worker request budget. Class is exported from
		// src/worker.ts. The first Workflow arg IS the physical workflow name; the
		// api worker hosts it (no scriptName), so alchemy registers it after deploy.
		const schemaApplyWorkflow = Cloudflare.Workflow<{ orgId: string }>(
			resolveWorkerName("schema-apply", stage),
			{ className: "ClickHouseSchemaApplyWorkflow" },
		)

		// Headless AI triage agent: investigates freshly opened incidents (error or
		// anomaly) with read-only tools and writes a structured summary back to the
		// run row. Class is exported from src/worker.ts.
		const aiTriageWorkflow = Cloudflare.Workflow<{
			orgId: string
			incidentKind: string
			incidentId: string
			issueId?: string
			runId: string
		}>(resolveWorkerName("ai-triage", stage), { className: "AiTriageWorkflow" })

		// Vendor-agnostic VCS sync queue (commit backfill + webhook deltas). The same
		// `api` worker is both producer (binding) and consumer (Queues.Consumer
		// below). Local dev is wired separately in wrangler.jsonc so miniflare runs
		// it in-process.
		const vcsSyncQueue = yield* Cloudflare.Queues.Queue("vcs-sync", {
			name: resolveWorkerName("vcs-sync", stage),
		})

		const worker = (yield* Cloudflare.Worker("api", {
			name: resolveWorkerName("api", stage),
			main: path.join(import.meta.dirname, "src", "worker.ts"),
			compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
			placement: CLOUDFLARE_WORKER_PLACEMENT,
			url: true,
			// Custom domain (not a zone route): routes don't create DNS records, so
			// pr-stage hostnames would be authoritative NXDOMAIN. Custom domains
			// provision DNS + edge certs automatically.
			domain: domains.api,
			// Periodic VCS sync backstop (every 12h) — enqueues a refresh per installation; see worker.ts `scheduled`.
			crons: ["0 */12 * * *"],
			env: {
				// Ref stages attach MAPLE_DB via worker.bind below.
				...(mapleDb ? { MAPLE_DB: mapleDb } : {}),
				MCP_SESSIONS: mcpSessions,
				VCS_SYNC_QUEUE: vcsSyncQueue,
				CLICKHOUSE_SCHEMA_APPLY_WORKFLOW: schemaApplyWorkflow,
				AI_TRIAGE_WORKFLOW: aiTriageWorkflow,
				API_V2_RATE_LIMITER: Cloudflare.RateLimit("API_V2_RATE_LIMITER", {
					namespaceId: 2026071801,
					simple: { limit: 600, period: 60 },
				}),
				CLI_AUTH_RATE_LIMITER: Cloudflare.RateLimit("CLI_AUTH_RATE_LIMITER", {
					namespaceId: 2026072101,
					simple: { limit: 30, period: 60 },
				}),
				MCP_OAUTH_RATE_LIMITER: Cloudflare.RateLimit("MCP_OAUTH_RATE_LIMITER", {
					namespaceId: 2026072102,
					simple: { limit: 60, period: 60 },
				}),
				API_V2_RATE_LIMIT_PARTITION: formatMapleStage(stage),
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
				...optionalSecret("TINYBIRD_SIGNING_KEY"),
				...optionalPlain("TINYBIRD_WORKSPACE_ID"),
				...optionalPlain("CLICKHOUSE_URL"),
				CLICKHOUSE_PROVIDER: process.env.CLICKHOUSE_PROVIDER?.trim() || "tinybird",
				...optionalPlain("CLICKHOUSE_USER"),
				...optionalPlain("CLICKHOUSE_DATABASE"),
				...optionalSecret("CLICKHOUSE_PASSWORD"),
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
				// Bucket-cache knobs: on by default in deployed stages. Override via
				// deploy-time env (e.g. `QE_BUCKET_CACHE_ENABLED=false`) if needed.
				QE_BUCKET_CACHE_ENABLED: process.env.QE_BUCKET_CACHE_ENABLED?.trim() || "true",
				QE_BUCKET_CACHE_TTL_SECONDS: process.env.QE_BUCKET_CACHE_TTL_SECONDS?.trim() || "86400",
				QE_BUCKET_CACHE_FLUX_SECONDS: process.env.QE_BUCKET_CACHE_FLUX_SECONDS?.trim() || "60",
				QE_BUCKET_CACHE_SEGMENT_BUCKETS: process.env.QE_BUCKET_CACHE_SEGMENT_BUCKETS?.trim() || "120",
				QE_BUCKET_CACHE_READ_CONCURRENCY:
					process.env.QE_BUCKET_CACHE_READ_CONCURRENCY?.trim() || "16",
				EDGE_CACHE_READ_TIMEOUT_MS: process.env.EDGE_CACHE_READ_TIMEOUT_MS?.trim() || "250",
				SERVICE_OPERATIONS_ROLLUP_ENABLED:
					process.env.SERVICE_OPERATIONS_ROLLUP_ENABLED?.trim() || "false",
				...optionalPlain("MAPLE_ENDPOINT"),
				...optionalPlain("MAPLE_ENVIRONMENT", resolveDeploymentEnvironment(stage)),
				...optionalPlain("COMMIT_SHA"),
				MAPLE_INGEST_KEY: Redacted.make(requireEnv("MAPLE_OTEL_INGEST_KEY")),
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
				// PlanetScale integration (OAuth application — confidential client, no PKCE)
				...optionalPlain("PLANETSCALE_OAUTH_CLIENT_ID"),
				...optionalSecret("PLANETSCALE_OAUTH_CLIENT_SECRET"),
				...optionalPlain("PLANETSCALE_OAUTH_AUTHORIZE_URL"),
				...optionalPlain("PLANETSCALE_OAUTH_TOKEN_URL"),
				...optionalPlain("PLANETSCALE_OAUTH_TOKEN_INFO_URL"),
				...optionalPlain("MAPLE_PLANETSCALE_API_BASE_URL"),
			},
		})) as MapleApiWorker

		if (hyperdriveRefId) {
			// v1 `HyperdriveRef` equivalent: bind the dashboard-managed config by ID
			// as raw binding metadata (same mechanism the env binder uses). No cloud
			// resource is created and the origin credentials stay in the dashboard.
			yield* worker.bind("MAPLE_DB", {
				bindings: [{ type: "hyperdrive", name: "MAPLE_DB", id: hyperdriveRefId }],
			})
		}

		// Attach the api worker as the vcs-sync queue consumer (v1 `eventSources`).
		yield* Cloudflare.Queues.Consumer("vcs-sync-consumer", {
			queueId: vcsSyncQueue.queueId,
			scriptName: worker.workerName,
			settings: {
				batchSize: 10,
				maxConcurrency: 2,
				maxRetries: 3,
				maxWaitTimeMs: 5000,
			},
		})

		// `db` is undefined on ref stages — alerting resolves the same ref itself.
		return { worker, db: mapleDb }
	})
