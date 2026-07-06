import { defineDatasource, t, engine, column, type InferRow } from "@tinybirdco/sdk"

/**
 * OpenTelemetry logs datasource
 * Matches the official OpenTelemetry Collector Tinybird exporter format
 */
export const logs = defineDatasource("logs", {
	description: "This is a table that contains the logs from the OpenTelemetry Collector.",
	schema: {
		OrgId: column(t.string().lowCardinality(), {
			jsonPath: "$.resource_attributes.maple_org_id",
		}),
		Timestamp: column(t.dateTime64(9), { jsonPath: "$.timestamp" }),
		TimestampTime: column(t.dateTime(), { jsonPath: "$.timestamp" }),
		TraceId: column(t.string(), { jsonPath: "$.trace_id" }),
		SpanId: column(t.string(), { jsonPath: "$.span_id" }),
		TraceFlags: column(t.uint8(), { jsonPath: "$.flags" }),
		SeverityText: column(t.string().lowCardinality(), {
			jsonPath: "$.severity_text",
		}),
		SeverityNumber: column(t.uint8(), { jsonPath: "$.severity_number" }),
		ServiceName: column(t.string().lowCardinality(), {
			jsonPath: "$.service_name",
		}),
		Body: column(t.string(), { jsonPath: "$.body" }),
		ResourceSchemaUrl: column(t.string(), { jsonPath: "$.resource_schema_url" }),
		ResourceAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.resource_attributes",
		}),
		ScopeSchemaUrl: column(t.string(), { jsonPath: "$.scope_schema_url" }),
		ScopeName: column(t.string(), { jsonPath: "$.scope_name" }),
		ScopeVersion: column(t.string(), { jsonPath: "$.scope_version" }),
		ScopeAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.scope_attributes",
		}),
		LogAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.log_attributes",
		}),
	},
	// `TraceId` is not in the sorting key and a trace spans many services (so
	// `ServiceName` isn't fixed either) — a `WHERE TraceId = ...` lookup would
	// otherwise scan whole daily partitions. The bloom filter lets ClickHouse
	// skip granules that don't contain the trace, mirroring `traces.idx_trace_id`.
	indexes: [
		{
			name: "idx_trace_id",
			expr: "TraceId",
			type: "bloom_filter(0.01)",
			granularity: 1,
		},
	],
	engine: engine.mergeTree({
		partitionKey: "toDate(TimestampTime)",
		sortingKey: ["OrgId", "ServiceName", "TimestampTime", "Timestamp"],
		ttl: "toDate(TimestampTime) + INTERVAL 30 DAY",
	}),
})

export type LogsRow = InferRow<typeof logs>

/**
 * Sampling weight expression. Resolution priority:
 *   1. Explicit `SpanAttributes['SampleRate']` (collector-set, takes precedence)
 *   2. W3C TraceState `th:<hex>` threshold sampling
 *   3. Default 1.0 (unsampled)
 *
 * Used in two places:
 *   - As the `SampleRate` column DEFAULT expression on the `traces` datasource
 *     (computes for future inserts that don't supply the field)
 *   - In the `traces` FORWARD_QUERY (backfills existing rows when the column
 *     is added)
 *
 * Both must produce identical values per row, so the expression is hoisted
 * here. If you change one, change the other.
 *
 * The query engine sums this column directly (`sum(SampleRate)`) to compute
 * sampling-aware throughput, so the SQL math here is load-bearing for the
 * dashboard's "Estimated" series. See
 * apps/api/src/services/QueryEngineService.sampling.test.ts for the parity
 * tests that pin down expected weights.
 */
const SAMPLE_RATE_EXPR =
	"multiIf(" +
	"SpanAttributes['SampleRate'] != '' AND toFloat64OrZero(SpanAttributes['SampleRate']) >= 1.0, " +
	"toFloat64OrZero(SpanAttributes['SampleRate']), " +
	"match(TraceState, 'th:[0-9a-f]+'), " +
	"1.0 / greatest(" +
	"1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), " +
	"0.0001" +
	"), " +
	"1.0" +
	")"

const IS_ENTRY_POINT_EXPR = "if(SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '', 1, 0)"

/**
 * OpenTelemetry traces datasource
 * Matches the official OpenTelemetry Collector Tinybird exporter format
 */
export const traces = defineDatasource("traces", {
	description: "A table that contains trace data from OpenTelemetry in Tinybird format.",
	schema: {
		OrgId: column(t.string().lowCardinality(), {
			jsonPath: "$.resource_attributes.maple_org_id",
		}),
		Timestamp: column(t.dateTime64(9), { jsonPath: "$.start_time" }),
		TraceId: column(t.string(), { jsonPath: "$.trace_id" }),
		SpanId: column(t.string(), { jsonPath: "$.span_id" }),
		ParentSpanId: column(t.string(), { jsonPath: "$.parent_span_id" }),
		TraceState: column(t.string(), { jsonPath: "$.trace_state" }),
		SpanName: column(t.string().lowCardinality(), { jsonPath: "$.span_name" }),
		SpanKind: column(t.string().lowCardinality(), { jsonPath: "$.span_kind" }),
		ServiceName: column(t.string().lowCardinality(), {
			jsonPath: "$.service_name",
		}),
		ResourceSchemaUrl: column(t.string(), { jsonPath: "$.resource_schema_url" }),
		ResourceAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.resource_attributes",
		}),
		ScopeSchemaUrl: column(t.string(), { jsonPath: "$.scope_schema_url" }),
		ScopeName: column(t.string(), { jsonPath: "$.scope_name" }),
		ScopeVersion: column(t.string(), { jsonPath: "$.scope_version" }),
		ScopeAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.scope_attributes",
		}),
		Duration: column(t.uint64().default(0), { jsonPath: "$.duration" }),
		StatusCode: column(t.string().lowCardinality(), {
			jsonPath: "$.status_code",
		}),
		StatusMessage: column(t.string(), { jsonPath: "$.status_message" }),
		SpanAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.span_attributes",
		}),
		EventsTimestamp: column(t.array(t.dateTime64(9)), {
			jsonPath: "$.events_timestamp[:]",
		}),
		EventsName: column(t.array(t.string().lowCardinality()), {
			jsonPath: "$.events_name[:]",
		}),
		EventsAttributes: column(t.array(t.map(t.string().lowCardinality(), t.string())), {
			jsonPath: "$.events_attributes[:]",
		}),
		LinksTraceId: column(t.array(t.string()), {
			jsonPath: "$.links_trace_id[:]",
		}),
		LinksSpanId: column(t.array(t.string()), {
			jsonPath: "$.links_span_id[:]",
		}),
		LinksTraceState: column(t.array(t.string()), {
			jsonPath: "$.links_trace_state[:]",
		}),
		LinksAttributes: column(t.array(t.map(t.string().lowCardinality(), t.string())), {
			jsonPath: "$.links_attributes[:]",
		}),
		/**
		 * Sampling weight per span. >= 1.0 means "this stored row represents
		 * SampleRate population spans". Used by `quantilesTDigestWeighted`,
		 * `sumIf(SampleRate, ...)` etc. for sample-aware aggregations.
		 *
		 * Expression hoisted to SAMPLE_RATE_EXPR — same value populated on
		 * existing rows via FORWARD_QUERY.
		 */
		SampleRate: t.float64().defaultExpr(SAMPLE_RATE_EXPR),
		/**
		 * Entry-point predicate as a queryable dimension. True for spans that
		 * begin a request from the perspective of the receiving service:
		 * Server/Consumer kinds, or any root span (ParentSpanId = '').
		 */
		IsEntryPoint: t.uint8().defaultExpr(IS_ENTRY_POINT_EXPR),
	},
	indexes: [
		{
			name: "idx_trace_id",
			expr: "TraceId",
			type: "bloom_filter(0.01)",
			granularity: 1,
		},
		{
			name: "idx_span_attr_keys",
			expr: "mapKeys(SpanAttributes)",
			type: "bloom_filter(0.01)",
			granularity: 1,
		},
		{
			name: "idx_span_attr_vals",
			expr: "mapValues(SpanAttributes)",
			type: "bloom_filter(0.01)",
			granularity: 1,
		},
		{
			name: "idx_resource_attr_keys",
			expr: "mapKeys(ResourceAttributes)",
			type: "bloom_filter(0.01)",
			granularity: 1,
		},
		{
			name: "idx_resource_attr_vals",
			expr: "mapValues(ResourceAttributes)",
			type: "bloom_filter(0.01)",
			granularity: 1,
		},
	],
	engine: engine.mergeTree({
		partitionKey: "toDate(Timestamp)",
		sortingKey: ["OrgId", "ServiceName", "SpanName", "toDateTime(Timestamp)"],
		ttl: "toDate(Timestamp) + INTERVAL 30 DAY",
	}),
})

export type TracesRow = InferRow<typeof traces>

/**
 * Service usage aggregation datasource
 * Populated via materialized views, no JSON ingestion
 */
