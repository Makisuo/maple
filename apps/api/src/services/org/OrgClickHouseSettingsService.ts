// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import {
	IsoDateTimeString,
	OrgClickHouseApplySchemaStarted,
	OrgClickHouseApplySchemaStatus,
	OrgClickHouseCollectorConfigResponse,
	OrgClickHouseSchemaDiffResponse,
	OrgClickHouseSettingsDeleteResponse,
	OrgClickHouseSettingsEncryptionError,
	OrgClickHouseSettingsForbiddenError,
	OrgClickHouseSettingsPersistenceError,
	OrgClickHouseSettingsResponse,
	OrgClickHouseSettingsStoredConfigInvalidError,
	OrgClickHouseSettingsUpstreamRejectedError,
	OrgClickHouseSettingsUpstreamUnavailableError,
	OrgClickHouseSettingsValidationError,
	type OrgClickHouseSettingsUpsertRequest,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import {
	clickHouseSchemaVersion,
	computeSchemaDiff,
	migrations as clickHouseMigrations,
	parseEmittedStatement,
	performanceOnlySearchColumns,
	type ActualTable,
	type DesiredTable,
	type TableDiffEntry,
} from "@maple/domain/clickhouse"
import { EdgeCacheService } from "@maple/cache"
import { orgClickHouseSchemaApplyRuns, orgClickHouseSettings } from "@maple/db"
import { eq, inArray } from "drizzle-orm"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import {
	Array as Arr,
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	Redacted,
	Ref,
	Schedule,
	Schema,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
	decryptAes256Gcm,
	encryptAes256Gcm,
	parseBase64Aes256GcmKey,
	type EncryptedValue,
} from "@/platform/Crypto"
import { Database } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { forkRequestScoped } from "@/platform/fork-request-scoped"
import { dateToMs } from "@/platform/time"
import { validateExternalUrl } from "@/http/url-validator"

/**
 * Resolved per-org backend config, returned to the runtime SQL layer.
 *
 * Only ClickHouse is supported for BYO now — the BYO-Tinybird path was
 * retired. Default Maple-managed Tinybird Cloud rows have no persisted
 * settings row, so callers will see `Option.none()` from
 * `resolveRuntimeConfig` for those orgs.
 */
type RuntimeBackendConfig = {
	readonly backend: "clickhouse"
	readonly url: string
	readonly user: string
	readonly password: string
	readonly database: string
}

type ActiveRow = typeof orgClickHouseSettings.$inferSelect

/** The columns `resolveRuntimeConfig` actually caches — see `selectCachedRow`. */
type CachedSettingsRow = Pick<
	ActiveRow,
	| "schemaVersion"
	| "syncStatus"
	| "chUrl"
	| "chUser"
	| "chDatabase"
	| "chPasswordCiphertext"
	| "chPasswordIv"
	| "chPasswordTag"
>

// In-isolate value cache for the runtime-config lookup, served
// stale-while-revalidate. Workers reuse an isolate across many requests, so a
// module-scoped memo lets a warm isolate resolve config with ZERO network.
//
// SWR rather than a hard TTL because expiry used to mean *block*, and blocking
// here is disastrous: the read sits synchronously in front of every widget
// query on a dashboard. Production traces over 7 days measured 1079 blocking
// resolutions at a p50 of 2547ms — one of them 6020ms, in a request whose two
// actual ClickHouse queries took 135ms and 158ms. The config it was fetching
// changes only on BYO-CH onboarding/rotation.
//
//   now <  freshUntil  -> serve, no work
//   now <  hardUntil   -> serve the stale value AND refresh in the background
//   otherwise          -> block on Postgres (cold isolate, or a memo so idle
//                         that no background refresh ever completed)
//
// The SOFT TTL is what bounds staleness. Every write through this service busts
// the memo AND the shared edge-cache entry, but the memo only in the isolate
// that served the write — other isolates converge by re-reading at the soft TTL
// (which now hits the shared entry, not Postgres). That degree of staleness is
// safe because the warehouse executor self-heals on `WarehouseAuthError`: it
// calls `invalidateRuntimeConfig` and retries once, so a credential rotation
// costs the first request one extra round-trip instead of costing the org every
// request until the entry ages out.
//
// The HARD ceiling is not a staleness bound — it is an isolate-lifetime backstop.
// A background refresh is best-effort: it is forked into the triggering request's
// scope and interrupted if that request finishes first (see
// `refreshCachedSettings`). Without a ceiling, a pathological isolate serving
// only sub-refresh-length requests could serve one value forever. It is set well
// past a typical Workers isolate lifetime so that the blocking read happens once
// per cold isolate and never again — a bursty dashboard workload (idle isolate,
// then a widget fan-out) must not pay it on the first query of every burst, with
// the rest of the fan-out queued behind it.
const ORG_CH_CONFIG_MEMO_TTL_MS = 300_000
const ORG_CH_CONFIG_MEMO_HARD_MS = 21_600_000

/**
 * Shared tier between the in-isolate memo and Postgres, on the Workers Cache
 * API. This is the tier that keeps queries off the database; the memo in front
 * of it only saves the ~10ms read.
 *
 * Six hours here, five minutes on the memo, and the asymmetry is the point.
 * Lengthening the MEMO would not avoid a single database read — past its soft
 * TTL the refresh lands on this entry, not Postgres — it would only widen the
 * window in which an isolate that missed a write keeps serving the old value,
 * since a write can evict this shared entry for everyone but can only evict the
 * memo of the isolate that served it. So the long TTL belongs on the tier that
 * can be invalidated globally, and the short one on the tier that cannot.
 *
 * Holds the ENCRYPTED projection, exactly as the memo does — see
 * `CachedChSettings`. That property matters more here than in an isolate-local
 * map, so the envelope must never be flattened into plaintext.
 */
export const ORG_CH_CONFIG_CACHE_BUCKET = "org-ch-config"
const ORG_CH_CONFIG_CACHE_TTL_SECONDS = 21_600
interface RuntimeConfigMemoEntry {
	readonly value: CachedChSettings | null
	readonly freshUntil: number
	readonly hardUntil: number
}
const runtimeConfigMemo = new Map<string, RuntimeConfigMemoEntry>()

/**
 * Recent failures of the blocking read, so one unreachable origin is not
 * re-discovered by every caller.
 *
 * Only successes were ever memoized, which meant a failing Postgres cost every
 * branch of an in-request fan-out its own full dial budget — the 22-per-trace
 * shape described below, at ~10s each. Giving each request a single socket did
 * not help: that reduced how many dials a HEALTHY request makes, not how many a
 * failing one retries.
 *
 * Held for seconds, not the success TTL. The cost of being wrong is bounded and
 * symmetric: an org whose database recovers within the window waits it out, and
 * in exchange a degraded origin stops being hammered by callers that would each
 * spend 10s failing. Failing fast also returns outbound connection slots, which
 * is what lets the isolate recover at all.
 */
const ORG_CH_CONFIG_FAILURE_TTL_MS = 2_000
interface RuntimeConfigFailureEntry {
	readonly error: OrgClickHouseSettingsPersistenceError
	readonly atMs: number
}
const runtimeConfigFailures = new Map<string, RuntimeConfigFailureEntry>()

// Dedup marker for in-flight background refreshes, so N concurrent widget
// requests that all find the same stale entry fork ONE Postgres read rather
// than N.
//
// Deliberately a plain `Map` of timestamps and not a shared `Deferred`/`Fiber`/
// `Promise`: Cloudflare ties I/O objects to the request that created them, so a
// follower awaiting a leader's in-flight Effect can fail with "Cannot perform
// I/O on behalf of a different request" (the same hazard documented in
// `EdgeCacheService.getOrCompute`). Inert data is safe to share across
// requests; I/O handles are not. Followers here don't wait for the leader —
// they serve the stale value they already have.
//
// The age check is the backstop for a marker whose fiber died without running
// its finalizer (isolate eviction); `Effect.ensuring` covers the normal paths,
// including interruption.
const refreshInFlight = new Map<string, number>()
const REFRESH_MARKER_STALE_MS = 10_000

/**
 * Drop an org's memoized runtime config, for writers that live OUTSIDE this
 * service and so have no service instance to call — today the schema-apply
 * workflow, which stamps `schema_version`/`sync_status` on the row directly.
 *
 * The two maps must always be cleared together: a refresh forked before a write
 * must not land after it and restore the value that was just dropped.
 *
 * The workflow runs in its own isolate, so this clears that isolate's memo and
 * not the API's — API isolates still converge at `ORG_CH_CONFIG_MEMO_TTL_MS`.
 * It exists so the invariant "every writer of this row busts the memo" holds at
 * every write site rather than at most of them.
 */
export const invalidateOrgRuntimeConfigMemo = (orgId: string): void => {
	runtimeConfigMemo.delete(orgId)
	refreshInFlight.delete(orgId)
	// Third map, same rule: a stale failure must not outlive an explicit
	// invalidation and turn a fresh write into a spurious read error.
	runtimeConfigFailures.delete(orgId)
}

