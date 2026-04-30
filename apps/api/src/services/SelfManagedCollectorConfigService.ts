import { orgTinybirdSettings } from "@maple/db"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { decryptAes256Gcm, parseBase64Aes256GcmKey } from "./Crypto"
import { Database } from "./DatabaseLive"
import { Env } from "./Env"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SelfManagedCollectorConfigError extends Schema.TaggedErrorClass<SelfManagedCollectorConfigError>()(
	"@maple/self-managed-collector/errors/ConfigError",
	{
		message: Schema.String,
	},
) {}

export class SelfManagedCollectorPublishError extends Schema.TaggedErrorClass<SelfManagedCollectorPublishError>()(
	"@maple/self-managed-collector/errors/PublishError",
	{
		message: Schema.String,
		statusCode: Schema.NullOr(Schema.Number),
	},
) {}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SelfManagedOrgExporter {
	readonly orgId: string
	readonly host: string
	readonly token: string
}

export interface SelfManagedCollectorConfigServiceShape {
	readonly generateConfig: () => Effect.Effect<string, SelfManagedCollectorConfigError>
	readonly publishConfig: () => Effect.Effect<
		{ readonly published: boolean; readonly orgCount: number },
		SelfManagedCollectorConfigError | SelfManagedCollectorPublishError
	>
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

const escapeYamlString = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

const isSafeOrgIdForYamlKey = (orgId: string): boolean => /^[a-zA-Z0-9_-]+$/.test(orgId)

/**
 * Render a self-managed collector config YAML from a deterministic list of
 * per-org exporter inputs. Pure: no I/O, no DB, no crypto. Given the same
 * input it always emits byte-identical output, so the collector can treat
 * "generated config unchanged" as a zero-cost reload.
 *
 * Output uses the OTel Collector Contrib `routing` connector to dispatch on
 * the `maple_org_id` resource attribute (set by the ingestor during
 * enrichment) to per-org `tinybird/<orgId>` exporters. Everything else falls
 * through to `tinybird/fallback` — which has no real upstream and logs a warn
 * on use. A customer that is disabled but still within the ingestor's 60s
 * cache TTL window will hit that fallback and drop, which is the documented
 * v1 behavior.
 */
export const renderCollectorConfig = (orgs: ReadonlyArray<SelfManagedOrgExporter>): string => {
	for (const exporter of orgs) {
		if (!isSafeOrgIdForYamlKey(exporter.orgId)) {
			throw new Error(`Unsafe orgId "${exporter.orgId}" cannot be used as a YAML/exporter key`)
		}
	}

	const sorted = [...orgs].sort((a, b) => a.orgId.localeCompare(b.orgId))

	// Fan-out architecture (no routing connector).
	//
	// Ingest already authenticates each payload's org via the ingest key and
	// decides per-request whether to forward to this pool — so by the time data
	// arrives here, the org is known to be self-managed. We previously used a
	// routing connector to dispatch by `maple_org_id` resource attribute to a
	// per-org tinybird exporter, but the connector's OTTL match silently
	// dropped 100% of traffic into the fallback (empirically observed) for
	// reasons we could not nail down in a reasonable amount of time.
	//
	// Simpler design: every org's tinybird exporter subscribes to the single
	// in-bound OTLP pipeline. Each exporter sends the full stream to its own
	// Tinybird instance. With one self-managed org (the common case), this is
	// trivially correct. With multiple self-managed orgs, *each* Tinybird would
	// receive all orgs' rows — so before we onboard a second BYO customer we
	// reintroduce proper routing (or switch to per-org collector instances for
	// hard tenant isolation). Tracked as a limitation in OPEN_ITEMS.
	const allTinybirdExporters = sorted.map((o) => `tinybird/${o.orgId}`).join(", ")

	const exporters = sorted
		.map(
			(o) =>
				`  tinybird/${o.orgId}:\n` +
				`    endpoint: ${escapeYamlString(o.host)}\n` +
				`    token: ${escapeYamlString(o.token)}\n` +
				`    timeout: 30s\n` +
				`    metrics:\n` +
				`      sum:\n` +
				`        datasource: metrics_sum\n` +
				`      gauge:\n` +
				`        datasource: metrics_gauge\n` +
				`      histogram:\n` +
				`        datasource: metrics_histogram\n` +
				`      exponential_histogram:\n` +
				`        datasource: metrics_exponential_histogram\n` +
				`    retry_on_failure:\n` +
				`      enabled: true\n` +
				`      initial_interval: 1s\n` +
				`      max_interval: 30s\n` +
				`      max_elapsed_time: 300s\n` +
				`    sending_queue:\n` +
				`      enabled: true\n` +
				`      num_consumers: 4\n` +
				`      queue_size: 10000\n` +
				`      storage: file_storage/queue`,
		)
		.join("\n")

	const hasOrgs = sorted.length > 0

	// The `routing` connector fails to start with an empty table, so when no
	// self-managed orgs are active we emit a degenerate config that skips the
	// connector entirely and drops everything straight to a debug exporter.
	// The collector still listens on OTLP so the ingestor's forward doesn't 5xx
	// — each payload just ends up in the fallback sink (warn log + drop) until
	// the first BYO sync activates and we regenerate with real routes.
	if (!hasOrgs) {
		return `# Auto-generated by SelfManagedCollectorConfigService.
# Do not hand-edit. Regenerated on every successful Tinybird BYO sync.
# No self-managed orgs are active — incoming payloads are dropped into
# debug/fallback until the first BYO activation regenerates this file.

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: "[::]:4317"
      http:
        endpoint: "[::]:4318"

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128
  batch:
    timeout: 1s
    send_batch_size: 5000
    send_batch_max_size: 10000

exporters:
  debug/fallback:
    verbosity: basic
    sampling_initial: 5
    sampling_thereafter: 500

extensions:
  file_storage/queue:
    directory: /var/lib/otelcol/file_storage
    create_directory: true
    timeout: 10s
    compaction:
      on_start: true
      on_rebound: true
  health_check:
    endpoint: "[::]:13133"

service:
  extensions: [health_check, file_storage/queue]

  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug/fallback]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug/fallback]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug/fallback]

  telemetry:
    logs:
      level: info
    metrics:
      level: none
`
	}

	return `# Auto-generated by SelfManagedCollectorConfigService.
# Do not hand-edit. Regenerated on every successful Tinybird BYO sync.

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: "[::]:4317"
      http:
        endpoint: "[::]:4318"

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128
  batch:
    timeout: 1s
    send_batch_size: 5000
    send_batch_max_size: 10000

exporters:
${exporters}

extensions:
  file_storage/queue:
    directory: /var/lib/otelcol/file_storage
    create_directory: true
    timeout: 10s
    compaction:
      on_start: true
      on_rebound: true
  health_check:
    endpoint: "[::]:13133"

service:
  extensions: [health_check, file_storage/queue]

  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [${allTinybirdExporters}]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [${allTinybirdExporters}]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [${allTinybirdExporters}]

  telemetry:
    logs:
      level: info
    metrics:
      level: none
`
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const toConfigError = (error: unknown): SelfManagedCollectorConfigError =>
	new SelfManagedCollectorConfigError({
		message: error instanceof Error ? error.message : String(error),
	})

export class SelfManagedCollectorConfigService extends Context.Service<
	SelfManagedCollectorConfigService,
	SelfManagedCollectorConfigServiceShape
>()("SelfManagedCollectorConfigService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) => new SelfManagedCollectorConfigError({ message }),
		)

		const publishUrl = Option.getOrUndefined(env.MAPLE_SELF_MANAGED_COLLECTOR_RELOAD_URL)
		const publishToken = Option.map(env.MAPLE_SELF_MANAGED_COLLECTOR_RELOAD_TOKEN, Redacted.value).pipe(
			Option.getOrUndefined,
		)

		const loadActiveExporters = Effect.fn("SelfManagedCollectorConfigService.loadActiveExporters")(
			function* () {
				const rows = yield* database
					.execute((db) =>
						db
							.select()
							.from(orgTinybirdSettings)
							.where(eq(orgTinybirdSettings.syncStatus, "active")),
					)
					.pipe(Effect.mapError(toConfigError))

				const exporters: SelfManagedOrgExporter[] = []
				for (const row of rows) {
					// Only Tinybird-backend rows produce a collector exporter — the
					// generated YAML configures the OTel `tinybird` exporter to push
					// to per-org Tinybird workspaces. ClickHouse-backend orgs run
					// their own ingest and don't need a Maple-managed collector
					// config entry.
					if (
						row.backend !== "tinybird" ||
						row.host === null ||
						row.tokenCiphertext === null ||
						row.tokenIv === null ||
						row.tokenTag === null
					) {
						continue
					}
					const token = yield* decryptAes256Gcm(
						{
							ciphertext: row.tokenCiphertext,
							iv: row.tokenIv,
							tag: row.tokenTag,
						},
						encryptionKey,
						(message) => new SelfManagedCollectorConfigError({ message }),
					)
					exporters.push({ orgId: row.orgId, host: row.host, token })
				}
				return exporters
			},
		)

		const generateConfig = Effect.fn("SelfManagedCollectorConfigService.generateConfig")(function* () {
			const exporters = yield* loadActiveExporters()
			return yield* Effect.try({
				try: () => renderCollectorConfig(exporters),
				catch: toConfigError,
			})
		})

		const publishConfig = Effect.fn("SelfManagedCollectorConfigService.publishConfig")(function* () {
			const exporters = yield* loadActiveExporters()
			const config = yield* Effect.try({
				try: () => renderCollectorConfig(exporters),
				catch: toConfigError,
			})

			if (!publishUrl || publishUrl.trim().length === 0) {
				// No reload target configured — this is a valid deployment topology
				// (e.g. when the ingest pool isn't wired yet). Generation still ran
				// successfully, so we report no-op rather than failing the sync.
				yield* Effect.logInfo(
					"Self-managed collector reload URL not configured; skipping publish",
				).pipe(Effect.annotateLogs({ orgCount: exporters.length }))
				return { published: false, orgCount: exporters.length }
			}

			yield* Effect.tryPromise({
				try: async () => {
					const response = await fetch(publishUrl, {
						method: "PUT",
						headers: {
							"content-type": "application/yaml",
							...(publishToken && publishToken.trim().length > 0
								? { authorization: `Bearer ${publishToken}` }
								: {}),
						},
						body: config,
					})
					if (!response.ok) {
						throw new SelfManagedCollectorPublishError({
							message: `Collector reload endpoint returned ${response.status}`,
							statusCode: response.status,
						})
					}
				},
				catch: (error) =>
					error instanceof SelfManagedCollectorPublishError
						? error
						: new SelfManagedCollectorPublishError({
								message: error instanceof Error ? error.message : String(error),
								statusCode: null,
							}),
			})

			return { published: true, orgCount: exporters.length }
		})

		return { generateConfig, publishConfig }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = this.layer
	static readonly Default = this.layer

	static readonly generateConfig = () => this.use((service) => service.generateConfig())

	static readonly publishConfig = () => this.use((service) => service.publishConfig())
}