export const serviceUsage = defineDatasource("service_usage", {
	description:
		"Aggregated usage statistics per service per hour. Uses SummingMergeTree for efficient incremental updates from multiple materialized views.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		ServiceName: t.string().lowCardinality(),
		Hour: t.dateTime(),
		LogCount: t.uint64(),
		LogSizeBytes: t.uint64(),
		TraceCount: t.uint64(),
		TraceSizeBytes: t.uint64(),
		SumMetricCount: t.uint64(),
		SumMetricSizeBytes: t.uint64(),
		GaugeMetricCount: t.uint64(),
		GaugeMetricSizeBytes: t.uint64(),
		HistogramMetricCount: t.uint64(),
		HistogramMetricSizeBytes: t.uint64(),
		ExpHistogramMetricCount: t.uint64(),
		ExpHistogramMetricSizeBytes: t.uint64(),
	},
	forwardQuery: `SELECT *`,
	engine: engine.summingMergeTree({
		sortingKey: ["OrgId", "ServiceName", "Hour"],
		ttl: "Hour + INTERVAL 365 DAY",
	}),
})

export type ServiceUsageRow = InferRow<typeof serviceUsage>

/**
 * Lightweight projection of traces for service map JOIN queries.
 * Pre-extracts deployment.environment from Map columns.
 * Sorted by (OrgId, TraceId, SpanId) to align with the JOIN key.
 * Populated by materialized view, not direct ingestion.
 */
export const serviceMapSpans = defineDatasource("service_map_spans", {
	description:
		"Lightweight projection of traces for service map JOIN queries. Pre-extracts deployment.environment from Map columns. Populated by materialized view.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Timestamp: t.dateTime(),
		TraceId: t.string(),
		SpanId: t.string(),
		ParentSpanId: t.string(),
		ServiceName: t.string().lowCardinality(),
		SpanKind: t.string().lowCardinality(),
		Duration: t.uint64(),
		StatusCode: t.string().lowCardinality(),
		TraceState: t.string(),
		DeploymentEnv: t.string().lowCardinality(),
	},
	engine: engine.mergeTree({
		partitionKey: "toDate(Timestamp)",
		sortingKey: ["OrgId", "TraceId", "SpanId", "Timestamp"],
		ttl: "Timestamp + INTERVAL 30 DAY",
	}),
})

export type ServiceMapSpansRow = InferRow<typeof serviceMapSpans>

/**
 * Server/Consumer spans with ParentSpanId for efficient service map child-side JOIN lookups.
 * Pre-filters to only Server/Consumer spans with a parent at write time,
 * sorted by (OrgId, TraceId, ParentSpanId) to align with the JOIN key.
 * Populated by materialized view, not direct ingestion.
 */
export const serviceMapChildren = defineDatasource("service_map_children", {
	description:
		"Server/Consumer spans with ParentSpanId for efficient service map child-side JOIN lookups. Populated by materialized view.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Timestamp: t.dateTime(),
		TraceId: t.string(),
		ParentSpanId: t.string(),
		ServiceName: t.string().lowCardinality(),
		SpanKind: t.string().lowCardinality(),
		Duration: t.uint64(),
		StatusCode: t.string().lowCardinality(),
		TraceState: t.string(),
		DeploymentEnv: t.string().lowCardinality(),
	},
	engine: engine.mergeTree({
		partitionKey: "toDate(Timestamp)",
		sortingKey: ["OrgId", "TraceId", "ParentSpanId", "Timestamp"],
		ttl: "Timestamp + INTERVAL 30 DAY",
	}),
})

export type ServiceMapChildrenRow = InferRow<typeof serviceMapChildren>

/**
 * Pre-aggregated hourly service-to-service edges for the service map.
 * One row per (OrgId, Hour, SourceService, TargetService, DeploymentEnv) so the
 * service map query reads ~hundreds of hourly rows instead of millions of
 * individual spans. Uses AggregatingMergeTree with SimpleAggregateFunction
 * columns for correct incremental merging of sum/max aggregates.
 *
 * Populated by the scheduled hourly rollup in `ServiceMapRollupService` — NOT
 * by a materialized view. The edge target service is recovered via a
 * Client/Producer-span → child Server/Consumer-span join, which an MV cannot
 * express. The rollup writes each completed hour exactly once (watermarked).
 */
export const serviceMapEdgesHourly = defineDatasource("service_map_edges_hourly", {
	description:
		"Pre-aggregated hourly service-to-service edges for the service map. Uses AggregatingMergeTree for incremental aggregation. Populated by the scheduled ServiceMapRollupService rollup (one write per completed hour).",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Hour: t.dateTime(),
		SourceService: t.string().lowCardinality(),
		TargetService: t.string(),
		DeploymentEnv: t.string().lowCardinality(),
		CallCount: t.simpleAggregateFunction("sum", t.uint64()),
		ErrorCount: t.simpleAggregateFunction("sum", t.uint64()),
		DurationSumMs: t.simpleAggregateFunction("sum", t.float64()),
		MaxDurationMs: t.simpleAggregateFunction("max", t.float64()),
		SampledSpanCount: t.simpleAggregateFunction("sum", t.uint64()),
		UnsampledSpanCount: t.simpleAggregateFunction("sum", t.uint64()),
		SampleRateSum: t.simpleAggregateFunction("sum", t.float64()),
	},
	engine: engine.aggregatingMergeTree({
		partitionKey: "toDate(Hour)",
		sortingKey: ["OrgId", "Hour", "DeploymentEnv", "SourceService", "TargetService"],
		ttl: "toDate(Hour) + INTERVAL 90 DAY",
	}),
})

export type ServiceMapEdgesHourlyRow = InferRow<typeof serviceMapEdgesHourly>

/**
 * Pre-aggregated hourly service-to-database edges for the service map.
 * Aggregates Client/Producer spans with `db.system.name` set at write time so
 * the service map's database-node query reads ~hundreds of rows per window instead
 * of millions of individual spans. Mirrors `service_map_edges_hourly` in
 * structure; one row per (OrgId, Hour, ServiceName, DbSystem, DeploymentEnv).
 * Populated by materialized view, not direct ingestion.
 */
export const serviceMapDbEdgesHourly = defineDatasource("service_map_db_edges_hourly", {
	description:
		"Pre-aggregated hourly service-to-database edges (one row per service/db.system.name) for the service map's database-node query. Uses AggregatingMergeTree for incremental aggregation. Populated by materialized view.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Hour: t.dateTime(),
		ServiceName: t.string().lowCardinality(),
		DbSystem: t.string().lowCardinality(),
		DeploymentEnv: t.string().lowCardinality(),
		CallCount: t.simpleAggregateFunction("sum", t.uint64()),
		ErrorCount: t.simpleAggregateFunction("sum", t.uint64()),
		DurationSumMs: t.simpleAggregateFunction("sum", t.float64()),
		MaxDurationMs: t.simpleAggregateFunction("max", t.float64()),
		SampledSpanCount: t.simpleAggregateFunction("sum", t.uint64()),
		UnsampledSpanCount: t.simpleAggregateFunction("sum", t.uint64()),
		SampleRateSum: t.simpleAggregateFunction("sum", t.float64()),
	},
	// The 90d rollup TTL outlives the 30d `traces` source, so a deploy that
	// re-points the MV can't reconstruct the full window from `traces`. Carry
	// existing rows forward (non-destructive) instead — same pattern as the other
	// hourly rollups (`service_map_db_query_shapes_hourly`, `logs_aggregates_hourly`,
	// `service_platforms_hourly`).
	forwardQuery: `SELECT *`,
	engine: engine.aggregatingMergeTree({
		partitionKey: "toDate(Hour)",
		sortingKey: ["OrgId", "Hour", "DeploymentEnv", "ServiceName", "DbSystem"],
		ttl: "toDate(Hour) + INTERVAL 90 DAY",
	}),
})

export type ServiceMapDbEdgesHourlyRow = InferRow<typeof serviceMapDbEdgesHourly>

/**
 * Pre-aggregated hourly database *query shapes* for the service map's database
 * detail panel ("Query Activity" + "Top Query Shapes"). One row per
 * (OrgId, Hour, ServiceName, DbSystem, DeploymentEnv, QueryKey) where `QueryKey`
 * is the normalized query-shape signature (see `db-query-shape-sql.ts`). Lets the
 * panel read pre-aggregated rows instead of scanning raw span attributes +
 * computing per-row fingerprints over the whole window.
 *
 * `DurationQuantiles` stores a sample-weighted t-digest state so the panel keeps
 * true p50/p95 (finalize with
 * `quantilesTDigestWeightedMerge(0.5, 0.95)(DurationQuantiles)` → Array(Float64)
 * of [p50, p95] in nanoseconds). All `Estimated*`/`Weighted*` columns are
 * sample-rate corrected; raw `CallCount`/`ErrorCount` stay unweighted.
 * Populated by `service_map_db_query_shapes_hourly_mv`.
 */