/**
 * Projection of the settings row memoized by `resolveRuntimeConfig`. Holds the
 * ENCRYPTED password material (ciphertext/iv/tag) — never the plaintext — so
 * decryption still happens per-request after the memo. `null` encodes "no BYO
 * ClickHouse row" (the common managed-org case), memoized too so managed orgs
 * stop paying the Postgres round-trip just to learn "use Tinybird".
 */
const CachedChSettings = Schema.Struct({
	schemaVersion: Schema.NullOr(Schema.String),
	chUrl: Schema.String,
	chUser: Schema.String,
	chDatabase: Schema.String,
	chPasswordCiphertext: Schema.NullOr(Schema.String),
	chPasswordIv: Schema.NullOr(Schema.String),
	chPasswordTag: Schema.NullOr(Schema.String),
})
type CachedChSettings = typeof CachedChSettings.Type

/**
 * What actually goes into the edge cache.
 *
 * Deliberately an envelope rather than a bare `CachedChSettings | null`.
 * `getOrCompute` treats `read.value !== undefined` as a hit, so a stored `null`
 * would work only for as long as the backend keeps distinguishing "no entry"
 * from "entry holding null" through a JSON round-trip. Managed orgs — the
 * common case — are exactly the ones that cache `null`, so if that distinction
 * ever slipped, the majority of orgs would silently never cache and the tier
 * would look like it was working while doing nothing.
 */
const CachedChSettingsEnvelope = Schema.Struct({
	settings: Schema.NullOr(CachedChSettings),
})

const toCachedChSettings = (row: CachedSettingsRow): CachedChSettings => ({
	schemaVersion: row.schemaVersion,
	chUrl: row.chUrl,
	chUser: row.chUser,
	chDatabase: row.chDatabase,
	chPasswordCiphertext: row.chPasswordCiphertext,
	chPasswordIv: row.chPasswordIv,
	chPasswordTag: row.chPasswordTag,
})

const ROOT_ROLE = Schema.decodeSync(RoleName)("root")
const ORG_ADMIN_ROLE = Schema.decodeSync(RoleName)("org:admin")
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)

export interface OrgClickHouseSettingsServiceApi {
	readonly get: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseSettingsResponse,
		OrgClickHouseSettingsForbiddenError | OrgClickHouseSettingsPersistenceError
	>
	readonly upsert: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		payload: OrgClickHouseSettingsUpsertRequest,
	) => Effect.Effect<
		OrgClickHouseSettingsResponse,
		| OrgClickHouseSettingsForbiddenError
		| OrgClickHouseSettingsValidationError
		| OrgClickHouseSettingsPersistenceError
		| OrgClickHouseSettingsEncryptionError
		| OrgClickHouseSettingsUpstreamRejectedError
		| OrgClickHouseSettingsUpstreamUnavailableError
	>
	readonly delete: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseSettingsDeleteResponse,
		OrgClickHouseSettingsForbiddenError | OrgClickHouseSettingsPersistenceError
	>
	readonly schemaDiff: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseSchemaDiffResponse,
		| OrgClickHouseSettingsForbiddenError
		| OrgClickHouseSettingsValidationError
		| OrgClickHouseSettingsPersistenceError
		| OrgClickHouseSettingsEncryptionError
		| OrgClickHouseSettingsUpstreamRejectedError
		| OrgClickHouseSettingsUpstreamUnavailableError
	>
	readonly applySchema: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseApplySchemaStarted,
		| OrgClickHouseSettingsForbiddenError
		| OrgClickHouseSettingsValidationError
		| OrgClickHouseSettingsPersistenceError
	>
	readonly applySchemaStatus: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseApplySchemaStatus,
		OrgClickHouseSettingsForbiddenError | OrgClickHouseSettingsPersistenceError
	>
	readonly resolveRuntimeConfig: (
		orgId: OrgId,
	) => Effect.Effect<
		Option.Option<RuntimeBackendConfig>,
		| OrgClickHouseSettingsPersistenceError
		| OrgClickHouseSettingsEncryptionError
		| OrgClickHouseSettingsStoredConfigInvalidError
	>
	/**
	 * Warm the runtime-config memo for many orgs in ONE Postgres round-trip.
	 *
	 * For a caller that is about to fan out across orgs (the alerting tick), the
	 * per-org `resolveRuntimeConfig` read is the wrong shape: every concurrent
	 * sibling misses the memo, because none of them has finished writing it yet.
	 * That is why no shared cache tier ever fixed this — a cache turns N Postgres
	 * reads into N cache reads that contend for the same connection budget. The
	 * fix is to collapse them into one read *before* the fan-out starts.
	 *
	 * Orgs with no settings row are memoized as `null` (the managed/Tinybird
	 * answer), which is the common case and the biggest win — otherwise every
	 * managed org re-reads Postgres forever to be told again that it has no row.
	 *
	 * Best-effort by contract: entries that are still fresh are left alone, so
	 * this can never un-stale a newer write, and callers may ignore its failure
	 * and fall back to per-org resolution.
	 */
	readonly primeRuntimeConfigs: (
		orgIds: ReadonlyArray<OrgId>,
	) => Effect.Effect<void, OrgClickHouseSettingsPersistenceError>
	/**
	 * Drop this org's cached runtime config, returning whether a BYO override was
	 * actually dropped.
	 *
	 * `resolveRuntimeConfig` serves its answer from a stale-tolerant memo, so a
	 * credential rotation keeps resolving to the retired password until the entry
	 * ages out. The warehouse executor calls this on `WarehouseAuthError` and
	 * retries once; the boolean gates that retry, so an auth failure against the
	 * shared managed credential is not run twice.
	 */
	readonly invalidateRuntimeConfig: (orgId: OrgId) => Effect.Effect<boolean>
	/**
	 * Whether the ingest gateway is currently routing this org's frames to its
	 * own ClickHouse (vs. falling back to managed Tinybird). Mirror of the
	 * gateway's `clickhouse_ready` gate — read paths for gateway-written data
	 * consult this to hit the warehouse the write actually landed in.
	 */
	readonly isWarehouseWriteReady: (
		orgId: OrgId,
	) => Effect.Effect<boolean, OrgClickHouseSettingsPersistenceError>
	readonly collectorConfig: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		OrgClickHouseCollectorConfigResponse,
		| OrgClickHouseSettingsForbiddenError
		| OrgClickHouseSettingsValidationError
		| OrgClickHouseSettingsPersistenceError
		| OrgClickHouseSettingsEncryptionError
	>
}

const toPersistenceError = (error: unknown) =>
	new OrgClickHouseSettingsPersistenceError({
		message: error instanceof Error ? error.message : "Org ClickHouse settings persistence failed",
	})

// Cloudflare Workflow binding that runs the actual (chunked, long-running)
// schema apply. Resolved off the worker env at runtime — see `apply-schema`.
const SCHEMA_APPLY_WORKFLOW_BINDING = "CLICKHOUSE_SCHEMA_APPLY_WORKFLOW"

interface WorkflowBinding {
	readonly create: (options?: {
		readonly id?: string
		readonly params?: { readonly orgId: string }
	}) => Promise<unknown>
}

const isWorkflowBinding = (value: unknown): value is WorkflowBinding =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { create?: unknown }).create === "function"

const toEncryptionError = (message: string) => new OrgClickHouseSettingsEncryptionError({ message })

const parseEncryptionKey = (raw: string): Effect.Effect<Buffer, OrgClickHouseSettingsEncryptionError> =>
	parseBase64Aes256GcmKey(raw, (message) =>
		toEncryptionError(
			message === "Expected a non-empty base64 encryption key"
				? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
				: message === "Expected base64 for exactly 32 bytes"
					? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
					: message,
		),
	)

const encryptToken = (
	plaintext: string,
	encryptionKey: Buffer,
): Effect.Effect<EncryptedValue, OrgClickHouseSettingsEncryptionError> =>
	encryptAes256Gcm(plaintext, encryptionKey, () =>
		toEncryptionError("Failed to encrypt ClickHouse password"),
	)

const decryptToken = (
	encrypted: EncryptedValue,
	encryptionKey: Buffer,
): Effect.Effect<string, OrgClickHouseSettingsEncryptionError> =>
	decryptAes256Gcm(encrypted, encryptionKey, () =>
		toEncryptionError("Failed to decrypt ClickHouse password"),
	)

// Image reference baked into the rendered collector config. Bumping this
// here is the single edit needed to roll customers onto a newer maple-otel
// collector — the generated YAML and the documented `docker run …` command
// both pick it up.
const COLLECTOR_IMAGE_REF = "ghcr.io/makisuo/maple/otel-collector-maple:0.1.5"
const COLLECTOR_PASSWORD_ENV = "MAPLE_CLICKHOUSE_PASSWORD"

