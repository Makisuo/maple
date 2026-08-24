import { createHash } from "node:crypto"
import path from "node:path"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Output from "alchemy/Output"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import type { Rpc } from "alchemy/Rpc"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { MapleApiRpcContract } from "@maple/domain/internal-rpc"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
import {
	CLOUDFLARE_WORKER_PLACEMENT,
	formatMapleStage,
	resolveDatabaseMode,
	resolveHyperdriveName,
	resolveHyperdriveRefId,
	resolveWorkerName,
} from "@maple/infra/cloudflare"
import { stageEnablesReplayBlobs } from "@maple/infra/aws"
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
	plainWithDefault,
	requiredPlain,
	requireSecretEntry,
	selfObservabilityEnv,
	tinybirdEnv,
} from "@maple/infra/env"

export interface CreateMapleApiOptions {
	stage: MapleStage
	domains: MapleDomains
	/** Read side of the replay payload store; see `createReplayBlobStore`. */
	replayBlobs: Cloudflare.R2.Bucket
}

/** R2 credentials for the ingest gateway, when this stage writes replay blobs. */
export interface ReplayBlobCredentials {
	/** Account-scoped S3 endpoint. A plan-time string — the account id is env-supplied. */
	endpoint: string
	bucket: string
	/** The API token's id. Only known after the token exists, hence an Output. */
	accessKeyId: Output.Output<string>
	/** SHA-256 of the token value; see `deriveSecretAccessKey`. */
	secretAccessKey: Output.Output<Redacted.Redacted<string>>
}

/**
 * R2's S3 credentials are not a Cloudflare resource — there is no "create
 * access key" API. They are a rendering of an ordinary API token:
 * the Access Key ID is the token's id, and the Secret Access Key is the
 * SHA-256 of the token's value. Cloudflare documents exactly this, and it is
 * why alchemy has nothing to provision here beyond the token itself.
 */
const deriveSecretAccessKey = (value: Output.Output<Redacted.Redacted<string>>) =>
	Output.map(value, (token) =>
		Redacted.make(createHash("sha256").update(Redacted.value(token)).digest("hex")),
	)

/**
 * The session-replay payload store: one R2 bucket, plus (on stages that write)
 * a bucket-scoped API token for the ingest gateway.
 *
 * Lives here rather than inside `createMapleApi` because it has two consumers in
 * two clouds — the api Worker reads it over the native binding, and the Rust
 * gateway on ECS writes it over the S3 API. The gateway stack is constructed
 * FIRST in the root stack, so this has to be hoisted above both of them.
 */
export const createReplayBlobStore = ({ stage }: { stage: MapleStage }) =>
	Effect.gen(function* () {
		const bucketName = resolveWorkerName("replay-blobs", stage)

		// Session-replay rrweb payloads. The ingest gateway (a Rust service on ECS
		// Fargate, not a Worker) writes these over the S3 API with SigV4; the api
		// Worker binds the same bucket to hydrate `session_replay_events` rows
		// whose `Events` is empty. Stage-isolated, so a pr/stg deploy can never
		// serve or overwrite prd recordings.
		//
		// The 32-day expiry is deliberately LONGER than the table's 30-day TTL:
		// the row must disappear before the object does. The other way round
		// leaves a session that lists as recorded but plays back empty, which is
		// the one failure mode with no good client-side handling.
		// NO `locationHint`. It is tempting — the gateway runs in us-east-1 and the
		// bucket sits in `wnam`, so every PUT takes a cross-continent hop on a
		// synchronous write path. It was tried on 2026-08-24 and must not be tried
		// again this way, for two independent reasons:
		//
		//  1. It did not work. R2 treats the hint as advisory; the bucket came back
		//     `wnam` regardless, so the hop is still there and nothing was gained.
		//  2. Changing it is a REPLACE, and `name` is pinned, so both generations
		//     claim the same bucket. Alchemy replaces create-first and the R2
		//     provider sets no `deleteFirst`, so garbage collection then deletes the
		//     surviving bucket by name. It only failed safe because the gateway had
		//     already written objects into it and R2 refused with `BucketNotEmpty` —
		//     which took the prd deploy red instead of destroying recordings.
		//
		// If colocation is ever worth pursuing, do it as a NEW bucket under a new
		// name with a dual-read window, never as a replace of this one.
		const bucket = yield* Cloudflare.R2.Bucket("replay-blobs", {
			name: bucketName,
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
			// This bucket holds customer session recordings; no stack operation
			// should ever be able to delete it. `retain` also drains the old
			// generation of a replacement from state WITHOUT issuing the physical
			// delete (`retainOldGeneration` in alchemy's `collectGarbage`), which is
			// what unwedges a half-applied replace — see the note above.
		}).pipe(RemovalPolicy.retain())

		if (!stageEnablesReplayBlobs(stage)) {
			// Bucket still exists and stays bound, so any objects written before the
			// gate closed keep playing back. The gateway just has no credentials and
			// falls back to storing payloads inline.
			return { bucket, credentials: undefined }
		}

		// Plan-time, not an Output: it keys the policy's `resources` map below and
		// builds the endpoint string, neither of which can take a lazy value. The
		// root stack normalizes CLOUDFLARE_DEFAULT_ACCOUNT_ID onto this name.
		const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
		if (!accountId) {
			throw new Error("CLOUDFLARE_ACCOUNT_ID is required to mint the replay blob store's R2 token.")
		}

		// Bucket-scoped, not account-wide: this credential reaches exactly one
		// bucket and can only write to it. Minting it requires the DEPLOY token to
		// carry the account-level `API Tokens > Write` permission — the same class
		// of prerequisite as the AI Gateway binding below, and it fails the deploy
		// outright rather than degrading.
		const token = yield* Cloudflare.ApiToken.AccountApiToken("replay-blobs-writer", {
			name: `${bucketName}-writer`,
			accountId,
			policies: [
				{
					effect: "allow",
					permissionGroups: ["Workers R2 Storage Bucket Item Write"],
					// `<account>_<jurisdiction>_<bucket>`; `default` is the
					// non-jurisdictional case, which is what `Bucket` creates here.
					resources: {
						[`com.cloudflare.edge.r2.bucket.${accountId}_default_${bucketName}`]: "*",
					},
				},
			],
		})

		return {
			bucket,
			credentials: {
				endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
				bucket: bucketName,
				accessKeyId: Output.asOutput(token.tokenId),
				secretAccessKey: deriveSecretAccessKey(Output.asOutput(token.value)),
			} satisfies ReplayBlobCredentials,
		}
	})