export const serviceMapDbQueryShapesHourly = defineDatasource("service_map_db_query_shapes_hourly", {
	description:
		"Pre-aggregated hourly database query shapes (one row per service/db.system/query-shape) for the service map's database detail panel. Uses AggregatingMergeTree with a sample-weighted t-digest state for true p50/p95. Populated by materialized view.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Hour: t.dateTime(),
		ServiceName: t.string().lowCardinality(),
		DbSystem: t.string().lowCardinality(),
		DeploymentEnv: t.string().lowCardinality(),
		// Normalized query-shape signature — NOT LowCardinality: bounded by the
		// number of distinct shapes per org (hundreds–low thousands), which is
		// above the LowCardinality sweet spot.
		QueryKey: t.string(),
		// Representative shape label / sample statement (SimpleAggregateFunction
		// `any` — one representative per merged group).
		QueryLabel: t.simpleAggregateFunction("any", t.string()),
		SampleStatement: t.simpleAggregateFunction("any", t.string()),
		CallCount: t.simpleAggregateFunction("sum", t.uint64()),
		ErrorCount: t.simpleAggregateFunction("sum", t.uint64()),
		EstimatedCount: t.simpleAggregateFunction("sum", t.float64()),
		EstimatedErrorCount: t.simpleAggregateFunction("sum", t.float64()),
		// Sample-weighted duration sum in ms: sum(Duration * SampleRate / 1e6).
		// Pair with EstimatedCount for a weighted average.
		WeightedDurationSumMs: t.simpleAggregateFunction("sum", t.float64()),
		// CH type sig: AggregateFunction(quantilesTDigestWeighted(0.5, 0.95), UInt64, UInt32)
		// (value type UInt64 smuggled into the func name — same trick as
		// traces_aggregates_hourly.DurationQuantiles — weight type UInt32 passed
		// explicitly). Quantiles returned in nanoseconds; divide by 1e6 for ms.
		DurationQuantiles: t.aggregateFunction("quantilesTDigestWeighted(0.5, 0.95), UInt64", t.uint32()),
	},
	engine: engine.aggregatingMergeTree({
		partitionKey: "toDate(Hour)",
		sortingKey: ["OrgId", "Hour", "DeploymentEnv", "ServiceName", "DbSystem", "QueryKey"],
		ttl: "toDate(Hour) + INTERVAL 90 DAY",
	}),
	// The 90d rollup TTL outlives the 30d `traces` source, so a backfill from
	// `traces` can't reconstruct the full window. Carry existing rows forward
	// (non-destructive deploy) instead — same pattern as the other hourly
	// rollups (`logs_aggregates_hourly`, `service_usage_hourly`).
	forwardQuery: `SELECT *`,
})

export type ServiceMapDbQueryShapesHourlyRow = InferRow<typeof serviceMapDbQueryShapesHourly>

/**
 * Pre-aggregated hourly service-to-external-target edges for the service detail
 * page's Dependencies tab (and, eventually, external nodes on the service map).
 *
 * One row per (OrgId, Hour, ServiceName, TargetType, TargetSystem, TargetName,
 * DeploymentEnv) — captures Client/Producer spans WITHOUT `db.system.name`
 * (those are in `service_map_db_edges_hourly`), keyed by what they're talking to:
 *
 *   - http       — `server.address` / `http.host` / `url.authority`
 *   - messaging  — `messaging.system` + `messaging.destination`
 *   - rpc        — `rpc.system` + `rpc.service`
 *
 * `TargetType` is LowCardinality(String) — not Enum8 — to match the
 * `alert_checks` pattern (forward-compat with potential direct ingestion paths
 * that don't support Enum8 JSONPath ingestion). Allowed values: 'http' |
 * 'messaging' | 'rpc'. Populated by materialized view, not direct ingestion.
 *
 * Internal-service overlap (e.g. `auth-api` calling `users-api` shows up here
 * as `http://users-api.svc.cluster.local`) is filtered at QUERY time via a
 * LEFT ANTI JOIN against `service_address_resolutions_hourly`.
 */
export const serviceExternalEdgesHourly = defineDatasource("service_external_edges_hourly", {
	description:
		"Pre-aggregated hourly service-to-external-target edges (http / messaging / rpc) for the service-detail Dependencies tab. Captures Client/Producer spans WITHOUT db.system.name. Populated by materialized view.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Hour: t.dateTime(),
		ServiceName: t.string().lowCardinality(),
		TargetType: t.string().lowCardinality(),
		TargetSystem: t.string().lowCardinality(),
		TargetName: t.string(),
		DeploymentEnv: t.string().lowCardinality(),
		CallCount: t.simpleAggregateFunction("sum", t.uint64()),
		ErrorCount: t.simpleAggregateFunction("sum", t.uint64()),
		DurationSumMs: t.simpleAggregateFunction("sum", t.float64()),
		MaxDurationMs: t.simpleAggregateFunction("max", t.float64()),
		SampleRateSum: t.simpleAggregateFunction("sum", t.float64()),
	},
	engine: engine.aggregatingMergeTree({
		partitionKey: "toDate(Hour)",
		sortingKey: [
			"OrgId",
			"Hour",
			"DeploymentEnv",
			"ServiceName",
			"TargetType",
			"TargetSystem",
			"TargetName",
		],
		ttl: "toDate(Hour) + INTERVAL 90 DAY",
	}),
})

export type ServiceExternalEdgesHourlyRow = InferRow<typeof serviceExternalEdgesHourly>

/**
 * Resolved `(SourceService, parent-Client-span.server.address) → child-Server-
 * span.ServiceName` facts emitted by `ServiceMapRollupService` from the same
 * cross-span JOIN that fills `service_map_edges_hourly`. One row per resolved
 * (sourceService, parentServerAddress, resolvedTargetService) triple per hour.
 *
 * Used by the Dependencies-tab external-edges query to anti-join out HTTP
 * targets that actually resolve to a known internal service in the same window
 * (so `auth-api → users-api.svc.cluster.local` doesn't show up under "External
 * HTTP" when it's already represented as an internal service edge).
 *
 * Not populated by a materialized view — the parent→child JOIN is a cross-span
 * operation that an incremental MV cannot express. Same caveat as
 * `service_map_edges_hourly`.
 */
export const serviceAddressResolutionsHourly = defineDatasource("service_address_resolutions_hourly", {
	description:
		"Resolved (sourceService, parent.server.address) → resolved targetService facts emitted by the ServiceMapRollupService rollup. Used to anti-join internal-service overlap out of the external-edges query.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Hour: t.dateTime(),
		SourceService: t.string().lowCardinality(),
		ParentServerAddress: t.string(),
		ResolvedTargetService: t.string().lowCardinality(),
		DeploymentEnv: t.string().lowCardinality(),
	},
	engine: engine.replacingMergeTree({
		partitionKey: "toDate(Hour)",
		sortingKey: [
			"OrgId",
			"Hour",
			"DeploymentEnv",
			"SourceService",
			"ParentServerAddress",
			"ResolvedTargetService",
		],
		ttl: "toDate(Hour) + INTERVAL 90 DAY",
	}),
})

export type ServiceAddressResolutionsHourlyRow = InferRow<typeof serviceAddressResolutionsHourly>

/**
 * Pre-aggregated hourly per-service platform attributes for the service map.
 * One row per (OrgId, Hour, ServiceName, DeploymentEnv) with the resource
 * attributes that identify where a service runs. Uses SimpleAggregateFunction
 * "max" on string columns: empty strings sort first, so any non-empty value
 * wins on merge, which matches "did *any* span in this window carry this
 * attribute" semantics — exactly what the platform classifier needs.
 *
 * Populated by materialized view, not direct ingestion.
 */
export const servicePlatformsHourly = defineDatasource("service_platforms_hourly", {
	description:
		"Pre-aggregated hourly per-service platform/runtime attributes (k8s, cloud, faas) for the service map's hosting-icon resolver. Populated by materialized view.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Hour: t.dateTime(),
		ServiceName: t.string().lowCardinality(),
		DeploymentEnv: t.string().lowCardinality(),
		K8sCluster: t.simpleAggregateFunction("max", t.string()),
		K8sPodName: t.simpleAggregateFunction("max", t.string()),
		K8sDeploymentName: t.simpleAggregateFunction("max", t.string()),
		K8sStatefulSetName: t.simpleAggregateFunction("max", t.string()),
		K8sDaemonSetName: t.simpleAggregateFunction("max", t.string()),
		K8sNamespaceName: t.simpleAggregateFunction("max", t.string()),
		CloudPlatform: t.simpleAggregateFunction("max", t.string()),
		CloudProvider: t.simpleAggregateFunction("max", t.string()),
		FaasName: t.simpleAggregateFunction("max", t.string()),
		MapleSdkType: t.simpleAggregateFunction("max", t.string()),
		ProcessRuntimeName: t.simpleAggregateFunction("max", t.string()),
		SpanCount: t.simpleAggregateFunction("sum", t.uint64()),
	},
	// The K8sStatefulSetName/K8sDaemonSetName/K8sNamespaceName columns were added
	// after this datasource already held data. This MV's 90-day TTL outlives the
	// `traces` source's 30-day TTL, so a re-populate from `traces` couldn't refill
	// the 30-90 day window; the add-deploy forward-migrated existing rows in place,
	// defaulting the new columns to '' (the sentinel the `max()` platform
	// classifier treats as "attribute not present"). That one-time migration is
	// COMPLETE — the columns now exist in the deployed datasource and are
	// populated, so the forward query carries them through unchanged. Re-defaulting
	// them (the old `defaultValueOfTypeName(...)`) would overwrite the values
	// accumulated since, which Tinybird rejects on every later deploy.
	forwardQuery: `SELECT
    OrgId, Hour, ServiceName, DeploymentEnv,
    K8sCluster, K8sPodName, K8sDeploymentName,
    K8sStatefulSetName,
    K8sDaemonSetName,
    K8sNamespaceName,
    CloudPlatform, CloudProvider, FaasName, MapleSdkType, ProcessRuntimeName, SpanCount`,
	engine: engine.aggregatingMergeTree({
		partitionKey: "toDate(Hour)",
		sortingKey: ["OrgId", "Hour", "ServiceName", "DeploymentEnv"],
		ttl: "toDate(Hour) + INTERVAL 90 DAY",
	}),
})