/**
 * Render a ready-to-run OpenTelemetry Collector YAML for an org's BYO
 * ClickHouse. Returned by the `collectorConfig` endpoint.
 *
 * The org's CH URL/user/database are interpolated. The password is left as
 * a `${env:MAPLE_CLICKHOUSE_PASSWORD}` reference so the rendered file is
 * safe to share over chat / email / version control.
 *
 * Pipeline shape: OTLP receivers → memory_limiter → k8sattributes (best-
 * effort, ignored if RBAC is missing) → batch → maple exporter. Same
 * shape as the maple-otel Helm chart so non-Kubernetes customers get
 * parity with K8s ones.
 */
const renderCollectorYaml = (input: {
	readonly orgId: string
	readonly endpoint: string
	readonly user: string
	readonly database: string
}): string => {
	// Hand-crafted YAML rather than a templating engine so a customer
	// reading this file sees something stable and diffable.
	const lines = [
		"# Generated by Maple — your per-org OpenTelemetry Collector config.",
		"# Run with: docker run -e " +
			COLLECTOR_PASSWORD_ENV +
			"=$PASS -v ./collector.yaml:/etc/otel/config.yaml -p 4317:4317 -p 4318:4318 " +
			COLLECTOR_IMAGE_REF,
		"",
		"extensions:",
		"  health_check:",
		"    endpoint: 0.0.0.0:13133",
		"",
		"receivers:",
		"  otlp:",
		"    protocols:",
		"      grpc:",
		"        endpoint: 0.0.0.0:4317",
		"      http:",
		"        endpoint: 0.0.0.0:4318",
		"",
		"processors:",
		"  memory_limiter:",
		"    check_interval: 1s",
		"    limit_mib: 3000",
		"    spike_limit_mib: 500",
		"  k8sattributes:",
		"    passthrough: false",
		"    pod_association:",
		"      - sources:",
		"          - from: resource_attribute",
		"            name: k8s.pod.uid",
		"      - sources:",
		"          - from: connection",
		"    extract:",
		"      metadata:",
		"        - k8s.namespace.name",
		"        - k8s.deployment.name",
		"        - k8s.statefulset.name",
		"        - k8s.daemonset.name",
		"        - k8s.cronjob.name",
		"        - k8s.job.name",
		"        - k8s.node.name",
		"        - k8s.pod.name",
		"        - k8s.pod.uid",
		"        - k8s.pod.start_time",
		"  batch:",
		"    send_batch_size: 2000",
		"    timeout: 10s",
		"",
		"exporters:",
		"  maple:",
		`    endpoint: ${quoteYaml(input.endpoint)}`,
		`    database: ${quoteYaml(input.database)}`,
		`    username: ${quoteYaml(input.user)}`,
		`    password: "$\{env:${COLLECTOR_PASSWORD_ENV}}"`,
		`    org_id: ${quoteYaml(input.orgId)}`,
		"    timeout: 30s",
		"    retry_on_failure:",
		"      enabled: true",
		"      initial_interval: 1s",
		"      max_interval: 30s",
		"      max_elapsed_time: 300s",
		"    sending_queue:",
		"      enabled: true",
		"      num_consumers: 8",
		"      queue_size: 10000",
		"",
		"service:",
		"  extensions: [health_check]",
		"  pipelines:",
		"    traces:",
		"      receivers: [otlp]",
		// k8sattributes is harmless when RBAC isn't present (it just no-ops),
		// so leave it in the pipeline by default — customers running on K8s
		// get free enrichment, customers on Docker/bare-metal pay nothing.
		"      processors: [memory_limiter, k8sattributes, batch]",
		"      exporters: [maple]",
		"    logs:",
		"      receivers: [otlp]",
		"      processors: [memory_limiter, k8sattributes, batch]",
		"      exporters: [maple]",
		"    metrics:",
		"      receivers: [otlp]",
		"      processors: [memory_limiter, k8sattributes, batch]",
		"      exporters: [maple]",
		"  telemetry:",
		"    logs:",
		"      level: info",
	]
	return lines.join("\n") + "\n"
}

/**
 * Quote a YAML scalar so any `:` / `#` / leading-whitespace doesn't break
 * the serialiser. We always wrap in double quotes for predictability.
 */
const quoteYaml = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

const normalizeHttpUrl = (raw: string): Effect.Effect<string, OrgClickHouseSettingsValidationError> =>
	validateExternalUrl(raw).pipe(
		Effect.flatMap((url) =>
			url.username.length > 0 || url.password.length > 0
				? Effect.fail(
						new OrgClickHouseSettingsValidationError({
							message:
								"ClickHouse credentials must use the user/password fields, not URL userinfo",
						}),
					)
				: Effect.succeed(raw.trim().replace(/\/+$/, "")),
		),
		Effect.mapError(
			(error) =>
				new OrgClickHouseSettingsValidationError({
					message: error.message,
				}),
		),
	)

export const validateClickHouseCredentialTransport = (
	url: string,
	password: string,
): Effect.Effect<void, OrgClickHouseSettingsValidationError> =>
	Effect.try({
		try: () => new URL(url),
		catch: () =>
			new OrgClickHouseSettingsValidationError({ message: "Stored ClickHouse URL is invalid" }),
	}).pipe(
		Effect.flatMap((parsed) => {
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				return Effect.fail(
					new OrgClickHouseSettingsValidationError({
						message: "ClickHouse URLs must use HTTP or HTTPS",
					}),
				)
			}
			if (parsed.username.length > 0 || parsed.password.length > 0) {
				return Effect.fail(
					new OrgClickHouseSettingsValidationError({
						message: "ClickHouse credentials must not be embedded in the URL",
					}),
				)
			}
			return password.length > 0 && parsed.protocol !== "https:"
				? Effect.fail(
						new OrgClickHouseSettingsValidationError({
							message: "ClickHouse URLs must use HTTPS when a password is configured",
						}),
					)
				: Effect.void
		}),
	)

const isOrgAdmin = (roles: ReadonlyArray<RoleName>) =>
	roles.includes(ROOT_ROLE) || roles.includes(ORG_ADMIN_ROLE)

const isIsoDateTime = (value: Date | null | undefined) =>
	value == null ? null : decodeIsoDateTimeStringSync(value.toISOString())

const decodeStatus = (raw: string | null | undefined): "connected" | "error" | null => {
	if (raw === "connected" || raw === "error") return raw
	return null
}

// We parse the bundled snapshot statements from the static migration snapshot.
// Parsing is cheap, but the snapshot is also static across the process
// lifetime so the service memoizes the result in a `Ref` (created in `make`)
// to avoid re-parsing on every request without resorting to module-global
// mutable state.

const parseDesiredTables = (): ReadonlyArray<DesiredTable> => {
	const out: DesiredTable[] = []
	for (const stmt of clickHouseMigrations[0]?.statements ?? []) {
		// The snapshot (migration 0001) is pure DDL strings; backfill specs (only
		// in later migrations) carry no desired-table shape, so skip them.
		if (typeof stmt !== "string") continue
		const parsed = parseEmittedStatement(stmt)
		if (!parsed) continue
		out.push({
			name: parsed.name,
			kind: parsed.kind,
			columns:
				parsed.kind === "table"
					? parsed.columns.filter(
							(column) => !performanceOnlySearchColumns.has(`${parsed.name}.${column.name}`),
						)
					: [],
			createStatement: stmt,
		})
	}
	return out
}

export interface ClickHouseExecConfig {
	readonly url: string
	readonly user: string
	readonly password: string
	readonly database: string
}

const buildClickHouseHeaders = (config: ClickHouseExecConfig): Record<string, string> => {
	const headers: Record<string, string> = {
		"Content-Type": "text/plain",
		"X-ClickHouse-User": config.user,
		"X-ClickHouse-Database": config.database,
	} satisfies Record<string, string>
	if (config.password.length > 0) {
		headers["X-ClickHouse-Key"] = config.password
	}
	return headers
}

const buildClickHouseUrl = (config: ClickHouseExecConfig): string =>
	// Send the database as a URL parameter as well: ClickHouse Cloud's new
	// analyzer (24.x+) sometimes fails to resolve unqualified table identifiers
	// in materialized view bodies even when the X-ClickHouse-Database header is
	// set, surfacing as `Code: 60. UNKNOWN_TABLE`.
	`${config.url.replace(/\/$/, "")}/?database=${encodeURIComponent(config.database)}`

// Per-request timeout for ClickHouse HTTP calls. Maple's API runs on Cloudflare
// Workers, whose *outbound* fetch is capped at ~100s — a hung request to an
// unreachable/slow cluster would otherwise resolve to an opaque Cloudflare 524
// (`error code: 524`) only after the full 100s. We abort well before that so the
// failure is fast and the message is actionable. Metadata DDL + the system.*
// introspection queries all respond in well under this.
const CLICKHOUSE_EXEC_TIMEOUT_MS = 20_000

