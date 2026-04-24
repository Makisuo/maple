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
  readonly generateConfig: () => Effect.Effect<
    string,
    SelfManagedCollectorConfigError
  >
  readonly publishConfig: () => Effect.Effect<
    { readonly published: boolean; readonly orgCount: number },
    SelfManagedCollectorConfigError | SelfManagedCollectorPublishError
  >
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

const escapeYamlString = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

const isSafeOrgIdForYamlKey = (orgId: string): boolean =>
  /^[a-zA-Z0-9_-]+$/.test(orgId)

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
export const renderCollectorConfig = (
  orgs: ReadonlyArray<SelfManagedOrgExporter>,
): string => {
  for (const exporter of orgs) {
    if (!isSafeOrgIdForYamlKey(exporter.orgId)) {
      throw new Error(
        `Unsafe orgId "${exporter.orgId}" cannot be used as a YAML/exporter key`,
      )
    }
  }

  const sorted = [...orgs].sort((a, b) => a.orgId.localeCompare(b.orgId))

  // OTel Contrib's routing connector is signal-scoped: one connector instance
  // per signal type. A single `routing:` that lists pipelines for traces +
  // logs + metrics fails with "missing consumer" because each signal's
  // instantiation only matches its own pipelines. Emit three instances
  // (routing/traces, routing/logs, routing/metrics) with signal-matching
  // default_pipelines + tables.
  const routingTableForSignal = (signal: "traces" | "logs" | "metrics") =>
    sorted
      .map((o) =>
        `      - context: resource\n` +
        `        statement: route() where attributes["maple_org_id"] == ${escapeYamlString(o.orgId)}\n` +
        `        pipelines: [${signal}/${o.orgId}]`,
      )
      .join("\n")

  const routingConnectors =
    (["traces", "logs", "metrics"] as const)
      .map(
        (signal) =>
          `  routing/${signal}:\n` +
          `    default_pipelines: [${signal}/fallback]\n` +
          `    error_mode: ignore\n` +
          `    table:\n` +
          routingTableForSignal(signal),
      )
      .join("\n")

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

  const perOrgPipelines = sorted
    .flatMap((o) => [
      `    traces/${o.orgId}:\n` +
        `      receivers: [routing/traces]\n` +
        `      processors: [batch]\n` +
        `      exporters: [tinybird/${o.orgId}]`,
      `    logs/${o.orgId}:\n` +
        `      receivers: [routing/logs]\n` +
        `      processors: [batch]\n` +
        `      exporters: [tinybird/${o.orgId}]`,
      `    metrics/${o.orgId}:\n` +
        `      receivers: [routing/metrics]\n` +
        `      processors: [batch]\n` +
        `      exporters: [tinybird/${o.orgId}]`,
    ])
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

connectors:
${routingConnectors}

exporters:
${exporters}
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
    traces/in:
      receivers: [otlp]
      processors: [memory_limiter]
      exporters: [routing/traces]
    logs/in:
      receivers: [otlp]
      processors: [memory_limiter]
      exporters: [routing/logs]
    metrics/in:
      receivers: [otlp]
      processors: [memory_limiter]
      exporters: [routing/metrics]
${perOrgPipelines}
    traces/fallback:
      receivers: [routing/traces]
      processors: [batch]
      exporters: [debug/fallback]
    logs/fallback:
      receivers: [routing/logs]
      processors: [batch]
      exporters: [debug/fallback]
    metrics/fallback:
      receivers: [routing/metrics]
      processors: [batch]
      exporters: [debug/fallback]

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
      (message) =>
        new SelfManagedCollectorConfigError({ message }),
    )

    const publishUrl = Option.getOrUndefined(
      env.MAPLE_SELF_MANAGED_COLLECTOR_RELOAD_URL,
    )
    const publishToken = Option.map(
      env.MAPLE_SELF_MANAGED_COLLECTOR_RELOAD_TOKEN,
      Redacted.value,
    ).pipe(Option.getOrUndefined)

    const loadActiveExporters = Effect.fn(
      "SelfManagedCollectorConfigService.loadActiveExporters",
    )(function* () {
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
    })

    const generateConfig = Effect.fn(
      "SelfManagedCollectorConfigService.generateConfig",
    )(function* () {
      const exporters = yield* loadActiveExporters()
      return yield* Effect.try({
        try: () => renderCollectorConfig(exporters),
        catch: toConfigError,
      })
    })

    const publishConfig = Effect.fn(
      "SelfManagedCollectorConfigService.publishConfig",
    )(function* () {
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
                message:
                  error instanceof Error ? error.message : String(error),
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

  static readonly generateConfig = () =>
    this.use((service) => service.generateConfig())

  static readonly publishConfig = () =>
    this.use((service) => service.publishConfig())
}