export type ServicePlatformsHourlyRow = InferRow<typeof servicePlatformsHourly>

/**
 * Lightweight projection of service entry point spans for service overview queries.
 * Pre-extracts deployment.environment and deployment.commit_sha from ResourceAttributes.
 * Stores Server/Consumer spans (service entry points) plus root spans as fallback.
 * Populated by materialized view, not direct ingestion.
 */
export const serviceOverviewSpans = defineDatasource("service_overview_spans", {
	description:
		"Lightweight projection of service entry point spans (Server/Consumer + root) for service overview queries. Pre-extracts deployment attributes from ResourceAttributes. Populated by materialized view.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Timestamp: t.dateTime(),
		ServiceName: t.string().lowCardinality(),
		Duration: t.uint64(),
		StatusCode: t.string().lowCardinality(),
		TraceState: t.string(),
		DeploymentEnv: t.string().lowCardinality(),
		CommitSha: t.string().lowCardinality(),
		SampleRate: t.float64().default(1.0),
		ServiceNamespace: t.string().lowCardinality(),
	},
	engine: engine.mergeTree({
		partitionKey: "toDate(Timestamp)",
		sortingKey: ["OrgId", "ServiceName", "Timestamp"],
		ttl: "Timestamp + INTERVAL 30 DAY",
	}),
	indexes: [
		{
			name: "idx_service_namespace",
			expr: "ServiceNamespace",
			type: "set(1000)",
			granularity: 4,
		},
	],
})

export type ServiceOverviewSpansRow = InferRow<typeof serviceOverviewSpans>

/**
 * Pre-materialized error spans for the errors page.
 * Pre-filters to StatusCode='Error' and pre-extracts deployment.environment
 * so error queries avoid scanning the full traces table and Map columns.
 * Sorted by (OrgId, ServiceName, Timestamp) for efficient filtering and aggregation.
 * Populated by materialized view, not direct ingestion.
 */
export const errorSpans = defineDatasource("error_spans", {
	description:
		"Pre-materialized error spans for the errors page. Pre-filters to StatusCode='Error' and pre-extracts deployment.environment. Populated by materialized view.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Timestamp: t.dateTime(),
		TraceId: t.string(),
		SpanId: t.string(),
		ParentSpanId: t.string().default("__unset__"),
		ServiceName: t.string().lowCardinality(),
		StatusMessage: t.string(),
		Duration: t.uint64(),
		DeploymentEnv: t.string().lowCardinality(),
	},
	engine: engine.mergeTree({
		partitionKey: "toDate(Timestamp)",
		sortingKey: ["OrgId", "ServiceName", "Timestamp"],
		ttl: "Timestamp + INTERVAL 90 DAY",
	}),
})

export type ErrorSpansRow = InferRow<typeof errorSpans>

/**
 * Pre-materialized error events for the errors-as-issues triage system.
 * Populated from traces where StatusCode='Error'. Unwraps the first OTel
 * `exception` event (if any) to surface exception.type / message / stacktrace,
 * normalizes the top stack frame, and hashes (OrgId, ServiceName, ExceptionType,
 * TopFrame) with cityHash64 to produce a stable per-issue FingerprintHash.
 * Sorted by (OrgId, FingerprintHash, Timestamp) so queries grouping by issue
 * and scanning recent activity stay on the sort-key prefix.
 */
export const errorEvents = defineDatasource("error_events", {
	description:
		"Per-error-occurrence rows for the triageable-errors system. Unwraps OTel exception events and computes a stable FingerprintHash for grouping into issues. Populated by materialized view.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Timestamp: t.dateTime(),
		TraceId: t.string(),
		SpanId: t.string(),
		ParentSpanId: t.string().default("__unset__"),
		ServiceName: t.string().lowCardinality(),
		DeploymentEnv: t.string().lowCardinality(),
		ExceptionType: t.string().lowCardinality(),
		ExceptionMessage: t.string(),
		ExceptionStacktrace: t.string(),
		TopFrame: t.string(),
		FingerprintHash: t.uint64(),
		StatusMessage: t.string(),
		Duration: t.uint64(),
		ErrorLabel: t.string(),
	},
	engine: engine.mergeTree({
		partitionKey: "toDate(Timestamp)",
		sortingKey: ["OrgId", "FingerprintHash", "Timestamp"],
		ttl: "Timestamp + INTERVAL 90 DAY",
	}),
})

export type ErrorEventsRow = InferRow<typeof errorEvents>

/**
 * Time-ordered sibling of `error_events`, populated by the same materialized view
 * logic but sorted `(OrgId, Timestamp, FingerprintHash)`.
 *
 * `error_events` leads its sort key with `FingerprintHash`, which is optimal for
 * per-issue occurrence lookups (filter on a specific FingerprintHash) but pessimal
 * for the recent-window scans that dominate the workload: the errors/triage tick's
 * `errorIssuesScan` (and the dashboard error queries) filter a `Timestamp` range and
 * `GROUP BY FingerprintHash`, which can't prune via the primary index on the original
 * table and ends up scanning the org's whole day-partition — timing out the 30s
 * warehouse budget for high-volume orgs. This sibling makes the time range the leading
 * (post-org) sort dimension so those scans prune to the window. Same schema, same 90d
 * TTL; the only difference is the sorting key.
 */
export const errorEventsByTime = defineDatasource("error_events_by_time", {
	description:
		"Time-ordered sibling of error_events (sorted by OrgId, Timestamp, FingerprintHash) for recent-window error scans (errorIssuesScan tick + dashboard error queries). Populated by materialized view.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Timestamp: t.dateTime(),
		TraceId: t.string(),
		SpanId: t.string(),
		ParentSpanId: t.string().default("__unset__"),
		ServiceName: t.string().lowCardinality(),
		DeploymentEnv: t.string().lowCardinality(),
		ExceptionType: t.string().lowCardinality(),
		ExceptionMessage: t.string(),
		ExceptionStacktrace: t.string(),
		TopFrame: t.string(),
		FingerprintHash: t.uint64(),
		StatusMessage: t.string(),
		Duration: t.uint64(),
		ErrorLabel: t.string(),
	},
	engine: engine.mergeTree({
		partitionKey: "toDate(Timestamp)",
		sortingKey: ["OrgId", "Timestamp", "FingerprintHash"],
		ttl: "Timestamp + INTERVAL 90 DAY",
	}),
})

export type ErrorEventsByTimeRow = InferRow<typeof errorEventsByTime>

/**
 * Pre-materialized root spans for the trace list view.
 * Extracts HTTP attributes and normalizes span names at write time
 * so the trace list query avoids scanning heavy Map columns and GROUP BY.
 * Sorted by (OrgId, Timestamp, TraceId) for fast time-range pagination.
 * Populated by materialized view, not direct ingestion.
 */
export const traceListMv = defineDatasource("trace_list_mv", {
	description:
		"Pre-materialized root spans for the trace list view. Extracts HTTP attributes and normalizes span names at write time. Populated by materialized view.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		TraceId: t.string(),
		Timestamp: t.dateTime(),
		ServiceName: t.string().lowCardinality(),
		SpanName: t.string(),
		SpanKind: t.string().lowCardinality(),
		Duration: t.uint64(),
		StatusCode: t.string().lowCardinality(),
		HttpMethod: t.string().lowCardinality(),
		HttpRoute: t.string(),
		HttpStatusCode: t.string().lowCardinality(),
		DeploymentEnv: t.string().lowCardinality(),
		HasError: t.uint8(),
		TraceState: t.string(),
		ServiceNamespace: t.string().lowCardinality(),
	},
	engine: engine.mergeTree({
		partitionKey: "toDate(Timestamp)",
		sortingKey: ["OrgId", "Timestamp", "TraceId"],
		ttl: "Timestamp + INTERVAL 30 DAY",
	}),
	indexes: [
		{
			name: "idx_service_namespace",
			expr: "ServiceNamespace",
			type: "set(1000)",
			granularity: 4,
		},
	],
})

export type TraceListMvRow = InferRow<typeof traceListMv>

/**
 * All spans for a given trace, re-sorted by TraceId for fast detail lookups.
 * Populated by materialized view, not direct ingestion.
 * Sorting key (OrgId, TraceId, SpanId) enables O(log N) primary-key lookup
 * instead of bloom-filter scanning across all partitions.
 */
