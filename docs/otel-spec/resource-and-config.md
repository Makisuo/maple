# Resource, Entities & SDK Configuration

This page is a compliance reference for the OpenTelemetry **Resource** model (what a "resource" is, how it's built and merged), the **resource semantic conventions** that matter most to Maple (`service.*`, `deployment.environment.name`, `telemetry.sdk.*`, plus summary-level `host.*`/`k8s.*`/`cloud.*`), the **SDK environment-variable spec** (the consolidated table is the centerpiece), the emerging **declarative/file configuration** mechanism, and the current **Entities** data model effort. It exists for spec-compliance checks and to back a best-practices skill — every non-obvious claim below carries an inline `Source:` link to the fetched spec page it was verified against.

## Relevance to Maple

- Maple is primarily a **consumer/backend** of OTel data (Rust `ingest` gateway → collector → ClickHouse/Tinybird → web dashboard), plus we **self-instrument** our own services (`apps/ingest`, the API, etc.) — so we need to both parse resources correctly from arbitrary SDKs _and_ emit spec-correct resources ourselves.
- **Dashboards key off `service.name` + `deployment.environment.name`.** The legacy `deployment.environment` attribute is deprecated (replaced by `deployment.environment.name`); our ingest gateway dual-emits both today, and every materialized view coalesces the two (`DEPLOYMENT_ENV_SQL` in `packages/domain/src/tinybird/semconv-renames.ts`, ClickHouse migration 0020) so telemetry carrying either key resolves to the same environment — see `CLAUDE.md`. This doc's deprecation citation below is the spec basis for eventually dropping the legacy emission, which now waits only on pre-0020 rows aging out and on BYO-ClickHouse schemas catching up.
- Our ingest gateway stamps a **vendor-namespaced** `maple_org_id` (and `maple.*` span attributes) — this is intentionally outside semconv (no `maple.*` resource semantic convention exists upstream), so it must never collide with a real OTel resource attribute name.
- We do not currently consume declarative/file configuration or the Entities data model, but both are tracked here because they affect how upstream SDKs will emit resources in the near future (Entities) and how our own self-instrumentation could be configured (file config).

---

## 1. Resource: definition, immutability, merge rules

**Stability: Stable** (the Resource SDK spec is stable except where individual parts are marked otherwise — resource _detector names_ are explicitly called out as Development).
Source: https://opentelemetry.io/docs/specs/otel/resource/sdk/

- **Definition:** a Resource is "an immutable representation of the observed entity for which telemetry is being produced, expressed as Attributes." Once created, a Resource cannot be modified.
- **Creation:** SDKs expose a `Create(attributes, schema_url)` factory. `schema_url` is optional and records the Schema URL associated with the emitted attributes.
- **Merge rule — critical for compliance checks:** when merging an _old_ resource with an _updating_ resource, "the value of the updating resource MUST be picked (even if the updated value is empty)." I.e., **the updating side always wins**, including overwriting a populated attribute with an empty one. Merge is not "fill in only missing keys."
- **Schema URL on merge:** combining two resources that carry **different, non-empty** schema URLs is a merging error — schema URLs must match (or one/both must be empty) for a clean merge.
- **`OTEL_RESOURCE_ATTRIBUTES`:** "The SDK MUST extract information from the `OTEL_RESOURCE_ATTRIBUTES` environment variable and merge this, as the secondary resource, with any resource information provided by the user." Format is `key1=value1,key2=value2`, percent-encoded for special characters — i.e. user-supplied/programmatic resource attributes win over the env var per the merge rule above (env var is the "old"/secondary side).
- **`OTEL_SERVICE_NAME`:** the `service` resource detector populates `service.name` from this env var; per the SDK environment variable spec (below), `OTEL_SERVICE_NAME` takes precedence over any `service.name` key set via `OTEL_RESOURCE_ATTRIBUTES`.
- **Default `service.name`:** if `service.name` is not otherwise specified, "SDKs MUST fallback to `unknown_service:` concatenated with the process executable name, e.g. `unknown_service:bash`." If the executable name is unavailable, the value degrades to plain `unknown_service`. (Note: many SDKs/docs colloquially write this as `unknown_service[:process]"`, which is what this pattern means in practice — the colon-joined executable name is included whenever known.)
  Source: https://opentelemetry.io/docs/specs/semconv/registry/attributes/service/

## 2. Resource data model (Entities-aware)

**Stability: Development.**
Source: https://opentelemetry.io/docs/specs/otel/resource/data-model/

The current logical Resource data model has two fields:

- `attributes` — the flat map of resource attribute key/values, which "MUST not change during the lifetime of the resource."
- `entities` — (newer, Development) a set of Entity objects the resource is composed of, per the Entities data model (§7). Resources also carry a `schema_url`, derived during entity merging: shared across all entities' schema URLs when they agree, left blank on conflict.

This model is the forward-looking replacement for "resource = flat attribute bag"; see §7 for the Entities effort itself.

## 3. Key resource semantic conventions

### 3.1 `service.*`

**Stability: Stable** for all four attributes below.
Source: https://opentelemetry.io/docs/specs/semconv/registry/attributes/service/

| Attribute             | Requirement | Notes                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `service.name`        | Recommended | "MUST be the same for all instances of horizontally scaled services." Falls back to `unknown_service:<process-executable-name>` if unset (see §1). Configurable via `OTEL_SERVICE_NAME` (SDK env var spec) or provided as a default by the SDK (Resource SDK spec).                                                                                                      |
| `service.namespace`   | Optional    | Logical grouping for a set of services; service names are expected to be unique **within** the same namespace. "Zero-length namespace string is assumed equal to unspecified namespace."                                                                                                                                                                                 |
| `service.version`     | Optional    | Version string of the service; format is undefined (examples: `2.0.0`, `a01dbef8a`).                                                                                                                                                                                                                                                                                     |
| `service.instance.id` | Optional    | "MUST be unique for each instance of the same `service.namespace`, `service.name` pair." Recommendation: generate a random **UUID v1 or v4** (RFC 4122), or derive a **UUID v5** from a stable namespace UUID (`4d63009a-8d0f-11ee-aad7-4c796ed8e320`) when a stable seed exists. Treat data like pod names, used as input to instance IDs, as potentially confidential. |

### 3.2 `deployment.environment.name` (and the legacy `deployment.environment` rename)

Source: https://opentelemetry.io/docs/specs/semconv/resource/deployment-environment/ and https://opentelemetry.io/docs/specs/semconv/registry/attributes/deployment/

- **`deployment.environment.name`** — **Stable**, Recommended, type `string`. "Name of the deployment environment (aka deployment tier)." Well-known values (all Stable): `development`, `production`, `staging`, `test` — a well-known value MUST be used when it applies; otherwise a custom value MAY be used.
- Explicit note: this attribute "does not affect the uniqueness constraints defined through the `service.namespace`, `service.name` and `service.instance.id` attributes" — i.e. the same logical service running in two environments is still considered the same service identity for uniqueness purposes; the environment is an orthogonal dimension.
- **Legacy `deployment.environment`** (no `.name`) is registered as **Deprecated**, with the exact registry note: **"Replaced by `deployment.environment.name`."** This is the citable spec basis for the rename Maple handles by dual-emitting both keys on the write side and coalescing them on every read (see `CLAUDE.md` self-observability section) — compliant new code should emit only `deployment.environment.name`.
- The broader "Deployment" resource/entity group itself is at **Development** status overall (per the resource semconv landing page), even though the two attributes above are individually Stable — Development status here reflects unfinished entity-role modeling, not attribute-level instability.

### 3.3 `telemetry.sdk.*` / `telemetry.distro.*`

**Stability: Stable** (both groups).
Source: https://opentelemetry.io/docs/specs/semconv/resource/

| Attribute                  | Requirement        | Notes                                                                                                                                                                                        |
| -------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `telemetry.sdk.name`       | Required (by SDKs) | "The OpenTelemetry SDK MUST set the `telemetry.sdk.name` attribute to `opentelemetry`." A non-OTel SDK claiming these attributes MUST instead use its own fully-qualified class/module name. |
| `telemetry.sdk.language`   | Required           | e.g. `cpp`, `dotnet`, `go`, `java`, `nodejs`, `python`, `rust`, `webjs`.                                                                                                                     |
| `telemetry.sdk.version`    | Required           | SDK version string, e.g. `1.2.3`.                                                                                                                                                            |
| `telemetry.distro.name`    | Recommended        | Name of the auto-instrumentation agent/distro, if used.                                                                                                                                      |
| `telemetry.distro.version` | Recommended        | Distro version string.                                                                                                                                                                       |

### 3.4 `host.*`, `k8s.*`, `cloud.*` — summary level

Full definitions: https://opentelemetry.io/docs/specs/semconv/resource/ (index; links to each group's registry page). Per-group stability below reflects each attribute's individual maturity badge, independent of the overall resource page's blanket "Development" note for these groups.

**`host.*`** — Source: https://opentelemetry.io/docs/specs/semconv/registry/attributes/host/ — all listed attributes currently **Development**: `host.name`, `host.id` (mandatory shape for cloud: provider's `instance_id`), `host.type` (cloud machine type), `host.arch`, `host.image.id`/`host.image.name`/`host.image.version`.

**`k8s.*`** — Source: https://opentelemetry.io/docs/specs/semconv/registry/attributes/k8s/ — the widely-used identity attributes are **Stable**: `k8s.cluster.name`, `k8s.cluster.uid`, `k8s.node.name`/`k8s.node.uid`, `k8s.namespace.name`, `k8s.pod.name`/`k8s.pod.uid`, `k8s.container.name`, `k8s.deployment.name`, `k8s.statefulset.name`, `k8s.daemonset.name`, `k8s.job.name`, `k8s.cronjob.name`. Newer additions are **Development**: `k8s.persistentvolume.name`, `k8s.persistentvolumeclaim.name`, `k8s.service.name`, `k8s.service.type`.

**`cloud.*`** — Source: https://opentelemetry.io/docs/specs/semconv/registry/attributes/cloud/ — all currently **Development**: `cloud.provider` (well-known values incl. `aws`/`azure`/`gcp`/`alibaba_cloud`, must use a well-known value when applicable), `cloud.platform` (e.g. `aws_lambda`, `gcp_cloud_run`), `cloud.region`, `cloud.account.id`, `cloud.availability_zone`, `cloud.resource_id` (provider-specific full identifier — ARN, etc.).

## 4. Common attribute spec (applies to resource _and_ span/log/metric attributes)

**Stability: Stable** (except where individually marked otherwise).
Source: https://opentelemetry.io/docs/specs/otel/common/

- **Permitted value types** for an attribute (`AnyValue`): primitive `string`, `boolean`, `double` (IEEE 754-1985), signed 64-bit `integer`; **homogeneous arrays** of those primitives; byte arrays; arrays of `AnyValue`; and `map<string, AnyValue>`.
- **Homogeneity rule (exact wording):** "A homogeneous array MUST NOT contain values of different types."
- **Empty values are meaningful:** empty strings, zero numbers, and empty arrays must be preserved through processors/exporters — they are not treated as "unset."
- **Null handling (exact wording):** "While `null` is a valid attribute value, its use within homogeneous arrays SHOULD generally be avoided unless language constraints make this impossible." If nulls do occur, "they MUST be preserved as-is (i.e., passed on to processors / exporters as `null`)" — nulls must not be silently dropped or coerced.
- **Attribute limits** (defaults, enforced by SDKs):
    - `AttributeCountLimit` — default **128** (max attributes per record).
    - `AttributeValueLengthLimit` — default **Infinity/no limit** (max length of string/byte-array values).
    - The count limit "applies only to top-level attributes, not to nested key-value pairs within maps."
    - **Resource attributes and metric attributes are explicitly exempt** from these SDK-enforced limits (relevant: don't assume `OTEL_ATTRIBUTE_COUNT_LIMIT` truncates a resource — it doesn't, per this spec section, though exporters/backends may impose their own caps).

## 5. SDK environment-variable spec (consolidated table)

**Stability: Stable, except where individually marked otherwise** (e.g. some newer/experimental vars).
Source: https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/ (OTLP-exporter-specific vars: https://opentelemetry.io/docs/specs/otel/protocol/exporter/, status **Stable**)

### General SDK

| Variable                   | Default                | Notes                                                                                                                   |
| -------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `OTEL_SDK_DISABLED`        | `false`                | Disables the SDK (all signals become no-ops) when `true`.                                                               |
| `OTEL_LOG_LEVEL`           | `info`                 | Controls the SDK's own internal diagnostic logging.                                                                     |
| `OTEL_RESOURCE_ATTRIBUTES` | _(unset)_              | `key1=value1,key2=value2`, percent-encoded; merged as the "secondary"/old resource (user-supplied wins per merge rule). |
| `OTEL_SERVICE_NAME`        | _(unset)_              | Sets `service.name`; takes precedence over a `service.name` set via `OTEL_RESOURCE_ATTRIBUTES`.                         |
| `OTEL_PROPAGATORS`         | `tracecontext,baggage` | Comma-separated, deduplicated propagator list.                                                                          |

### Exporter selection

| Variable                | Default |
| ----------------------- | ------- |
| `OTEL_TRACES_EXPORTER`  | `otlp`  |
| `OTEL_METRICS_EXPORTER` | `otlp`  |
| `OTEL_LOGS_EXPORTER`    | `otlp`  |

### Sampling

| Variable                  | Default                 | Notes                                                                                                                                                                 |
| ------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_TRACES_SAMPLER`     | `parentbased_always_on` | e.g. `parentbased_traceidratio`, `always_on`, `always_off`, `traceidratio`.                                                                                           |
| `OTEL_TRACES_SAMPLER_ARG` | _(unset)_               | Argument shape depends on the chosen sampler (e.g. a ratio `0.1` for `traceidratio`/`parentbased_traceidratio` — used at high QPS by `apps/ingest`, per `CLAUDE.md`). |

### Batch Span Processor (BSP)

| Variable                         | Default  |
| -------------------------------- | -------- |
| `OTEL_BSP_SCHEDULE_DELAY`        | 5000 ms  |
| `OTEL_BSP_EXPORT_TIMEOUT`        | 30000 ms |
| `OTEL_BSP_MAX_QUEUE_SIZE`        | 2048     |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | 512      |

### Batch LogRecord Processor (BLRP)

| Variable                          | Default  |
| --------------------------------- | -------- |
| `OTEL_BLRP_SCHEDULE_DELAY`        | 1000 ms  |
| `OTEL_BLRP_EXPORT_TIMEOUT`        | 30000 ms |
| `OTEL_BLRP_MAX_QUEUE_SIZE`        | 2048     |
| `OTEL_BLRP_MAX_EXPORT_BATCH_SIZE` | 512      |

### Periodic Metric Reader

| Variable                      | Default  |
| ----------------------------- | -------- |
| `OTEL_METRIC_EXPORT_INTERVAL` | 60000 ms |
| `OTEL_METRIC_EXPORT_TIMEOUT`  | 30000 ms |

### Attribute / span / log-record limits

| Variable                                      | Default  | Scope                                               |
| --------------------------------------------- | -------- | --------------------------------------------------- |
| `OTEL_ATTRIBUTE_COUNT_LIMIT`                  | 128      | General fallback attribute count limit              |
| `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT`           | no limit | General fallback value length limit                 |
| `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT`             | 128      | Per-span override of the general count limit        |
| `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT`      | no limit | Per-span override of the general length limit       |
| `OTEL_SPAN_EVENT_COUNT_LIMIT`                 | 128      | Max span events                                     |
| `OTEL_SPAN_LINK_COUNT_LIMIT`                  | 128      | Max span links                                      |
| `OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT`            | 128      | Max attributes per span event                       |
| `OTEL_LINK_ATTRIBUTE_COUNT_LIMIT`             | 128      | Max attributes per span link                        |
| `OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT`        | 128      | Per-log-record override of the general count limit  |
| `OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT` | no limit | Per-log-record override of the general length limit |

Recall from §4: resource attributes and metric attributes are exempt from all count/length limits above.

### OTLP exporter configuration (base + per-signal `TRACES`/`METRICS`/`LOGS` variants)

Base variable applies to all signals unless a signal-specific variant overrides it. Signal-specific endpoint variables are used **as-is** (no path suffix appended); the base endpoint variable gets `/v1/traces`, `/v1/metrics`, or `/v1/logs` appended automatically per signal.

| Variable (base; suffix each with `_TRACES_`/`_METRICS_`/`_LOGS_` for per-signal override) | Default                                                         |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                                             | `http://localhost:4318` (HTTP) / `http://localhost:4317` (gRPC) |
| `OTEL_EXPORTER_OTLP_PROTOCOL`                                                             | `http/protobuf`                                                 |
| `OTEL_EXPORTER_OTLP_HEADERS`                                                              | _(unset)_; W3C Baggage-style `key=value` pairs                  |
| `OTEL_EXPORTER_OTLP_COMPRESSION`                                                          | _(unset)_; `none` or `gzip`                                     |
| `OTEL_EXPORTER_OTLP_TIMEOUT`                                                              | 10 s                                                            |
| `OTEL_EXPORTER_OTLP_INSECURE`                                                             | `false` (gRPC only)                                             |
| `OTEL_EXPORTER_OTLP_CERTIFICATE`                                                          | _(unset)_ — trusted server cert for TLS verification            |
| `OTEL_EXPORTER_OTLP_CLIENT_KEY`                                                           | _(unset)_ — client private key (PEM), mTLS                      |
| `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE`                                                   | _(unset)_ — client cert/chain (PEM), mTLS                       |

Note: "SDKs SHOULD default endpoint variables to use `http` scheme unless they have good reasons to choose `https` scheme."

## 6. Declarative / file configuration

**Stability: the core schema is now Stable** (JSON schema, YAML file representation, in-memory representation, `ConfigProperties`, `PluginComponentProvider`, and the SDK `Parse`/`Create` operations were stabilized alongside an `opentelemetry-configuration` `1.0.0` release, announced 2026). Portions still evolving are explicitly namespaced `.../development` in the schema so stable and experimental parts can coexist.
Sources: https://opentelemetry.io/blog/2026/stable-declarative-config/ , https://opentelemetry.io/docs/specs/otel/configuration/sdk/ , https://opentelemetry.io/docs/specs/otel/configuration/

- **Mechanism:** the SDK exposes a two-step `Parse` (reads/validates a YAML file, performs env-var substitution, returns an in-memory config model) → `Create` (instantiates `TracerProvider`/`MeterProvider`/`LoggerProvider`/propagators from that model) flow.
- **File format:** YAML, validated against the `opentelemetry-configuration` JSON Schema.
- **Env var to opt in / point at a file:** **`OTEL_CONFIG_FILE`** (the stabilized name — treat any reference to `OTEL_EXPERIMENTAL_CONFIG_FILE` as the older/language-specific pre-stabilization spelling; some SDKs may still only support the experimental name until they finish adopting `1.0.0`).
- **Positioning vs. env vars:** declarative config is described as "more expressive and full-featured than the environment variable based scheme." The spec's own stated direction is to eventually "deprecate environment variables which don't interoperate well" with file config, but the pages fetched do **not** spell out a precise precedence/merge rule for the case where both an env-var-based and a file-based configuration are present simultaneously — treat that as unverified/TBD rather than assume a specific precedence.
- **Language implementation status (as of the stabilization blog post):** C++, Go, Java, JavaScript, and PHP have implementations; .NET and Python are in progress. The Go implementation is also reused by the Collector for its own internal telemetry configuration.
- **Maple relevance:** not currently used anywhere in this repo; noted here so future self-instrumentation config changes can cite the correct stable env var (`OTEL_CONFIG_FILE`) rather than the deprecated experimental name.

## 7. Entities

**Stability: Development** (the whole effort — overview and data model pages both carry an explicit `Status: Development` marker).
Sources: https://opentelemetry.io/docs/specs/otel/entities/ , https://opentelemetry.io/docs/specs/otel/entities/data-model/

- **Purpose:** a common data model for "entities" — objects of interest associated with produced telemetry (e.g. a `service`, `host`, `k8s.pod`, `k8s.cluster`) — so multiple distinct-but-related components can be represented within the same signal's resource, each with its own identity and metadata, rather than flattening everything into one undifferentiated attribute bag.
- **Data model fields:**
    - `type` — required, immutable string category (e.g. `"service"`, `"host"`).
    - `id` — a map of identifying attributes; "must contain at least one attribute" and should be the minimal attribute set sufficient to uniquely identify the entity.
    - `description` — a map of descriptive, non-identifying attributes that may change over time and may be empty.
- **Relationship to Resource:** entities are attached in the resource section of a signal and reference the same shared attribute pool defined by Resource — this preserves backward compatibility with existing Resource-attribute consumers while avoiding duplicating identifying data across multiple entities on the same signal.
- **Instantiation models:** _pull-based_ (an entity discovers itself from the current runtime/environment — analogous to today's resource detectors) and _push-based_ (entity info supplied externally, typically via environment variables or declarative configuration).
- **Practical takeaway for Maple:** this is not yet something ClickHouse/Tinybird ingestion needs to model explicitly (Development stability, not yet emitted by mainstream SDKs by default), but the ingest gateway's resource-attribute parsing should not assume the Resource model stays a flat attribute-only bag forever — the `entities` field on the Resource data model (§2) is the forward path.

---

## Key references

- Resource SDK spec: https://opentelemetry.io/docs/specs/otel/resource/sdk/
- Resource data model: https://opentelemetry.io/docs/specs/otel/resource/data-model/
- Resource semantic conventions (index): https://opentelemetry.io/docs/specs/semconv/resource/
- Service attributes registry: https://opentelemetry.io/docs/specs/semconv/registry/attributes/service/
- Deployment environment semconv: https://opentelemetry.io/docs/specs/semconv/resource/deployment-environment/
- Deployment attributes registry (deprecation note source): https://opentelemetry.io/docs/specs/semconv/registry/attributes/deployment/
- Host attributes registry: https://opentelemetry.io/docs/specs/semconv/registry/attributes/host/
- Kubernetes attributes registry: https://opentelemetry.io/docs/specs/semconv/registry/attributes/k8s/
- Cloud attributes registry: https://opentelemetry.io/docs/specs/semconv/registry/attributes/cloud/
- Common (attribute) spec: https://opentelemetry.io/docs/specs/otel/common/
- SDK environment variables spec: https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
- OTLP exporter configuration (env vars): https://opentelemetry.io/docs/specs/otel/protocol/exporter/
- Configuration overview (declarative config positioning): https://opentelemetry.io/docs/specs/otel/configuration/
- Configuration SDK (Parse/Create, `OTEL_CONFIG_FILE`): https://opentelemetry.io/docs/specs/otel/configuration/sdk/
- Declarative configuration stabilization announcement: https://opentelemetry.io/blog/2026/stable-declarative-config/
- Entities overview: https://opentelemetry.io/docs/specs/otel/entities/
- Entities data model: https://opentelemetry.io/docs/specs/otel/entities/data-model/