// Retry only transient *infrastructure* failures (gateway/proxy 5xx, dropped
// connections). NOT retried: ClickHouse query/DDL errors (HTTP 500 carries the
// DB::Exception text — retrying a bad statement is pointless), and our own
// request timeouts (statusCode 408 — a 20s hang won't clear on an immediate
// retry; fail fast and let the user retry once the cluster is reachable).
const CLICKHOUSE_RETRY_SCHEDULE = Schedule.max([Schedule.exponential("100 millis", 2.0), Schedule.recurs(2)])

export const isRetryableUpstream = (
	error: OrgClickHouseSettingsUpstreamRejectedError | OrgClickHouseSettingsUpstreamUnavailableError,
): boolean => {
	if (!(error instanceof OrgClickHouseSettingsUpstreamUnavailableError)) return false
	const status = error.statusCode
	if (status === null) return true // network-level failure (reset/refused) — cheap to retry
	// Gateway/proxy codes that are typically transient. 500/501 are excluded:
	// ClickHouse returns 500 for genuine SQL/DDL errors; 408 is our own timeout.
	return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 529)
}

/**
 * Whether `schemaDiff` should re-stamp the recorded `schema_version` to the
 * current `clickHouseSchemaVersion`. True when the live ClickHouse schema is fully
 * in sync (every diff entry `up_to_date`) yet the stored value is stale.
 *
 * This closes the "stuck not ready" gap: the ingest gateway only routes an org's
 * frames to its own ClickHouse when `schema_version` equals the running version,
 * but a credential re-save preserves the old value and the standalone CLI never
 * writes Maple's application database — so a CLI-applied (or revision-bumped) org whose cluster is actually
 * current would otherwise stay on the managed Tinybird write path forever, with no
 * way to re-stamp because Apply is disabled when there's no diff. The non-empty
 * guard avoids healing off a degenerate empty diff (e.g. a failed schema fetch),
 * where `every` would be vacuously true.
 */
export const shouldHealSchemaVersion = (
	entries: ReadonlyArray<TableDiffEntry>,
	storedSchemaVersion: string | null,
	currentSchemaVersion: string,
): boolean =>
	storedSchemaVersion !== currentSchemaVersion &&
	entries.length > 0 &&
	entries.every((entry) => entry.status === "up_to_date")

const describeUpstream5xx = (status: number, message: string): string => {
	// A 52x with the literal `error code: 5xx` body is Cloudflare's synthetic
	// timeout/origin-error page: Maple's Worker fetch to ClickHouse exceeded
	// Cloudflare's ~100s edge timeout because the endpoint didn't respond.
	if (status >= 520 && status <= 529) {
		return (
			`ClickHouse did not respond in time (Cloudflare ${status}). The cluster is unreachable ` +
			`or too slow from Maple's network — check the endpoint's firewall / IP allowlist ` +
			`(Maple's API egresses from Cloudflare and cannot be reliably IP-allowlisted; prefer ` +
			`auth + TLS without source-IP restrictions) and that the cluster is up. Upstream: ${message}`
		)
	}
	return `ClickHouse upstream error (${status}): ${message}`
}

const mapStatusToError = (
	status: number,
	text: string,
): Effect.Effect<
	never,
	OrgClickHouseSettingsUpstreamRejectedError | OrgClickHouseSettingsUpstreamUnavailableError
> => {
	const message = text.split("\n")[0]?.slice(0, 500) ?? ""
	if (status === 401 || status === 403) {
		return Effect.fail(
			new OrgClickHouseSettingsUpstreamRejectedError({
				message: `ClickHouse rejected credentials: ${message}`,
				statusCode: status,
			}),
		)
	}
	if (status >= 300 && status < 400) {
		return Effect.fail(
			new OrgClickHouseSettingsUpstreamRejectedError({
				message: `ClickHouse redirect responses are not allowed (${status})`,
				statusCode: status,
			}),
		)
	}
	if (status >= 500) {
		return Effect.fail(
			new OrgClickHouseSettingsUpstreamUnavailableError({
				message: describeUpstream5xx(status, message),
				statusCode: status,
			}),
		)
	}
	return Effect.fail(
		new OrgClickHouseSettingsUpstreamRejectedError({
			message: `ClickHouse rejected statement (${status}): ${message}`,
			statusCode: status,
		}),
	)
}

const execClickHouseWithClient = (client: HttpClient.HttpClient, config: ClickHouseExecConfig, sql: string) =>
	Effect.gen(function* () {
		const request = HttpClientRequest.post(buildClickHouseUrl(config), {
			headers: buildClickHouseHeaders(config),
		}).pipe(HttpClientRequest.bodyText(sql))
		const response = yield* client
			.execute(request)
			.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
		const text = yield* response.text
		return { status: response.status, text }
	}).pipe(
		// Transport-level failures (DNS, connection reset/refused, body read) →
		// retryable "unreachable" with no status.
		Effect.mapError(
			(error) =>
				new OrgClickHouseSettingsUpstreamUnavailableError({
					message: `Could not reach ClickHouse: ${error.message}`,
					statusCode: null,
				}),
		),
		Effect.flatMap(
			({
				status,
				text,
			}): Effect.Effect<
				string,
				OrgClickHouseSettingsUpstreamRejectedError | OrgClickHouseSettingsUpstreamUnavailableError
			> => (status >= 200 && status < 300 ? Effect.succeed(text) : mapStatusToError(status, text)),
		),
		// Per-attempt deadline. On timeout the fiber is interrupted — HttpClient
		// passes the abort signal to fetch, so the in-flight request is actually
		// cancelled — and we fail with a 408, excluded from the retry policy, so an
		// unreachable cluster surfaces fast instead of riding Cloudflare's ~100s
		// edge timeout into an opaque 524.
		Effect.timeoutOrElse({
			duration: Duration.millis(CLICKHOUSE_EXEC_TIMEOUT_MS),
			orElse: () =>
				Effect.fail(
					new OrgClickHouseSettingsUpstreamUnavailableError({
						message:
							`Request to ClickHouse timed out after ${CLICKHOUSE_EXEC_TIMEOUT_MS / 1000}s. ` +
							`The cluster is reachable but slow, or unreachable from Maple's network. ` +
							`Maple's API egresses from Cloudflare — if your ClickHouse endpoint has an IP ` +
							`allowlist / firewall it must accept that egress (prefer auth + TLS without ` +
							`source-IP restrictions).`,
						statusCode: 408,
					}),
				),
		}),
		Effect.retry({ schedule: CLICKHOUSE_RETRY_SCHEDULE, while: isRetryableUpstream }),
	)

export const execClickHouse = (config: ClickHouseExecConfig, sql: string) =>
	HttpClient.HttpClient.use((client) => execClickHouseWithClient(client, config, sql))

interface ClickHouseTableRow {
	readonly name: string
	readonly engine: string
}
interface ClickHouseColumnRow {
	readonly table: string
	readonly name: string
	readonly type: string
}

const fetchActualSchema = (client: HttpClient.HttpClient, config: ClickHouseExecConfig) =>
	Effect.gen(function* () {
		// Tables: name + engine. Engine="MaterializedView" → MV; everything else → table.
		const tablesSql = `SELECT name, engine FROM system.tables WHERE database = '${config.database.replace(/'/g, "''")}' FORMAT JSONEachRow`
		const tablesText = yield* execClickHouseWithClient(client, config, tablesSql)
		const tableRows = parseJsonEachRow<ClickHouseTableRow>(tablesText)

		const columnsSql = `SELECT table, name, type FROM system.columns WHERE database = '${config.database.replace(/'/g, "''")}' FORMAT JSONEachRow`
		const columnsText = yield* execClickHouseWithClient(client, config, columnsSql)
		const columnRows = parseJsonEachRow<ClickHouseColumnRow>(columnsText)

		const colsByTable = new Map<string, Array<{ name: string; type: string }>>()
		for (const row of columnRows) {
			const list = colsByTable.get(row.table) ?? []
			list.push({ name: row.name, type: row.type })
			colsByTable.set(row.table, list)
		}

		const result = new Map<string, ActualTable>()
		for (const t of tableRows) {
			result.set(t.name, {
				name: t.name,
				kind: t.engine === "MaterializedView" ? "materialized_view" : "table",
				columns: colsByTable.get(t.name) ?? [],
			})
		}
		return result
	})

const parseJsonEachRow = <T>(text: string): ReadonlyArray<T> => {
	const out: T[] = []
	for (const line of text.split("\n")) {
		const trimmed = line.trim()
		if (trimmed.length === 0) continue
		try {
			out.push(JSON.parse(trimmed) as T)
		} catch {
			// Skip malformed rows — the entire response is from us-controlled
			// queries against system.* tables, so this is defence-in-depth.
		}
	}
	return out
}