export const traceDetailSpans = defineDatasource("trace_detail_spans", {
	description:
		"All spans for a trace, sorted by TraceId for fast detail lookups. Populated by materialized view.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Timestamp: t.dateTime64(9),
		TraceId: t.string(),
		SpanId: t.string(),
		ParentSpanId: t.string(),
		SpanName: t.string().lowCardinality(),
		SpanKind: t.string().lowCardinality(),
		ServiceName: t.string().lowCardinality(),
		Duration: t.uint64().default(0),
		StatusCode: t.string().lowCardinality(),
		StatusMessage: t.string(),
		SpanAttributes: t.map(t.string().lowCardinality(), t.string()),
		ResourceAttributes: t.map(t.string().lowCardinality(), t.string()),
		EventsTimestamp: t.array(t.dateTime64(9)),
		EventsName: t.array(t.string().lowCardinality()),
		EventsAttributes: t.array(t.map(t.string().lowCardinality(), t.string())),
	},
	engine: engine.mergeTree({
		partitionKey: "toDate(Timestamp)",
		sortingKey: ["OrgId", "TraceId", "SpanId"],
		ttl: "toDate(Timestamp) + INTERVAL 30 DAY",
	}),
})

export type TraceDetailSpansRow = InferRow<typeof traceDetailSpans>

/**
 * OpenTelemetry sum/counter metrics datasource
 */
export const metricsSum = defineDatasource("metrics_sum", {
	description: "This is a table that contains the metrics from the OpenTelemetry Collector.",
	schema: {
		OrgId: column(t.string().lowCardinality(), {
			jsonPath: "$.resource_attributes.maple_org_id",
		}),
		ResourceAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.resource_attributes",
		}),
		ResourceSchemaUrl: column(t.string(), { jsonPath: "$.resource_schema_url" }),
		ScopeName: column(t.string(), { jsonPath: "$.scope_name" }),
		ScopeVersion: column(t.string(), { jsonPath: "$.scope_version" }),
		ScopeAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.scope_attributes",
		}),
		ScopeSchemaUrl: column(t.string(), { jsonPath: "$.scope_schema_url" }),
		ServiceName: column(t.string().lowCardinality(), { jsonPath: "$.service_name" }),
		MetricName: column(t.string().lowCardinality(), {
			jsonPath: "$.metric_name",
		}),
		MetricDescription: column(t.string().lowCardinality(), { jsonPath: "$.metric_description" }),
		MetricUnit: column(t.string().lowCardinality(), { jsonPath: "$.metric_unit" }),
		Attributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.metric_attributes",
		}),
		StartTimeUnix: column(t.dateTime64(9), { jsonPath: "$.start_timestamp" }),
		TimeUnix: column(t.dateTime64(9), { jsonPath: "$.timestamp" }),
		Value: column(t.float64(), { jsonPath: "$.value" }),
		Flags: column(t.uint32(), { jsonPath: "$.flags" }),
		ExemplarsTraceId: column(t.array(t.string()), {
			jsonPath: "$.exemplars_trace_id[:]",
		}),
		ExemplarsSpanId: column(t.array(t.string()), {
			jsonPath: "$.exemplars_span_id[:]",
		}),
		ExemplarsTimestamp: column(t.array(t.dateTime64(9)), {
			jsonPath: "$.exemplars_timestamp[:]",
		}),
		ExemplarsValue: column(t.array(t.float64()), {
			jsonPath: "$.exemplars_value[:]",
		}),
		ExemplarsFilteredAttributes: column(t.array(t.map(t.string().lowCardinality(), t.string())), {
			jsonPath: "$.exemplars_filtered_attributes[:]",
		}),
		AggregationTemporality: column(t.int32(), {
			jsonPath: "$.aggregation_temporality",
		}),
		IsMonotonic: column(t.bool(), { jsonPath: "$.is_monotonic" }),
	},
	engine: engine.mergeTree({
		partitionKey: "toDate(TimeUnix)",
		sortingKey: ["OrgId", "ServiceName", "MetricName", "Attributes", "toUnixTimestamp64Nano(TimeUnix)"],
		ttl: "toDate(TimeUnix) + INTERVAL 90 DAY",
	}),
})

export type MetricsSumRow = InferRow<typeof metricsSum>

/**
 * OpenTelemetry gauge metrics datasource
 */
export const metricsGauge = defineDatasource("metrics_gauge", {
	description: "This is a table that contains the metrics from the OpenTelemetry Collector.",
	schema: {
		OrgId: column(t.string().lowCardinality(), {
			jsonPath: "$.resource_attributes.maple_org_id",
		}),
		ResourceAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.resource_attributes",
		}),
		ResourceSchemaUrl: column(t.string(), { jsonPath: "$.resource_schema_url" }),
		ScopeName: column(t.string(), { jsonPath: "$.scope_name" }),
		ScopeVersion: column(t.string(), { jsonPath: "$.scope_version" }),
		ScopeAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.scope_attributes",
		}),
		ScopeSchemaUrl: column(t.string(), { jsonPath: "$.scope_schema_url" }),
		ServiceName: column(t.string().lowCardinality(), { jsonPath: "$.service_name" }),
		MetricName: column(t.string().lowCardinality(), {
			jsonPath: "$.metric_name",
		}),
		MetricDescription: column(t.string().lowCardinality(), { jsonPath: "$.metric_description" }),
		MetricUnit: column(t.string().lowCardinality(), { jsonPath: "$.metric_unit" }),
		Attributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.metric_attributes",
		}),
		StartTimeUnix: column(t.dateTime64(9), { jsonPath: "$.start_timestamp" }),
		TimeUnix: column(t.dateTime64(9), { jsonPath: "$.timestamp" }),
		Value: column(t.float64(), { jsonPath: "$.value" }),
		Flags: column(t.uint32(), { jsonPath: "$.flags" }),
		ExemplarsTraceId: column(t.array(t.string()), {
			jsonPath: "$.exemplars_trace_id[:]",
		}),
		ExemplarsSpanId: column(t.array(t.string()), {
			jsonPath: "$.exemplars_span_id[:]",
		}),
		ExemplarsTimestamp: column(t.array(t.dateTime64(9)), {
			jsonPath: "$.exemplars_timestamp[:]",
		}),
		ExemplarsValue: column(t.array(t.float64()), {
			jsonPath: "$.exemplars_value[:]",
		}),
		ExemplarsFilteredAttributes: column(t.array(t.map(t.string().lowCardinality(), t.string())), {
			jsonPath: "$.exemplars_filtered_attributes[:]",
		}),
	},
	engine: engine.mergeTree({
		partitionKey: "toDate(TimeUnix)",
		sortingKey: ["OrgId", "ServiceName", "MetricName", "Attributes", "toUnixTimestamp64Nano(TimeUnix)"],
		ttl: "toDate(TimeUnix) + INTERVAL 90 DAY",
	}),
})

export type MetricsGaugeRow = InferRow<typeof metricsGauge>

/**
 * OpenTelemetry histogram metrics datasource
 */
export const metricsHistogram = defineDatasource("metrics_histogram", {
	description: "This is a table that contains the metrics from the OpenTelemetry Collector.",
	schema: {
		OrgId: column(t.string().lowCardinality(), {
			jsonPath: "$.resource_attributes.maple_org_id",
		}),
		ResourceAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.resource_attributes",
		}),
		ResourceSchemaUrl: column(t.string(), { jsonPath: "$.resource_schema_url" }),
		ScopeName: column(t.string(), { jsonPath: "$.scope_name" }),
		ScopeVersion: column(t.string(), { jsonPath: "$.scope_version" }),
		ScopeAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.scope_attributes",
		}),
		ScopeSchemaUrl: column(t.string(), { jsonPath: "$.scope_schema_url" }),
		ServiceName: column(t.string().lowCardinality(), { jsonPath: "$.service_name" }),
		MetricName: column(t.string().lowCardinality(), {
			jsonPath: "$.metric_name",
		}),
		MetricDescription: column(t.string().lowCardinality(), { jsonPath: "$.metric_description" }),
		MetricUnit: column(t.string().lowCardinality(), { jsonPath: "$.metric_unit" }),
		Attributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.metric_attributes",
		}),
		StartTimeUnix: column(t.dateTime64(9), { jsonPath: "$.start_timestamp" }),
		TimeUnix: column(t.dateTime64(9), { jsonPath: "$.timestamp" }),
		Count: column(t.uint64(), { jsonPath: "$.count" }),
		Sum: column(t.float64(), { jsonPath: "$.sum" }),
		BucketCounts: column(t.array(t.uint64()), {
			jsonPath: "$.bucket_counts[:]",
		}),
		ExplicitBounds: column(t.array(t.float64()), {
			jsonPath: "$.explicit_bounds[:]",
		}),
		ExemplarsTraceId: column(t.array(t.string()), {
			jsonPath: "$.exemplars_trace_id[:]",
		}),
		ExemplarsSpanId: column(t.array(t.string()), {
			jsonPath: "$.exemplars_span_id[:]",
		}),
		ExemplarsTimestamp: column(t.array(t.dateTime64(9)), {
			jsonPath: "$.exemplars_timestamp[:]",
		}),
		ExemplarsValue: column(t.array(t.float64()), {
			jsonPath: "$.exemplars_value[:]",
		}),
		ExemplarsFilteredAttributes: column(t.array(t.map(t.string().lowCardinality(), t.string())), {
			jsonPath: "$.exemplars_filtered_attributes[:]",
		}),
		Flags: column(t.uint32(), { jsonPath: "$.flags" }),
		Min: column(t.float64().nullable(), { jsonPath: "$.min" }),
		Max: column(t.float64().nullable(), { jsonPath: "$.max" }),
		AggregationTemporality: column(t.int32(), {
			jsonPath: "$.aggregation_temporality",
		}),
	},
	engine: engine.mergeTree({
		partitionKey: "toDate(TimeUnix)",
		sortingKey: ["OrgId", "ServiceName", "MetricName", "Attributes", "toUnixTimestamp64Nano(TimeUnix)"],
		ttl: "toDate(TimeUnix) + INTERVAL 90 DAY",
	}),
})