/**
 * Everything in the api worker's env that comes from configuration rather than
 * from a resource. Resolved as one `Config` so a deploy missing several vars
 * reports all of them at once, and so `.env` / `--env-file` reach it — see
 * `@maple/infra/env`.
 */
const apiConfiguredEnv = (stage: MapleStage) =>
	merge(
		tinybirdEnv,
		// ClickHouse (BYO warehouse); `tinybird` unless an org config overrides it.
		optionalPlain("CLICKHOUSE_URL"),
		plainWithDefault("CLICKHOUSE_PROVIDER", "tinybird"),
		optionalPlain("CLICKHOUSE_USER"),
		optionalPlain("CLICKHOUSE_DATABASE"),
		optionalSecret("CLICKHOUSE_PASSWORD"),
		authEnv,
		ingestKeyCryptoEnv,
		requireSecretEntry("MAPLE_SHARE_TOKEN_HMAC_KEY"),
		appUrlsEnv,
		// Bucket-cache knobs: on by default in deployed stages. Override via
		// deploy-time env (e.g. `QE_BUCKET_CACHE_ENABLED=false`) if needed.
		plainWithDefault("QE_BUCKET_CACHE_ENABLED", "true"),
		plainWithDefault("QE_BUCKET_CACHE_TTL_SECONDS", "86400"),
		plainWithDefault("QE_BUCKET_CACHE_FLUX_SECONDS", "60"),
		plainWithDefault("QE_BUCKET_CACHE_SEGMENT_BUCKETS", "120"),
		// Both of the next two knobs are bounded by Cloudflare's
		// six-simultaneous-connection limit, which `cache.match()` counts against
		// while it waits for response headers. Keep the deploy-time values in step
		// with the reasoning in `bucket-cache.ts` and `edge-cache.ts` — a stale
		// override here silently defeats a tuned default, which is exactly what
		// happened when these were pinned to 16/250 and the code defaults moved to
		// 6/40 underneath them.
		plainWithDefault("QE_BUCKET_CACHE_READ_CONCURRENCY", "6"),
		plainWithDefault("EDGE_CACHE_READ_TIMEOUT_MS", "40"),
		// MAPLE_ENDPOINT / MAPLE_ENVIRONMENT / COMMIT_SHA / MAPLE_INGEST_KEY.
		selfObservabilityEnv(stage),
		// Agent LLM path. `MAPLE_LLM_PROVIDER` flips between OpenRouter (default) and
		// Workers AI; both stay wired, so a switch is this one var plus a redeploy.
		// See `@/platform/Llm` for the provider-scoped model overrides.
		optionalPlain("MAPLE_LLM_PROVIDER"),
		optionalPlain("MAPLE_TRIAGE_MODEL_OPENROUTER"),
		optionalPlain("MAPLE_TRIAGE_MODEL_WORKERS_AI"),
		optionalSecret("OPENROUTER_API_KEY"),
		// Svix signing secrets for the public webhook receivers (`/webhooks/clerk`,
		// `/webhooks/autumn`); each route answers 503 until its secret is set.
		optionalSecret("CLERK_WEBHOOK_SECRET"),
		optionalSecret("AUTUMN_WEBHOOK_SECRET"),
		// Server-side product events default to MAPLE_INGEST_KEY; set this only if
		// the funnel should land in a different org than the API's traces.
		optionalSecret("MAPLE_PRODUCT_EVENTS_INGEST_KEY"),
		optionalSecret("AUTUMN_SECRET_KEY"),
		// Billing details (company name, address, tax IDs) are written to the Stripe
		// customer Autumn links; Autumn itself has no API for them.
		optionalSecret("STRIPE_SECRET_KEY"),
		optionalSecret("SD_INTERNAL_TOKEN"),
		optionalSecret("INTERNAL_SERVICE_TOKEN"),
		optionalPlain("HAZEL_API_BASE_URL"),
		optionalPlain("HAZEL_OAUTH_DISCOVERY_URL"),
		optionalPlain("HAZEL_OAUTH_CLIENT_ID"),
		optionalSecret("HAZEL_OAUTH_CLIENT_SECRET"),
		optionalPlain("HAZEL_OAUTH_SCOPES"),
		// Slack integration (bot install via OAuth v2)
		optionalPlain("SLACK_CLIENT_ID"),
		optionalSecret("SLACK_CLIENT_SECRET"),
		optionalSecret("SLACK_INTERNAL_SERVICE_TOKEN"),
		apnsEnv,
		optionalPlain("GITHUB_APP_ID"),
		optionalPlain("GITHUB_APP_SLUG"),
		optionalSecret("GITHUB_APP_PRIVATE_KEY"),
		optionalPlain("GITHUB_APP_CLIENT_ID"),
		optionalSecret("GITHUB_APP_CLIENT_SECRET"),
		optionalSecret("GITHUB_APP_WEBHOOK_SECRET"),
		optionalPlain("GITHUB_API_BASE_URL"),
		cloudflareOAuthEnv,
		planetScaleOAuthEnv,
	)

