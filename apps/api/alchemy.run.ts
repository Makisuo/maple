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
	resolveDatabaseMode,
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

/** Alchemy resource type for the API Worker, carrying its internal RPC surface. */
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
		// - dev stages get an alchemy-MANAGED Hyperdrive whose origin is pushed
		//   from MAPLE_PG_URL (a standard Postgres connection string, direct port
		//   5432) — the same env var the CI `drizzle-kit migrate` step + import
		//   scripts use. Cloudflare Hyperdrive needs a STRUCTURED origin (discrete
		//   host/user/…), not a URL, so we parse it here. Schema migrations run in
		//   CI before deploy, never at boot.
		//
		// - pr previews get NO database binding at all (resolveDatabaseMode →
		//   "none"): PlanetScale PR branches are no longer provisioned. The worker
		//   still boots and serves — DatabasePgLive fails per query instead of
		//   dying — so DB-backed routes 500 while everything else works.
		const databaseMode = resolveDatabaseMode(stage)
		const hyperdriveRefId = resolveHyperdriveRefId(stage)
		const mapleDb =
			databaseMode !== "managed"
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

		// Fan-out investigation: N lens agents in parallel, then a validator that
		// promotes one cause and records why each rival lost. Class is exported from
		// src/worker.ts.
		const investigationFanoutWorkflow = Cloudflare.Workflow<{
			orgId: string
			investigationId: string
			maxWidth: number
			reservedPasses: number
			attempt: number
		}>(resolveWorkerName("investigation-fanout", stage), {
			className: "InvestigationFanoutWorkflow",
		})

		// Durable chat transcripts, one Durable Object per "<orgId>:<tabId>". v2 provisions new
		// DO classes as SQLite-backed by default. Class is exported from src/worker.ts.
		const chatSession = Cloudflare.DurableObject("chat-session", { className: "ChatSession" })

		// Vendor-agnostic VCS sync queue (commit backfill + webhook deltas). The same
		// `api` worker is both producer (binding) and consumer (Queues.Consumer
		// below). Local dev is wired separately in wrangler.jsonc so miniflare runs
		// it in-process.
		const vcsSyncQueueName = resolveWorkerName("vcs-sync", stage)
		const vcsSyncQueue = yield* Cloudflare.Queues.Queue("vcs-sync", {
			name: vcsSyncQueueName,
		})
		const planetScaleWebhookQueueName = resolveWorkerName("planetscale-webhooks", stage)
		const planetScaleWebhookQueue = yield* Cloudflare.Queues.Queue("planetscale-webhooks", {
			name: planetScaleWebhookQueueName,
		})

		// Session-replay rrweb payloads. The ingest gateway (a Railway container,
		// not a Worker) writes these over the S3 API with SigV4; this binding is
		// the read side, hydrating `session_replay_events` rows whose `Events` is
		// empty. Stage-isolated, so a pr/stg deploy can never serve or overwrite
		// prd recordings.
		//
		// The 32-day expiry is deliberately LONGER than the table's 30-day TTL:
		// the row must disappear before the object does. The other way round
		// leaves a session that lists as recorded but plays back empty, which is
		// the one failure mode with no good client-side handling.
		const replayBlobs = yield* Cloudflare.R2.Bucket("replay-blobs", {
			name: resolveWorkerName("replay-blobs", stage),
			// Deliberately unprefixed, so the rule covers whatever key scheme is
			// current. `replay_object_key` is versioned (`v1/…`) precisely so a
			// format change can write under a new prefix while the old one ages
			// out — a rule pinned to `v1/` would silently stop expiring anything
			// the moment that happens, and the bucket would grow forever with no
			// failing test to catch it. Nothing else writes here.
			lifecycleRules: [
				{
					id: "expire-replay-chunks",
					enabled: true,
					deleteObjectsTransition: { condition: { type: "Age", maxAge: 32 * 24 * 60 * 60 } },
				},
			],
		})

		const worker = (yield* Cloudflare.Worker("api", {
			name: resolveWorkerName("api", stage),
			main: path.join(import.meta.dirname, "src", "worker.ts"),
			compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
			placement: CLOUDFLARE_WORKER_PLACEMENT,
			workersDev: true,
			// Custom domain (not a zone route): routes don't create DNS records, so
			// pr-stage hostnames would be authoritative NXDOMAIN. Custom domains
			// provision DNS + edge certs automatically.
			domain: domains.api,
			// Dispatched on `event.cron` in worker.ts `scheduled`:
			//   every 12h — VCS sync backstop, enqueues a refresh per installation
			//   hourly    — scrape_target_checks retention (was inline on the
			//               scrape-results write path; a busy target writes ~75k
			//               rows/day, so the 10k cap binds within hours)
			//   every 6h  — Slack workspace reconciliation: backstop for
			//               SlackEventsRouter (app_uninstalled/tokens_revoked), which
			//               catches deliveries Slack never sent/retried through, or
			//               installs that predate the webhook
			crons: ["0 */12 * * *", "0 * * * *", "0 */6 * * *"],
			env: {
				// Ref stages attach MAPLE_DB via worker.bind below.
				...(mapleDb ? { MAPLE_DB: mapleDb } : {}),
				// Workers AI (`env.AI`, the v1 `Ai()` binding), driving the AI-triage agent on
				// `@maple/llm`. v2 emits the `{ type: "ai" }` binding by attaching an AI Gateway
				// resource, which also fronts model calls with caching/rate-limits/logging.
				// NOTE: the deploy token needs the account-level "AI Gateway: Edit" permission
				// for this resource.
				AI: Cloudflare.AI.Gateway("maple-api-ai"),
				CHAT_SESSION: chatSession,
				MCP_SESSIONS: mcpSessions,
				// Read side of the replay payload store; absent bindings degrade to
				// inline-only hydration (see platform/ReplayBlobStore.ts).
				REPLAY_BLOBS: replayBlobs,
				VCS_SYNC_QUEUE: vcsSyncQueue,
				VCS_SYNC_QUEUE_NAME: vcsSyncQueueName,
				PLANETSCALE_WEBHOOK_QUEUE: planetScaleWebhookQueue,
				PLANETSCALE_WEBHOOK_QUEUE_NAME: planetScaleWebhookQueueName,
				CLICKHOUSE_SCHEMA_APPLY_WORKFLOW: schemaApplyWorkflow,
				INVESTIGATION_FANOUT_WORKFLOW: investigationFanoutWorkflow,
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
				...optionalPlain("TINYBIRD_RAW_SQL_JWT_RPS_LIMIT"),
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
				// Both of the next two knobs are bounded by Cloudflare's
				// six-simultaneous-connection limit, which `cache.match()` counts
				// against while it waits for response headers. Keep the deploy-time
				// values in step with the reasoning in `bucket-cache.ts` and
				// `edge-cache.ts` — a stale override here silently defeats a tuned
				// default, which is exactly what happened when these were pinned to
				// 16/250 and the code defaults moved to 6/40 underneath them.
				QE_BUCKET_CACHE_READ_CONCURRENCY: process.env.QE_BUCKET_CACHE_READ_CONCURRENCY?.trim() || "6",
				EDGE_CACHE_READ_TIMEOUT_MS: process.env.EDGE_CACHE_READ_TIMEOUT_MS?.trim() || "40",
				...optionalPlain("MAPLE_ENDPOINT"),
				// Derived from the stage, deliberately NOT `optionalPlain` — that helper
				// lets `process.env` win over the fallback, so a stray
				// MAPLE_ENVIRONMENT=production in a pr-N deploy environment would open
				// EmailService.emailAllowed on a stage that shares live org data.
				MAPLE_ENVIRONMENT: resolveDeploymentEnvironment(stage),
				...optionalPlain("COMMIT_SHA"),
				MAPLE_INGEST_KEY: Redacted.make(requireEnv("MAPLE_OTEL_INGEST_KEY")),
				// Agent LLM path. `MAPLE_LLM_PROVIDER` flips between OpenRouter (default) and
				// Workers AI; both stay wired, so a switch is this one var plus a redeploy.
				// See `@/platform/Llm` for the provider-scoped model overrides.
				...optionalPlain("MAPLE_LLM_PROVIDER"),
				...optionalPlain("MAPLE_TRIAGE_MODEL_OPENROUTER"),
				...optionalPlain("MAPLE_TRIAGE_MODEL_WORKERS_AI"),
				...optionalSecret("OPENROUTER_API_KEY"),
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
				// Slack integration (bot install via OAuth v2)
				...optionalPlain("SLACK_CLIENT_ID"),
				...optionalSecret("SLACK_CLIENT_SECRET"),
				...optionalSecret("SLACK_INTERNAL_SERVICE_TOKEN"),
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
		yield* Cloudflare.Queues.Consumer("planetscale-webhooks-consumer", {
			queueId: planetScaleWebhookQueue.queueId,
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