export type MetricsHistogramRow = InferRow<typeof metricsHistogram>

/**
 * OpenTelemetry exponential histogram metrics datasource
 */
export const metricsExponentialHistogram = defineDatasource("metrics_exponential_histogram", {
	description: "This is a table that contains the metrics from the OpenTelemetry Collector.",
	schema: {
		OrgId: column(t.string().lowCardinality(), {
			jsonPath: "$.resource_attributes.maple_org_id",
		}),
		ResourceAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.resource_attributes",
		}),
		ResourceSchemaUrl: column(t.string(), {
			jsonPath: "$.resource_schema_url",
		}),
		ScopeName: column(t.string(), { jsonPath: "$.scope_name" }),
		ScopeVersion: column(t.string(), { jsonPath: "$.scope_version" }),
		ScopeAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.scope_attributes",
		}),
		ScopeSchemaUrl: column(t.string(), { jsonPath: "$.scope_schema_url" }),
		ServiceName: column(t.string().lowCardinality(), { jsonPath: "$.service_name" }),
		MetricName: column(t.string().lowCardinality(), {
			jsonPath: "$.metric_name",
		}),
		MetricDescription: column(t.string().lowCardinality(), {
			jsonPath: "$.metric_description",
		}),
		MetricUnit: column(t.string().lowCardinality(), { jsonPath: "$.metric_unit" }),
		Attributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.metric_attributes",
		}),
		StartTimeUnix: column(t.dateTime64(9), { jsonPath: "$.start_timestamp" }),
		TimeUnix: column(t.dateTime64(9), { jsonPath: "$.timestamp" }),
		Count: column(t.uint64(), { jsonPath: "$.count" }),
		Sum: column(t.float64(), { jsonPath: "$.sum" }),
		Scale: column(t.int32(), { jsonPath: "$.scale" }),
		ZeroCount: column(t.uint64(), { jsonPath: "$.zero_count" }),
		PositiveOffset: column(t.int32(), { jsonPath: "$.positive_offset" }),
		PositiveBucketCounts: column(t.array(t.uint64()), {
			jsonPath: "$.positive_bucket_counts[:]",
		}),
		NegativeOffset: column(t.int32(), { jsonPath: "$.negative_offset" }),
		NegativeBucketCounts: column(t.array(t.uint64()), {
			jsonPath: "$.negative_bucket_counts[:]",
		}),
		ExemplarsTraceId: column(t.array(t.string()), {
			jsonPath: "$.exemplars_trace_id[:]",
		}),
		ExemplarsSpanId: column(t.array(t.string()), {
			jsonPath: "$.exemplars_span_id[:]",
		}),
		ExemplarsTimestamp: column(t.array(t.dateTime64(9)), {
			jsonPath: "$.exemplars_timestamp[:]",
		}),
		ExemplarsValue: column(t.array(t.float64()), {
			jsonPath: "$.exemplars_value[:]",
		}),
		ExemplarsFilteredAttributes: column(t.array(t.map(t.string().lowCardinality(), t.string())), {
			jsonPath: "$.exemplars_filtered_attributes[:]",
		}),
		Flags: column(t.uint32(), { jsonPath: "$.flags" }),
		Min: column(t.float64().nullable(), { jsonPath: "$.min" }),
		Max: column(t.float64().nullable(), { jsonPath: "$.max" }),
		AggregationTemporality: column(t.int32(), {
			jsonPath: "$.aggregation_temporality",
		}),
	},
	engine: engine.mergeTree({
		partitionKey: "toDate(TimeUnix)",
		sortingKey: ["OrgId", "ServiceName", "MetricName", "Attributes", "toUnixTimestamp64Nano(TimeUnix)"],
		ttl: "toDate(TimeUnix) + INTERVAL 90 DAY",
	}),
})

export type MetricsExponentialHistogramRow = InferRow<typeof metricsExponentialHistogram>

/**
 * Hourly catalog of distinct metrics — one row per
 * (OrgId, Hour, MetricType, ServiceName, MetricName) — with datapoint counts
 * and first/last-seen timestamps. AggregatingMergeTree MV target, fed by one
 * MV per raw metric table. Powers the Metrics page discovery queries
 * (`listMetricsQuery` / `metricsSummaryQuery`) so they read a tiny rollup
 * instead of scanning raw datapoints.
 */
export const metricCatalog = defineDatasource("metric_catalog", {
	description:
		"Hourly catalog of distinct metrics (name/type/service) with datapoint counts and first/last-seen. AggregatingMergeTree MV target; powers the Metrics page discovery queries.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Hour: t.dateTime(),
		MetricType: t.string().lowCardinality(),
		ServiceName: t.string().lowCardinality(),
		MetricName: t.string().lowCardinality(),
		MetricDescription: t.simpleAggregateFunction("anyLast", t.string()),
		MetricUnit: t.simpleAggregateFunction("anyLast", t.string()),
		IsMonotonic: t.simpleAggregateFunction("anyLast", t.uint8()),
		DataPointCount: t.simpleAggregateFunction("sum", t.uint64()),
		FirstSeen: t.simpleAggregateFunction("min", t.dateTime()),
		LastSeen: t.simpleAggregateFunction("max", t.dateTime()),
	},
	engine: engine.aggregatingMergeTree({
		partitionKey: "toDate(Hour)",
		sortingKey: ["OrgId", "MetricType", "ServiceName", "MetricName", "Hour"],
		ttl: "Hour + INTERVAL 90 DAY",
	}),
})

export type MetricCatalogRow = InferRow<typeof metricCatalog>

/**
 * Pre-aggregated attribute keys with hourly usage counts.
 * Fed by MVs from traces (span + resource), logs, and metrics tables.
 */
export const attributeKeysHourly = defineDatasource("attribute_keys_hourly", {
	description: "Pre-aggregated attribute keys with hourly usage counts from traces, logs, and metrics.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Hour: t.dateTime(),
		AttributeKey: t.string().lowCardinality(),
		AttributeScope: t.string().lowCardinality(),
		UsageCount: t.simpleAggregateFunction("sum", t.uint64()),
	},
	engine: engine.aggregatingMergeTree({
		partitionKey: "toDate(Hour)",
		sortingKey: ["OrgId", "AttributeScope", "Hour", "AttributeKey"],
		ttl: "Hour + INTERVAL 90 DAY",
	}),
})

export type AttributeKeysHourlyRow = InferRow<typeof attributeKeysHourly>

/**
 * Pre-aggregated attribute values with hourly usage counts.
 * Fed by MVs from traces for span and resource attribute values.
 */
export const attributeValuesHourly = defineDatasource("attribute_values_hourly", {
	description:
		"Pre-aggregated attribute values with hourly usage counts from trace span and resource attributes.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Hour: t.dateTime(),
		AttributeKey: t.string().lowCardinality(),
		AttributeValue: t.string(),
		AttributeScope: t.string().lowCardinality(),
		UsageCount: t.simpleAggregateFunction("sum", t.uint64()),
	},
	engine: engine.aggregatingMergeTree({
		partitionKey: "toDate(Hour)",
		sortingKey: ["OrgId", "AttributeScope", "AttributeKey", "Hour", "AttributeValue"],
		ttl: "Hour + INTERVAL 90 DAY",
	}),
})

export type AttributeValuesHourlyRow = InferRow<typeof attributeValuesHourly>

/**
 * Alert check history datasource.
 * One row per alert rule evaluation (approximately one per rule per group per minute).
 * Durable audit trail of every check — the underlying signal that incidents are derived from.
 *
 * Status/IncidentTransition/Comparator/SignalType are LowCardinality(String); their literal
 * values must stay in sync with the runtime literals in `packages/domain/src/http/alerts.ts`
 * and `NormalizedRule`.
 */
export const alertChecks = defineDatasource("alert_checks", {
	description:
		"One row per alert rule evaluation. Durable audit trail of checks: status, observed value, threshold, sample count, incident linkage.",
	// jsonPaths enabled: alert_checks is ingested directly via POST /v0/events from
	// AlertsService.processEvaluation, not via a materialized view. Each column gets
	// an auto-generated `$.ColumnName` path matching the NDJSON keys in AlertChecksRow.
	// Status/SignalType/Comparator/IncidentTransition use LowCardinality(String) — not
	// Enum8 — because Tinybird's /v0/events JSONPath ingestion doesn't support Enum8.
	// The runtime literals live in http/alerts.ts and NormalizedRule; TS narrows them
	// at the assignment site in AlertsService.processEvaluation.
	schema: {
		OrgId: t.string().lowCardinality(),
		RuleId: t.string(),
		GroupKey: t.string(),
		Timestamp: t.dateTime64(3),
		Status: t.string().lowCardinality(),
		SignalType: t.string().lowCardinality(),
		Comparator: t.string().lowCardinality(),
		Threshold: t.float64(),
		ObservedValue: t.float64().nullable(),
		SampleCount: t.uint32(),
		WindowMinutes: t.uint16(),
		WindowStart: t.dateTime64(3),
		WindowEnd: t.dateTime64(3),
		ConsecutiveBreaches: t.uint16(),
		ConsecutiveHealthy: t.uint16(),
		IncidentId: t.string().nullable(),
		IncidentTransition: t.string().lowCardinality(),
		EvaluationDurationMs: t.uint32(),
		// Populated on Status='error' rows (failed evaluations). ErrorCategory uses
		// empty string (not NULL) for non-error rows — LowCardinality(Nullable) is
		// awkward in ClickHouse.
		ErrorMessage: t.string().nullable(),
		ErrorCategory: t.string().lowCardinality(),
	},
	engine: engine.mergeTree({
		partitionKey: "toDate(Timestamp)",
		sortingKey: ["OrgId", "RuleId", "GroupKey", "Timestamp"],
		ttl: "toDate(Timestamp) + INTERVAL 90 DAY",
	}),
})