// The migration runner + backfill chunking now live in the background
// schema-apply Workflow (apps/api/src/workflows/ClickHouseSchemaApplyWorkflow.run.ts),
// which `applySchema` kicks off. The `_maple_schema_migrations` bookkeeping
// protocol is shared with `@maple/clickhouse-cli`.

export class OrgClickHouseSettingsService extends Context.Service<
	OrgClickHouseSettingsService,
	OrgClickHouseSettingsServiceApi
>()("@maple/api/services/OrgClickHouseSettingsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const httpClient = yield* HttpClient.HttpClient
		const encryptionKey = yield* parseEncryptionKey(Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY))
		// Optional: present only inside a Worker isolate. Used to kick off the
		// background schema-apply Workflow. Read optionally so non-worker/test
		// contexts (where the binding is absent) still construct the service.
		const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)
		const edgeCache = yield* EdgeCacheService

		// Memoize the parsed desired-schema snapshot per service instance. The
		// snapshot is static, so we parse it at most once and reuse it.
		const desiredTablesCache = yield* Ref.make<ReadonlyArray<DesiredTable> | null>(null)
		const getDesiredTables = Effect.gen(function* () {
			const cached = yield* Ref.get(desiredTablesCache)
			if (cached) return cached
			const parsed = parseDesiredTables()
			yield* Ref.set(desiredTablesCache, parsed)
			return parsed
		})

		const requireAdmin = Effect.fn("OrgClickHouseSettingsService.requireAdmin")(function* (
			roles: ReadonlyArray<RoleName>,
		) {
			if (isOrgAdmin(roles)) return
			return yield* Effect.fail(
				new OrgClickHouseSettingsForbiddenError({
					message: "Only org admins can manage ClickHouse settings",
				}),
			)
		})

		const selectActiveRow = Effect.fn("OrgClickHouseSettingsService.selectActiveRow")(function* (
			orgId: OrgId,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(orgClickHouseSettings)
						.where(eq(orgClickHouseSettings.orgId, orgId))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return Option.fromNullishOr(rows[0])
		})

		// The hot-path read: only the columns that end up in `CachedChSettings`.
		// `selectActiveRow`'s `SELECT *` pulls all 14 including the encrypted
		// password blobs and the migration bookkeeping, none of which this path
		// looks at — and this is the read that runs on every warehouse query.
		const selectCachedRow = Effect.fn("OrgClickHouseSettingsService.selectCachedRow")(function* (
			orgId: OrgId,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select({
							schemaVersion: orgClickHouseSettings.schemaVersion,
							syncStatus: orgClickHouseSettings.syncStatus,
							chUrl: orgClickHouseSettings.chUrl,
							chUser: orgClickHouseSettings.chUser,
							chDatabase: orgClickHouseSettings.chDatabase,
							chPasswordCiphertext: orgClickHouseSettings.chPasswordCiphertext,
							chPasswordIv: orgClickHouseSettings.chPasswordIv,
							chPasswordTag: orgClickHouseSettings.chPasswordTag,
						})
						.from(orgClickHouseSettings)
						.where(eq(orgClickHouseSettings.orgId, orgId))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			return Option.fromNullishOr(rows[0])
		})

		/**
		 * Drop the shared edge-cache entry for an org. Best-effort by contract —
		 * `invalidate` logs and swallows backend failures, and the entry expires on
		 * its TTL regardless.
		 */
		const invalidateSharedRuntimeConfig = (orgId: OrgId): Effect.Effect<void> =>
			edgeCache.invalidate({ bucket: ORG_CH_CONFIG_CACHE_BUCKET, key: orgId })

		// Bust the cached runtime config for an org after any write to its settings
		// row, so the next warehouse query re-resolves rather than serving a stale
		// value.
		//
		// Both tiers, always. Dropping only the memo would leave the shared entry
		// to serve the pre-write value back to every OTHER isolate for the full
		// six hours — the write would look applied to whoever made it and to
		// nobody else.
		const invalidateRuntimeConfigCache = (orgId: OrgId): Effect.Effect<boolean> =>
			Effect.gen(function* () {
				// Whether this org had a BYO row cached is the caller's retry gate (see
				// `invalidateRuntimeConfig`), so read before deleting. A memo entry
				// holding `null` means "we know this org is managed" — invalidating that
				// changes no routing decision, so it does not count as a hit.
				const memoized = runtimeConfigMemo.get(orgId)
				const hadOverride = memoized !== undefined && memoized.value !== null
				invalidateOrgRuntimeConfigMemo(orgId)
				yield* invalidateSharedRuntimeConfig(orgId)
				return hadOverride
			})

		/**
		 * Public form of `invalidateRuntimeConfigCache`, for the warehouse
		 * executor's credential-rotation self-heal.
		 *
		 * `resolveCachedSettings` serves this config stale by design, so a BYO
		 * ClickHouse password rotation keeps resolving to the retired credential
		 * until the entry ages out. The executor calls this on `WarehouseAuthError`
		 * and retries once. The returned boolean is the retry gate: `true` only
		 * when a per-org override was actually dropped, so an auth failure against
		 * the shared managed credential — where re-resolving cannot change the
		 * answer — is not run twice.
		 */
		const invalidateRuntimeConfig = (orgId: OrgId): Effect.Effect<boolean> =>
			invalidateRuntimeConfigCache(orgId)

		const requireActiveRow = Effect.fn("OrgClickHouseSettingsService.requireActiveRow")(function* (
			orgId: OrgId,
		) {
			const row = yield* selectActiveRow(orgId)
			if (Option.isSome(row)) return row.value
			return yield* Effect.fail(
				new OrgClickHouseSettingsValidationError({
					message: "BYO ClickHouse is not configured for this org",
				}),
			)
		})

		const decryptStoredPassword = (
			row: Pick<ActiveRow, "chPasswordCiphertext" | "chPasswordIv" | "chPasswordTag">,
		): Effect.Effect<string, OrgClickHouseSettingsEncryptionError> =>
			row.chPasswordCiphertext !== null && row.chPasswordIv !== null && row.chPasswordTag !== null
				? decryptToken(
						{
							ciphertext: row.chPasswordCiphertext,
							iv: row.chPasswordIv,
							tag: row.chPasswordTag,
						},
						encryptionKey,
					)
				: Effect.succeed("")

		const toResponse = (row: ActiveRow | null | undefined): OrgClickHouseSettingsResponse =>
			new OrgClickHouseSettingsResponse({
				configured: row != null,
				chUrl: row?.chUrl ?? null,
				chUser: row?.chUser ?? null,
				chDatabase: row?.chDatabase ?? null,
				syncStatus: decodeStatus(row?.syncStatus),
				lastSyncAt: isIsoDateTime(row?.lastSyncAt ?? null),
				lastSyncError: row?.lastSyncError ?? null,
				schemaVersion: row?.schemaVersion ?? null,
			})

		const get = Effect.fn("OrgClickHouseSettingsService.get")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)
			const row = yield* selectActiveRow(orgId)
			return toResponse(Option.getOrUndefined(row))
		})

		const upsert = Effect.fn("OrgClickHouseSettingsService.upsert")(function* (
			orgId: OrgId,
			userId: UserId,
			roles: ReadonlyArray<RoleName>,
			payload: OrgClickHouseSettingsUpsertRequest,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("tenant.userId", userId)
			yield* requireAdmin(roles)

			const url = yield* normalizeHttpUrl(payload.url)
			const user = payload.user.trim()
			const dbName = payload.database.trim()
			if (user.length === 0) {
				return yield* new OrgClickHouseSettingsValidationError({
					message: "ClickHouse user is required",
				})
			}
			if (dbName.length === 0) {
				return yield* new OrgClickHouseSettingsValidationError({
					message: "ClickHouse database is required",
				})
			}

			// If the user left the password blank on a re-save, reuse the existing
			// stored password (decrypted from the previous row) ONLY when the URL,
			// user, and database are unchanged. Otherwise we'd be silently sending
			// the stored credential to a different host — an SSRF / credential
			// disclosure path. Force the user to re-enter the password when any
			// connection identifier changes.
			const existingRow = yield* selectActiveRow(orgId)
			let plainPassword = (payload.password ?? "").trim()
			if (plainPassword.length === 0 && Option.isSome(existingRow)) {
				const existing = existingRow.value
				const sameEndpoint =
					existing.chUrl === url && existing.chUser === user && existing.chDatabase === dbName
				if (!sameEndpoint) {
					return yield* new OrgClickHouseSettingsValidationError({
						message: "Password is required when changing the ClickHouse URL, user, or database",
					})
				}
				plainPassword = yield* decryptStoredPassword(existing)
			}
			yield* validateClickHouseCredentialTransport(url, plainPassword)

			// Connect-and-validate: hit the cluster with `SELECT 1` so a typo'd
			// host or token surfaces here rather than after the user closes the
			// dialog. No DDL is run — applying the schema is a separate explicit
			// action via the diff/apply endpoints.
			yield* execClickHouseWithClient(
				httpClient,
				{ url, user, password: plainPassword, database: dbName },
				"SELECT 1",
			)

			const encryptedPassword =
				plainPassword.length > 0 ? yield* encryptToken(plainPassword, encryptionKey) : null

			const now = yield* Clock.currentTimeMillis
			yield* database
				.execute((db) =>
					db
						.insert(orgClickHouseSettings)
						.values({
							orgId,
							chUrl: url,
							chUser: user,
							chPasswordCiphertext: encryptedPassword?.ciphertext ?? null,
							chPasswordIv: encryptedPassword?.iv ?? null,
							chPasswordTag: encryptedPassword?.tag ?? null,
							chDatabase: dbName,
							syncStatus: "connected",
							lastSyncAt: new Date(now),
							lastSyncError: null,
							// schemaVersion is preserved across re-saves — credentials
							// changing doesn't invalidate the schema apply state.
							schemaVersion: Option.isSome(existingRow)
								? existingRow.value.schemaVersion
								: null,
							createdAt: Option.isSome(existingRow)
								? existingRow.value.createdAt
								: new Date(now),
							updatedAt: new Date(now),
							createdBy: Option.isSome(existingRow) ? existingRow.value.createdBy : userId,
							updatedBy: userId,
						})
						.onConflictDoUpdate({
							target: orgClickHouseSettings.orgId,
							set: {
								chUrl: url,
								chUser: user,
								chPasswordCiphertext: encryptedPassword?.ciphertext ?? null,
								chPasswordIv: encryptedPassword?.iv ?? null,
								chPasswordTag: encryptedPassword?.tag ?? null,
								chDatabase: dbName,
								syncStatus: "connected",
								lastSyncAt: new Date(now),
								lastSyncError: null,
								updatedAt: new Date(now),
								updatedBy: userId,
							},
						}),
				)
				.pipe(Effect.mapError(toPersistenceError))

			yield* invalidateRuntimeConfigCache(orgId)
			const refreshed = yield* selectActiveRow(orgId)
			return toResponse(Option.getOrUndefined(refreshed))
		})

		const deleteSettings = Effect.fn("OrgClickHouseSettingsService.delete")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)
			yield* database
				.execute((db) =>
					db.delete(orgClickHouseSettings).where(eq(orgClickHouseSettings.orgId, orgId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
			yield* invalidateRuntimeConfigCache(orgId)
			return new OrgClickHouseSettingsDeleteResponse({ configured: false })
		})

		const loadConfigForRow = (row: ActiveRow) =>
			Effect.gen(function* () {
				const password = yield* decryptStoredPassword(row)
				yield* validateClickHouseCredentialTransport(row.chUrl, password)
				return {
					url: row.chUrl,
					user: row.chUser,
					password,
					database: row.chDatabase,
				}
			})

		const schemaDiff = Effect.fn("OrgClickHouseSettingsService.schemaDiff")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)
			const row = yield* requireActiveRow(orgId)
			const config = yield* loadConfigForRow(row)
			const actual = yield* fetchActualSchema(httpClient, config)
			const entries = computeSchemaDiff({ tables: yield* getDesiredTables }, actual)

			// Self-heal the recorded schema version. The ingest gateway only routes an
			// org's frames directly to its ClickHouse when the stored `schema_version`
			// equals the running `clickHouseSchemaVersion`. But a credential re-save
			// *preserves* the old value and the standalone CLI never writes Maple's database, so an org
			// whose CH is already in sync can be stuck "not ready" forever — with no way to
			// re-stamp, because the Apply action is disabled when there is no diff. When the
			// live schema matches what we expect, record the current schema version so the
			// read (dashboard) and write (gateway) paths agree on routing to ClickHouse
			// instead of silently splitting writes to Tinybird.
			let appliedSchemaVersion = row.schemaVersion ?? null
			if (shouldHealSchemaVersion(entries, row.schemaVersion ?? null, clickHouseSchemaVersion)) {
				const now = yield* Clock.currentTimeMillis
				yield* database
					.execute((db) =>
						db
							.update(orgClickHouseSettings)
							.set({
								schemaVersion: clickHouseSchemaVersion,
								syncStatus: "connected",
								lastSyncAt: new Date(now),
								lastSyncError: null,
								updatedAt: new Date(now),
							})
							.where(eq(orgClickHouseSettings.orgId, orgId)),
					)
					.pipe(Effect.mapError(toPersistenceError))
				yield* invalidateRuntimeConfigCache(orgId)
				appliedSchemaVersion = clickHouseSchemaVersion
				yield* Effect.annotateCurrentSpan("clickhouse.schemaVersion.healed", true)
				yield* Effect.logInfo("Self-healed ClickHouse schema_version to current version").pipe(
					Effect.annotateLogs({
						orgId,
						previousSchemaVersion: row.schemaVersion ?? "(none)",
						schemaVersion: clickHouseSchemaVersion,
					}),
				)
			}

			return new OrgClickHouseSchemaDiffResponse({
				expectedSchemaVersion: clickHouseSchemaVersion,
				appliedSchemaVersion,
				entries,
			})
		})

		// Kick off the background schema-apply Workflow. The heavy work (chunked
		// backfill migrations + snapshot-diff reconcile) runs there so it never
		// hits the Worker request budget; the client polls `applySchemaStatus`.
		const applySchema = Effect.fn("OrgClickHouseSettingsService.applySchema")(function* (
			orgId: OrgId,
			userId: UserId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("tenant.userId", userId)
			yield* requireAdmin(roles)
			// Ensure BYO ClickHouse is configured before queuing a run.
			yield* requireActiveRow(orgId)

			const existing = yield* database
				.execute((db) =>
					db
						.select()
						.from(orgClickHouseSchemaApplyRuns)
						.where(eq(orgClickHouseSchemaApplyRuns.orgId, orgId))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const current = existing[0]
			if (current && (current.status === "queued" || current.status === "running")) {
				return new OrgClickHouseApplySchemaStarted({ status: "already_running" })
			}

			const now = yield* Clock.currentTimeMillis
			yield* database
				.execute((db) =>
					db
						.insert(orgClickHouseSchemaApplyRuns)
						.values({
							orgId,
							workflowInstanceId: null,
							status: "queued",
							phase: "queued",
							currentMigration: null,
							stepsTotal: null,
							stepsDone: null,
							appliedVersions: null,
							skipped: null,
							errorMessage: null,
							startedAt: null,
							finishedAt: null,
							createdAt: new Date(now),
							updatedAt: new Date(now),
						})
						.onConflictDoUpdate({
							target: orgClickHouseSchemaApplyRuns.orgId,
							set: {
								status: "queued",
								phase: "queued",
								currentMigration: null,
								stepsTotal: null,
								stepsDone: null,
								appliedVersions: null,
								skipped: null,
								errorMessage: null,
								startedAt: null,
								finishedAt: null,
								updatedAt: new Date(now),
							},
						}),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const binding = Option.match(workerEnv, {
				onNone: () => undefined,
				onSome: (e) => e[SCHEMA_APPLY_WORKFLOW_BINDING],
			})
			if (!isWorkflowBinding(binding)) {
				return yield* Effect.fail(
					new OrgClickHouseSettingsPersistenceError({
						message: `Schema-apply workflow binding (${SCHEMA_APPLY_WORKFLOW_BINDING}) unavailable`,
					}),
				)
			}
			yield* Effect.tryPromise({
				try: () => binding.create({ params: { orgId } }),
				catch: (error) =>
					new OrgClickHouseSettingsPersistenceError({
						message: `Failed to start schema-apply workflow: ${error instanceof Error ? error.message : String(error)}`,
					}),
			})

			return new OrgClickHouseApplySchemaStarted({ status: "started" })
		})

		const applySchemaStatus = Effect.fn("OrgClickHouseSettingsService.applySchemaStatus")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(orgClickHouseSchemaApplyRuns)
						.where(eq(orgClickHouseSchemaApplyRuns.orgId, orgId))
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))
			const row = rows[0]
			if (!row) {
				return new OrgClickHouseApplySchemaStatus({
					status: "idle",
					phase: null,
					currentMigration: null,
					stepsTotal: null,
					stepsDone: null,
					appliedVersions: [],
					errorMessage: null,
					startedAt: null,
					finishedAt: null,
				})
			}
			let appliedVersions: ReadonlyArray<number> = []
			if (Array.isArray(row.appliedVersions)) {
				appliedVersions = row.appliedVersions.map((v) => Number(v))
			}
			const status =
				row.status === "queued" ||
				row.status === "running" ||
				row.status === "succeeded" ||
				row.status === "failed"
					? row.status
					: "idle"
			return new OrgClickHouseApplySchemaStatus({
				status,
				phase: row.phase ?? null,
				currentMigration: row.currentMigration ?? null,
				stepsTotal: row.stepsTotal ?? null,
				stepsDone: row.stepsDone ?? null,
				appliedVersions,
				errorMessage: row.errorMessage ?? null,
				startedAt: dateToMs(row.startedAt),
				finishedAt: dateToMs(row.finishedAt),
			})
		})

		// The narrow Postgres read behind the memo. Returns the ENCRYPTED row
		// projection (or `null` for a managed org); decryption happens per-request
		// in `resolveRuntimeConfig`, so plaintext credentials never enter a cache.
		const readSettingsFromPostgres = (orgId: OrgId) =>
			selectCachedRow(orgId).pipe(
				Effect.map((row) => (Option.isSome(row) ? toCachedChSettings(row.value) : null)),
			)

		const storeCachedSettings = (orgId: OrgId, value: CachedChSettings | null, nowMs: number) => {
			runtimeConfigMemo.set(orgId, {
				value,
				freshUntil: nowMs + ORG_CH_CONFIG_MEMO_TTL_MS,
				hardUntil: nowMs + ORG_CH_CONFIG_MEMO_HARD_MS,
			})
		}

		// Batched sibling of `selectCachedRow`, same projection plus `orgId` so the
		// rows can be keyed back to the orgs that were asked for. One statement for
		// the whole set: the dial is the cost, not the row count.
		const selectCachedRowsForOrgs = Effect.fn("OrgClickHouseSettingsService.selectCachedRowsForOrgs")(
			function* (orgIds: ReadonlyArray<OrgId>) {
				const rows = yield* database
					.execute((db) =>
						db
							.select({
								orgId: orgClickHouseSettings.orgId,
								schemaVersion: orgClickHouseSettings.schemaVersion,
								syncStatus: orgClickHouseSettings.syncStatus,
								chUrl: orgClickHouseSettings.chUrl,
								chUser: orgClickHouseSettings.chUser,
								chDatabase: orgClickHouseSettings.chDatabase,
								chPasswordCiphertext: orgClickHouseSettings.chPasswordCiphertext,
								chPasswordIv: orgClickHouseSettings.chPasswordIv,
								chPasswordTag: orgClickHouseSettings.chPasswordTag,
							})
							.from(orgClickHouseSettings)
							.where(inArray(orgClickHouseSettings.orgId, [...orgIds])),
					)
					.pipe(Effect.mapError(toPersistenceError))
				return rows
			},
		)

		const primeRuntimeConfigs = Effect.fn("OrgClickHouseSettingsService.primeRuntimeConfigs")(function* (
			orgIds: ReadonlyArray<OrgId>,
		) {
			const nowMs = yield* Clock.currentTimeMillis
			// Only orgs whose entry is absent or no longer fresh. Skipping the
			// fresh ones is what makes this safe to call unconditionally: priming
			// can never overwrite a newer value with an older read.
			const pending = Arr.dedupe(
				orgIds.filter((orgId) => {
					const memoized = runtimeConfigMemo.get(orgId)
					return memoized === undefined || nowMs >= memoized.freshUntil
				}),
			)
			yield* Effect.annotateCurrentSpan({
				"clickhouse.config.prime_requested": orgIds.length,
				"clickhouse.config.primed_orgs": pending.length,
			})
			if (Arr.isReadonlyArrayEmpty(pending)) return

			const rows = yield* selectCachedRowsForOrgs(pending)
			const byOrgId = new Map(rows.map((row) => [row.orgId, row] as const))
			const writeNowMs = yield* Clock.currentTimeMillis
			for (const orgId of pending) {
				const row = byOrgId.get(orgId)
				storeCachedSettings(orgId, row === undefined ? null : toCachedChSettings(row), writeNowMs)
			}
		})

		/**
		 * Refresh a stale memo entry without making the caller wait for it.
		 *
		 * Forked into the *triggering request's* scope, never detached. This is the
		 * whole correctness argument: Cloudflare owns I/O objects per-request, so a
		 * fiber that outlives its request and then touches a socket it opened there
		 * fails with "Cannot perform I/O on behalf of a different request".
		 * `Effect.forkIn(scope)` guarantees interruption when the request scope
		 * closes, so every socket this fiber opens is opened and consumed inside the
		 * request that created it.
		 *
		 * Interruption is a no-op for correctness: the memo is written only on
		 * success, so an interrupted refresh leaves the stale entry exactly as it
		 * was and the next request tries again. The work is a ~26ms Postgres read
		 * racing warehouse queries that take an order of magnitude longer, so it
		 * lands well before the scope closes in practice.
		 *
		 * `waitUntil` is deliberately NOT used: the worker never passes Cloudflare's
		 * `ExecutionContext` into the Effect graph (see `worker.ts`), and reaching it
		 * through a module-scoped mutable would register one request's refresh on
		 * another's context — manufacturing the very hazard above.
		 *
		 * Failures are swallowed after a warning: this is a cache refresh, and the
		 * real query behind it reports failures with proper context.
		 */
		const refreshCachedSettings = Effect.fnUntraced(function* (orgId: OrgId, nowMs: number) {
			const startedAt = refreshInFlight.get(orgId)
			if (startedAt !== undefined && nowMs - startedAt < REFRESH_MARKER_STALE_MS) return false
			refreshInFlight.set(orgId, nowMs)

			// Through the shared tier, not straight to Postgres. This fires once per
			// isolate per org per soft TTL, so sending it to Postgres would mean
			// every isolate re-dialling the database every five minutes for a row
			// that changes on onboarding — most of the reads this tier exists to
			// remove. Refreshing the memo from a shared entry that writes evict is
			// the intended convergence path, not a staleness leak.
			const work = readSharedOrPostgres(orgId).pipe(
				Effect.flatMap((value) =>
					Clock.currentTimeMillis.pipe(
						Effect.map((writeNowMs) => storeCachedSettings(orgId, value, writeNowMs)),
					),
				),
				Effect.tapError((error) =>
					Effect.logWarning("Org ClickHouse config refresh failed; serving stale").pipe(
						Effect.annotateLogs({ orgId, error: String(error) }),
					),
				),
				Effect.ignore,
				// Runs on interruption too, so a scope that closes mid-refresh cannot
				// leave a marker that blocks the next refresh for REFRESH_MARKER_STALE_MS.
				Effect.ensuring(Effect.sync(() => refreshInFlight.delete(orgId))),
			)

			// Scoped rather than detached — see `forkRequestScoped` for why anything
			// that touches Postgres must not outlive the invocation that owns the
			// socket. This call site is where that rule was first worked out.
			yield* forkRequestScoped(work)
			return true
		})

		// The cached settings row behind `resolveRuntimeConfig`.
		//
		// `selectCachedRow` is a Postgres round-trip on the hot path of EVERY
		// warehouse SQL execution, and the bucket-cache fan-out re-runs it once per
		// missing range — so this must not block. A module-scoped in-isolate memo
		// answers it with zero network, and past its soft TTL it keeps answering
		// from the stale value while a background fiber refreshes it.
		//
		// Behind the memo sits ONE shared tier, on the Workers Cache API. Two
		// earlier attempts at this were reverted, and the difference is worth
		// spelling out, because the naive reading of that history ("a shared cache
		// cannot work here") is too strong and would rule out the case it does fix.
		//
		// The first attempt (a 1h edge-cache entry) measured, over 7 days: 241
		// completed reads at a span p50 of 26ms, against 1079 abandoned at the 40ms
		// deadline costing a p50 of 2547ms — because `cache.match()` cannot be
		// cancelled, so the abandoned read kept holding one of the Worker's six
		// connection slots and the Postgres fallback queued behind it. The second
		// (#387) moved the tier to Workers KV on the theory that a KV `get` is a
		// cancellable subrequest; it was worse (92ms completed vs 6ms on the Cache
		// API, 79% still hitting the deadline) and `apps/alerting`, which was most
		// of the volume, has no KV binding at all.
		//
		// What actually drove that 82% abandonment was CONCURRENCY WITHIN ONE
		// REQUEST, not the tier. A `cache.match()` occupies one of the six
		// connection slots while it waits for headers, so the timeout rate scales
		// with how many reads a single request issues — measured at 8.4% for one
		// read and 35.9% for four (see `DEFAULT_EDGE_CACHE_READ_TIMEOUT_MS`). The
		// org-config bucket was being read 22 times in a single alerting request
		// (106 traces doing 22 resolutions each, half of all of them). Those reads
		// congested each other, and each abandoned one held a slot the Postgres
		// fallback then queued behind.
		//
		// That fan-out is gone: `AlertsService` now calls `primeRuntimeConfigs` to
		// resolve the whole set in one statement, and the HTTP query paths call
		// `warehouse.warmRoute` once per request before fanning out. What remains is
		// the opposite shape — a dashboard load fires 5-17 parallel requests that
		// land on DIFFERENT cold isolates, one config read each, before any
		// warehouse `fetch()` is holding a slot. Measured in bursts of 17, 9, 9, 9,
		// 8, 8 blocking reads in a single second. A per-isolate memo cannot help
		// across isolates and neither can `warmRoute`; a shared entry can, because
		// the first isolate to resolve populates it for the rest.
		//
		// So: one read per request, issued before the warehouse queries. Do NOT
		// reintroduce a per-org cache read inside a fan-out — prime instead.
		//
		// The read deadline is deliberately left at the default. Raising it looks
		// tempting given how expensive `compute` is here, but the latency
		// distribution is bimodal, not long-tailed: a read that will succeed has
		// done so by ~20ms, the entire 40-249ms band is 0.5% of reads, and anything
		// past that is hung rather than slow. A longer deadline would buy almost no
		// extra hits and charge the full deadline to every hung read.
		const readSharedOrPostgres = (orgId: OrgId) =>
			edgeCache
				.getOrCompute(
					{
						bucket: ORG_CH_CONFIG_CACHE_BUCKET,
						key: orgId,
						ttlSeconds: ORG_CH_CONFIG_CACHE_TTL_SECONDS,
						schema: CachedChSettingsEnvelope,
					},
					readSettingsFromPostgres(orgId).pipe(Effect.map((settings) => ({ settings }))),
				)
				.pipe(
					Effect.tap((result) =>
						Effect.annotateCurrentSpan(
							"clickhouse.config.source",
							result.hit ? "edge_cache" : "postgres",
						),
					),
					Effect.map((result) => result.value.settings),
				)

		const resolveCachedSettings = Effect.fn("OrgClickHouseSettingsService.resolveCachedSettings")(
			function* (orgId: OrgId) {
				const nowMs = yield* Clock.currentTimeMillis
				const memoized = runtimeConfigMemo.get(orgId)

				if (memoized !== undefined && nowMs < memoized.freshUntil) {
					yield* Effect.annotateCurrentSpan({
						"clickhouse.config.source": "memo",
						// Legacy spelling, dual-emitted until dashboards move to
						// `clickhouse.config.source`.
						"clickhouse.config.memoHit": true,
					})
					return memoized.value
				}

				if (memoized !== undefined && nowMs < memoized.hardUntil) {
					const forked = yield* refreshCachedSettings(orgId, nowMs)
					yield* Effect.annotateCurrentSpan({
						"clickhouse.config.source": "memo_stale",
						"clickhouse.config.refresh_forked": forked,
						"clickhouse.config.stale_age_ms":
							nowMs - (memoized.freshUntil - ORG_CH_CONFIG_MEMO_TTL_MS),
						"clickhouse.config.memoHit": true,
					})
					return memoized.value
				}

				// Reuse a very recent failure rather than re-discovering it. Checked
				// only on this branch: a usable memo above never reaches Postgres, so
				// a blip can never take a served org offline — only callers that were
				// going to make the blocking read anyway are short-circuited.
				const failed = runtimeConfigFailures.get(orgId)
				if (failed !== undefined && nowMs - failed.atMs < ORG_CH_CONFIG_FAILURE_TTL_MS) {
					yield* Effect.annotateCurrentSpan({
						"clickhouse.config.source": "postgres_failed",
						"clickhouse.config.memoHit": false,
						"clickhouse.config.failure_reused": true,
					})
					return yield* Effect.fail(failed.error)
				}

				// Overwritten by `readSharedOrPostgres` on success; setting it first
				// leaves failures attributed to the Postgres compute path.
				yield* Effect.annotateCurrentSpan({
					"clickhouse.config.source": "postgres",
					"clickhouse.config.memoHit": false,
				})
				const cached = yield* readSharedOrPostgres(orgId).pipe(
					Effect.tapError((error) =>
						Effect.sync(() => runtimeConfigFailures.set(orgId, { error, atMs: nowMs })),
					),
				)
				runtimeConfigFailures.delete(orgId)
				storeCachedSettings(orgId, cached, nowMs)
				return cached
			},
		)

		const resolveRuntimeConfig = Effect.fn("OrgClickHouseSettingsService.resolveRuntimeConfig")(
			function* (orgId: OrgId) {
				const cached = yield* resolveCachedSettings(orgId)

				if (cached === null) {
					return Option.none<RuntimeBackendConfig>()
				}
				// Reads always use the org's ClickHouse when configured — we must NOT fall
				// back to Tinybird here, or we'd hide data already written to CH. But the
				// ingest gateway only *writes* to CH when `schema_version` matches the running
				// `clickHouseSchemaVersion`, so a stale value means ingest is silently landing
				// in Tinybird while we read CH. Surface that split as a span attribute for
				// alerting; the schemaDiff path self-heals the value when the live schema is
				// in sync.
				yield* Effect.annotateCurrentSpan(
					"clickhouse.schemaDrift",
					cached.schemaVersion !== clickHouseSchemaVersion,
				)
				const password = yield* decryptStoredPassword(cached)
				yield* validateClickHouseCredentialTransport(cached.chUrl, password).pipe(
					Effect.mapError(
						(cause) =>
							new OrgClickHouseSettingsStoredConfigInvalidError({
								message: cause.message,
								cause,
							}),
					),
				)
				return Option.some<RuntimeBackendConfig>({
					backend: "clickhouse",
					url: cached.chUrl,
					user: cached.chUser,
					password,
					database: cached.chDatabase,
				})
			},
		)

		// Mirror the ingest gateway's `clickhouse_ready` gate (apps/ingest/src/main.rs
		// `native_destination_for` + its routing query:
		// `sync_status = 'connected' AND schema_version = CLICKHOUSE_SCHEMA_VERSION`).
		// The gateway only writes an org's frames to its own ClickHouse when this
		// holds; otherwise it falls back to managed Tinybird. Reads of gateway-written
		// data (e.g. the Cloudflare poller's `metrics_sum` rows) must consult this same
		// gate so they resolve to the warehouse the write actually landed in.
		//
		// Unlike `resolveRuntimeConfig` — which deliberately ignores readiness because
		// the org's own collector writes traces/logs straight to its CH regardless —
		// this gate matters for data whose ONLY writer is the readiness-aware gateway.
		//
		// Deliberately NOT behind `resolveCachedSettings`, even though it is the same
		// row. That path memoizes per isolate for 5 minutes, and this gate decides
		// which warehouse a read is answered from: a stale `false` right after
		// onboarding flips sends reads to Tinybird while the gateway is already
		// writing to the org's ClickHouse, so the data silently goes missing until the
		// memo expires. It reads the narrow projection rather than `SELECT *`, but it
		// reads it fresh.
		const isWarehouseWriteReady = Effect.fn("OrgClickHouseSettingsService.isWarehouseWriteReady")(
			function* (orgId: OrgId) {
				const row = yield* selectCachedRow(orgId)
				return (
					Option.isSome(row) &&
					row.value.syncStatus === "connected" &&
					row.value.schemaVersion === clickHouseSchemaVersion
				)
			},
		)

		const collectorConfig = Effect.fn("OrgClickHouseSettingsService.collectorConfig")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireAdmin(roles)
			const row = yield* requireActiveRow(orgId)
			const password = yield* decryptStoredPassword(row)
			yield* validateClickHouseCredentialTransport(row.chUrl, password)
			const yaml = renderCollectorYaml({
				orgId,
				endpoint: row.chUrl,
				user: row.chUser,
				database: row.chDatabase,
			})
			return new OrgClickHouseCollectorConfigResponse({
				yaml,
				image: COLLECTOR_IMAGE_REF,
				passwordEnvVar: COLLECTOR_PASSWORD_ENV,
			})
		})

		return {
			get,
			upsert,
			delete: deleteSettings,
			schemaDiff,
			applySchema,
			applySchemaStatus,
			resolveRuntimeConfig,
			primeRuntimeConfigs,
			invalidateRuntimeConfig,
			isWarehouseWriteReady,
			collectorConfig,
		} satisfies OrgClickHouseSettingsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))

	static readonly get = (orgId: OrgId, roles: ReadonlyArray<RoleName>) =>
		this.use((service) => service.get(orgId, roles))

	static readonly upsert = (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		payload: OrgClickHouseSettingsUpsertRequest,
	) => this.use((service) => service.upsert(orgId, userId, roles, payload))

	static readonly delete = (orgId: OrgId, roles: ReadonlyArray<RoleName>) =>
		this.use((service) => service.delete(orgId, roles))

	static readonly resolveRuntimeConfig = (orgId: OrgId) =>
		this.use((service) => service.resolveRuntimeConfig(orgId))

	static readonly invalidateRuntimeConfig = (orgId: OrgId) =>
		this.use((service) => service.invalidateRuntimeConfig(orgId))

	static readonly isWarehouseWriteReady = (orgId: OrgId) =>
		this.use((service) => service.isWarehouseWriteReady(orgId))

	static readonly collectorConfig = (orgId: OrgId, roles: ReadonlyArray<RoleName>) =>
		this.use((service) => service.collectorConfig(orgId, roles))
}