/** Alchemy resource type for the API Worker, carrying its internal RPC surface. */
export type MapleApiWorker = Cloudflare.Worker & Rpc<MapleApiRpcContract>

const createManagedMapleDb = Effect.fnUntraced(function* (stage: MapleStage) {
	const pgUrl = new URL(yield* requiredPlain("MAPLE_PG_URL"))
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

export const createMapleApi = ({ stage, domains, replayBlobs }: CreateMapleApiOptions) =>
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
		const hyperdriveRefId = resolveHyperdriveRefId(stage, "api")
		const mapleDb = databaseMode !== "managed" ? undefined : yield* createManagedMapleDb(stage)

		// Resolved before any resource is created, so a misconfigured deploy fails
		// with the full list of missing vars rather than part-way through applying.
		const configuredEnv = yield* apiConfiguredEnv(stage)

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

		const worker = (yield* Cloudflare.Worker("api", {
			name: resolveWorkerName("api", stage),
			main: path.join(import.meta.dirname, "src", "worker.ts"),
			compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
			placement: CLOUDFLARE_WORKER_PLACEMENT,
			workersDev: true,
			// alchemy ≥ beta.70 sets rolldown `strictExecutionOrder: true`, which wraps
			// ~every chunk in a lazy `__esmMin` initializer. The DB module graph (drizzle
			// pgTable schemas + Effect Schema ASTs) then evaluates on first use — inside
			// the first Postgres call of each fresh isolate — instead of at script
			// startup. That is what stepped the cold dial from ~2s to ~9-11s on
			// 2026-08-08 (deploy 2679ba80) and produced the CONNECT_TIMEOUT incident;
			// see the 2026-08-11 investigation. Eager evaluation moves that cost back to
			// script startup, off the request path. If chunking ever regresses into
			// upstream #749 (`ScriptStartupError: Cannot access '<minified>' before
			// initialization`), the deploy fails loudly at upload — remove this override
			// and instead warm the DB graph off the request path.
			build: { output: { strictExecutionOrder: false } },
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
				...(mapleDb ? { MAPLE_DB: mapleDb } : undefined),
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
					: undefined),
				...configuredEnv,
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