export type AlertChecksRow = InferRow<typeof alertChecks>

/**
 * Generalized hourly aggregating MV target for traces. Stores partial state
 * (`-State` aggregates) keyed on the dimensions that show up in 90%+ of
 * traces queries. Query layer finalizes via `-Merge` combinators at read
 * time, so a single MV serves timeseries, breakdown, and service-overview
 * shapes for any combination of these dimensions.
 *
 * Sample-aware from day one — counts and quantiles are weighted by
 * `SampleRate`, so upstream sampling does not bias dashboards.
 *
 * Populated by materialized view, not direct ingestion.
 *
 * SOURCE TTL: 30d (matches `traces.ttl`). Update in lockstep if raw TTL
 * changes — see docs/persistence.md.
 */
export const tracesAggregatesHourly = defineDatasource("traces_aggregates_hourly", {
	description:
		"Hourly pre-aggregated trace metrics with sampling-weighted state columns. Generalized MV target for timeseries/breakdown/service-overview queries. AggregatingMergeTree.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Hour: t.dateTime(),
		ServiceName: t.string().lowCardinality(),
		SpanName: t.string().lowCardinality(),
		SpanKind: t.string().lowCardinality(),
		StatusCode: t.string().lowCardinality(),
		IsEntryPoint: t.uint8(),
		DeploymentEnv: t.string().lowCardinality(),
		// Sample-corrected count: sum of SampleRate (1.0 for unsampled, >1 for sampled)
		WeightedCount: t.simpleAggregateFunction("sum", t.float64()),
		// Sample-corrected duration sum: sum(Duration * SampleRate). Pair with WeightedCount for weighted avg.
		WeightedDurationSum: t.simpleAggregateFunction("sum", t.float64()),
		// Sample-corrected error count: sum of SampleRate for error spans
		WeightedErrorCount: t.simpleAggregateFunction("sum", t.float64()),
		// Quantile state (t-digest, weighted) — finalize with
		// quantilesTDigestWeightedMerge(0.5, 0.95, 0.99)(DurationQuantiles),
		// which returns Array(Float64) of [p50, p95, p99].
		//
		// CH type sig: AggregateFunction(quantilesTDigestWeighted(...), value_type, weight_type)
		// Tinybird SDK's aggregateFunction(func, type) only emits one type slot,
		// so we smuggle the value type (UInt64 for Duration) into the function
		// name and pass the weight type (UInt32 for toUInt32(SampleRate)) as
		// the explicit type argument. Generated SQL:
		//   AggregateFunction(quantilesTDigestWeighted(0.5, 0.95, 0.99), UInt64, UInt32)
		DurationQuantiles: t.aggregateFunction(
			"quantilesTDigestWeighted(0.5, 0.95, 0.99), UInt64",
			t.uint32(),
		),
		// Min/max are not weighted — true population extremes
		DurationMin: t.simpleAggregateFunction("min", t.uint64()),
		DurationMax: t.simpleAggregateFunction("max", t.uint64()),
	},
	engine: engine.aggregatingMergeTree({
		partitionKey: "toDate(Hour)",
		sortingKey: [
			"OrgId",
			"Hour",
			"ServiceName",
			"SpanName",
			"SpanKind",
			"StatusCode",
			"IsEntryPoint",
			"DeploymentEnv",
		],
		ttl: "toDate(Hour) + INTERVAL 90 DAY",
	}),
})

export type TracesAggregatesHourlyRow = InferRow<typeof tracesAggregatesHourly>

/**
 * Hourly per-series last-value rollup of the span-metrics `calls` counter, so
 * the dashboard's sampling-aware throughput reads pre-aggregated data for
 * completed hours instead of scanning raw `metrics_sum` with a window function
 * (the ~7s p95 offender). Per-series identity =
 * (ServiceName, MetricName, SpanKind, AttrFingerprint, ResourceFingerprint,
 * StartTimeUnix); `LastValue` is the cumulative counter at the end of each hour
 * (argMax by TimeUnix). Per-hour increase = LastValue(hour) − LastValue(prev
 * hour) per series, summed per service — telescopes to exactly what
 * `metricsTimeseriesRateQuery` computes (the in-progress hour stays on the live
 * window query; see query-engine runtime).
 *
 * Populated by materialized view, not direct ingestion.
 *
 * SOURCE TTL: 90d (matches `metrics_sum.ttl`). Update in lockstep if raw TTL
 * changes — see docs/persistence.md.
 */
export const spanMetricsCallsHourly = defineDatasource("span_metrics_calls_hourly", {
	description:
		"Hourly per-series last-value (argMax) rollup of the span-metrics calls counter. AggregatingMergeTree MV target powering sampling-aware throughput without scanning raw metrics_sum.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Hour: t.dateTime(),
		ServiceName: t.string().lowCardinality(),
		MetricName: t.string().lowCardinality(),
		SpanKind: t.string().lowCardinality(),
		// cityHash64 fingerprints of the metric / resource attribute Maps — a
		// fixed-width series identity (mirrors the window-query partition fix in
		// metricsTimeseriesRateQuery).
		AttrFingerprint: t.uint64(),
		ResourceFingerprint: t.uint64(),
		// Counter-reset epoch; isolates accumulation runs within one series.
		StartTimeUnix: t.dateTime64(9),
		// Cumulative counter value at the end of the hour for this series-epoch.
		// Finalize with argMaxMerge(LastValue). Tinybird's aggregateFunction(func,
		// type) emits one type slot, so the value type (Float64) is smuggled into
		// the function name and the key type (DateTime64(9)) is the type arg:
		//   AggregateFunction(argMax, Float64, DateTime64(9))
		LastValue: t.aggregateFunction("argMax, Float64", t.dateTime64(9)),
	},
	engine: engine.aggregatingMergeTree({
		partitionKey: "toDate(Hour)",
		sortingKey: [
			"OrgId",
			"Hour",
			"ServiceName",
			"MetricName",
			"SpanKind",
			"AttrFingerprint",
			"ResourceFingerprint",
			"StartTimeUnix",
		],
		ttl: "toDate(Hour) + INTERVAL 90 DAY",
	}),
})

export type SpanMetricsCallsHourlyRow = InferRow<typeof spanMetricsCallsHourly>

/**
 * Generalized hourly aggregating MV target for logs. Severity-aware so
 * "errors per service per hour" / "log volume by severity" queries no
 * longer scan raw logs.
 *
 * SOURCE TTL: 30d (matches `logs.ttl`).
 */
export const logsAggregatesHourly = defineDatasource("logs_aggregates_hourly", {
	description:
		"Hourly pre-aggregated log counts and sizes by service × severity × deployment env. AggregatingMergeTree.",
	jsonPaths: false,
	schema: {
		OrgId: t.string().lowCardinality(),
		Hour: t.dateTime(),
		ServiceName: t.string().lowCardinality(),
		SeverityText: t.string().lowCardinality(),
		DeploymentEnv: t.string().lowCardinality(),
		Count: t.simpleAggregateFunction("sum", t.uint64()),
		SizeBytes: t.simpleAggregateFunction("sum", t.uint64()),
		ServiceNamespace: t.string().lowCardinality(),
	},
	// ServiceNamespace was added after this 90-day aggregate already held data
	// (the source `logs` table only retains 30 days, so the full window could not
	// be rebuilt — the add-deploy defaulted the new dimension to '' in place).
	// That one-time migration is COMPLETE: the column now exists in the deployed
	// datasource and is populated. The forward query therefore carries every
	// column — including ServiceNamespace — through unchanged. Re-defaulting it
	// (the old `defaultValueOfTypeName(...) AS ServiceNamespace`) would overwrite
	// the values accumulated since, which Tinybird rejects on every later deploy.
	forwardQuery: `SELECT
    OrgId, Hour, ServiceName, SeverityText, DeploymentEnv,
    Count, SizeBytes,
    ServiceNamespace`,
	engine: engine.aggregatingMergeTree({
		partitionKey: "toDate(Hour)",
		// ServiceNamespace is a grouping dimension, so it must live in the sorting
		// key (like DeploymentEnv) — AggregatingMergeTree collapses non-key,
		// non-aggregate columns on merge otherwise.
		sortingKey: ["OrgId", "Hour", "ServiceName", "SeverityText", "DeploymentEnv", "ServiceNamespace"],
		ttl: "toDate(Hour) + INTERVAL 90 DAY",
	}),
	indexes: [
		{
			name: "idx_service_namespace",
			expr: "ServiceNamespace",
			type: "set(1000)",
			granularity: 4,
		},
	],
})

export type LogsAggregatesHourlyRow = InferRow<typeof logsAggregatesHourly>

/**
 * Session replay session metadata — one row per browser session.
 *
 * Ingested directly via `POST /v1/sessionReplays/meta` (NDJSON) from the
 * `@maple-dev/browser` SDK, not via a materialized view. The SDK writes a partial
 * row at session start (`Version=1`, `Status='active'`) and a complete row on
 * page hide / unload (`Version=2`, `Status='ended'`, final `EndTime`/`DurationMs`).
 * ReplacingMergeTree keyed by Version keeps the latest, so consumers should
 * read with `FINAL` (or dedupe `LIMIT 1 BY (OrgId, SessionId) ORDER BY Version DESC`).
 *
 * The rrweb event payloads live in `sessionReplayEvents` (one row per chunk,
 * payload inline in ClickHouse — there is no R2 blob store); this table only
 * holds small, queryable metadata so the sessions list/filter views never
 * touch the multi-MB rrweb blobs.
 *
 * `TraceIds` carries the OTel trace ids observed during the session — the
 * correlation key that lets the trace detail view link to a replay and back.
 *
 * TTL is 30 days (matches traces/logs) — replays are large and lose value
 * fast; keep in lockstep with `sessionReplayEvents`' TTL.
 */
export const sessionReplays = defineDatasource("session_replays", {
	description:
		"Per-session browser replay metadata (one row per session). Ingested directly from the @maple-dev/browser SDK via POST /v1/sessionReplays/meta. Event payloads live inline in session_replay_events; this holds only queryable metadata. ReplacingMergeTree(Version) for start/end upsert.",
	schema: {
		OrgId: column(t.string().lowCardinality(), { jsonPath: "$.org_id" }),
		SessionId: column(t.string(), { jsonPath: "$.session_id" }),
		StartTime: column(t.dateTime64(9), { jsonPath: "$.start_time" }),
		EndTime: column(t.dateTime64(9).nullable(), { jsonPath: "$.end_time" }),
		DurationMs: column(t.uint32().nullable(), { jsonPath: "$.duration_ms" }),
		Status: column(t.string().lowCardinality(), { jsonPath: "$.status" }),
		UserId: column(t.string(), { jsonPath: "$.user_id" }),
		UrlInitial: column(t.string(), { jsonPath: "$.url_initial" }),
		UserAgent: column(t.string(), { jsonPath: "$.user_agent" }),
		BrowserName: column(t.string().lowCardinality(), { jsonPath: "$.browser_name" }),
		OsName: column(t.string().lowCardinality(), { jsonPath: "$.os_name" }),
		DeviceType: column(t.string().lowCardinality(), { jsonPath: "$.device_type" }),
		// Server-derived (Cf-IPCountry); the SDK never sends it, so default to ''
		// rather than quarantine the row under strict type checking.
		Country: column(t.string().lowCardinality().default(""), { jsonPath: "$.country" }),
		ServiceName: column(t.string().lowCardinality(), { jsonPath: "$.service_name" }),
		PageViews: column(t.uint32().default(0), { jsonPath: "$.page_views" }),
		ClickCount: column(t.uint32().default(0), { jsonPath: "$.click_count" }),
		ErrorCount: column(t.uint32().default(0), { jsonPath: "$.error_count" }),
		// Only present on the ended (v2) row — the active (v1) row omits it, so
		// default to [] to keep the in-progress row out of quarantine.
		TraceIds: column(t.array(t.string()).default([]), { jsonPath: "$.trace_ids[:]" }),
		ResourceAttributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.resource_attributes",
		}),
		Version: column(t.uint32(), { jsonPath: "$.version" }),
	},
	engine: engine.replacingMergeTree({
		partitionKey: "toDate(StartTime)",
		sortingKey: ["OrgId", "SessionId"],
		ver: "Version",
		ttl: "toDate(StartTime) + INTERVAL 30 DAY",
	}),
})

export type SessionReplaysRow = InferRow<typeof sessionReplays>

/**
 * Session replay events — one row per uploaded rrweb chunk, payload included.
 *
 * The ingest gateway gunzips the chunk body and writes the rrweb event array
 * JSON into `Events` (a String column ClickHouse ZSTD-compresses). Playback
 * reads chunks back directly from here — there is no R2 blob store on the
 * replay path.
 *
 * `IsCheckpoint=1` marks chunks that contain a full rrweb DOM snapshot, so the
 * player can seek to a timestamp by loading the nearest preceding checkpoint
 * rather than replaying from t=0.
 *
 * Sorted by (OrgId, SessionId, ChunkSeq) so fetching a whole session's chunks
 * in playback order is a single contiguous range scan. 30-day TTL matches
 * `sessionReplays`.
 */
export const sessionReplayEvents = defineDatasource("session_replay_events", {
	description:
		"Session replay rrweb events (one row per chunk, payload included). The ingest gateway gunzips the chunk and stores the event-array JSON in `Events`. Playback reads directly from ClickHouse — no R2.",
	schema: {
		OrgId: column(t.string().lowCardinality(), { jsonPath: "$.org_id" }),
		SessionId: column(t.string(), { jsonPath: "$.session_id" }),
		ChunkSeq: column(t.uint32(), { jsonPath: "$.chunk_seq" }),
		Timestamp: column(t.dateTime64(9), { jsonPath: "$.timestamp" }),
		DurationMs: column(t.uint32().default(0), { jsonPath: "$.duration_ms" }),
		EventCount: column(t.uint32().default(0), { jsonPath: "$.event_count" }),
		// Uncompressed byte length of the events JSON (telemetry / debugging).
		ByteSize: column(t.uint32().default(0), { jsonPath: "$.byte_size" }),
		// The rrweb event array, serialized as a JSON string.
		Events: column(t.string(), { jsonPath: "$.events" }),
		IsCheckpoint: column(t.uint8().default(0), { jsonPath: "$.is_checkpoint" }),
	},
	engine: engine.mergeTree({
		partitionKey: "toDate(Timestamp)",
		sortingKey: ["OrgId", "SessionId", "ChunkSeq"],
		ttl: "toDate(Timestamp) + INTERVAL 30 DAY",
	}),
})

export type SessionReplayEventsRow = InferRow<typeof sessionReplayEvents>

/**
 * Distilled session events — structured semantic events (navigation, clicks,
 * console logs, network requests, errors) captured client-side by the
 * `@maple-dev/browser` SDK and ingested via `POST /v1/sessionEvents` (NDJSON).
 *
 * This is the small, queryable layer that powers in-session search, the
 * console/network/error panels, and the agent transcript — distinct from the
 * raw rrweb payloads in `sessionReplayEvents`. Sparse: only the columns
 * relevant to a row's `Type` are populated; the rest default empty.
 *
 * Plain MergeTree (immutable append, no dedup) sorted by
 * (OrgId, SessionId, Timestamp, Seq) so a whole session's transcript is a
 * single contiguous range scan. 30-day TTL matches `sessionReplays`.
 */
export const sessionEvents = defineDatasource("session_events", {
	description:
		"Distilled structured session events (navigation, click, input, console, network, error) captured client-side and ingested via POST /v1/sessionEvents. Powers in-session search, replay panels, and agent transcripts.",
	schema: {
		OrgId: column(t.string().lowCardinality(), { jsonPath: "$.org_id" }),
		SessionId: column(t.string(), { jsonPath: "$.session_id" }),
		Timestamp: column(t.dateTime64(9), { jsonPath: "$.timestamp" }),
		Seq: column(t.uint32().default(0), { jsonPath: "$.seq" }),
		Type: column(t.string().lowCardinality(), { jsonPath: "$.type" }),
		Url: column(t.string().default(""), { jsonPath: "$.url" }),
		TraceId: column(t.string().default(""), { jsonPath: "$.trace_id" }),
		Level: column(t.string().lowCardinality().default(""), { jsonPath: "$.level" }),
		Message: column(t.string().default(""), { jsonPath: "$.message" }),
		TargetSelector: column(t.string().default(""), { jsonPath: "$.target_selector" }),
		TargetText: column(t.string().default(""), { jsonPath: "$.target_text" }),
		NetMethod: column(t.string().lowCardinality().default(""), { jsonPath: "$.net_method" }),
		NetUrl: column(t.string().default(""), { jsonPath: "$.net_url" }),
		NetStatus: column(t.uint16().default(0), { jsonPath: "$.net_status" }),
		NetDurationMs: column(t.uint32().default(0), { jsonPath: "$.net_duration_ms" }),
		ErrorStack: column(t.string().default(""), { jsonPath: "$.error_stack" }),
		Attributes: column(t.map(t.string().lowCardinality(), t.string()), {
			jsonPath: "$.attributes",
		}),
	},
	engine: engine.mergeTree({
		partitionKey: "toDate(Timestamp)",
		sortingKey: ["OrgId", "SessionId", "Timestamp", "Seq"],
		ttl: "toDate(Timestamp) + INTERVAL 30 DAY",
	}),
})

export type SessionEventsRow = InferRow<typeof sessionEvents>
