// Build a stopped native source store from the historical raw-table DDL.
//
// This intentionally does not use the current Maple server bootstrap path:
// the migration probe must prove that a physical legacy source can be opened
// by native chDB before the current target schema is created.

import { Chdb } from "../src/server/chdb"
import { markStoreClosedDurable, markStoreOpenDurable } from "../src/server/store-version"

const [dataDir, configFile] = process.argv.slice(2)
if (!dataDir || !configFile)
	throw new Error("usage: native-local-store-migration-fixture.ts <data-dir> <config-file>")

/** Historical raw-table definitions used by the v0 recovery edge. Derived
 * objects are intentionally omitted: the migration retains them in the
 * rollback source and rebuilds the complete v1 target schema. */
const LEGACY_SCHEMA_SQL = String.raw`
CREATE TABLE IF NOT EXISTS logs (
    OrgId LowCardinality(String),
    Timestamp DateTime64(9),
    TimestampTime DateTime,
    TraceId String,
    SpanId String,
    TraceFlags UInt8,
    SeverityText LowCardinality(String),
    SeverityNumber UInt8,
    ServiceName LowCardinality(String),
    Body String,
    ResourceSchemaUrl String,
    ResourceAttributes Map(LowCardinality(String), String),
    ScopeSchemaUrl String,
    ScopeName String,
    ScopeVersion String,
    ScopeAttributes Map(LowCardinality(String), String),
    LogAttributes Map(LowCardinality(String), String),
    ResourceAttributeItems Array(String) DEFAULT arrayMap((k, v) -> concat(k, char(31), v), mapKeys(ResourceAttributes), mapValues(ResourceAttributes)),
    ScopeAttributeItems Array(String) DEFAULT arrayMap((k, v) -> concat(k, char(31), v), mapKeys(ScopeAttributes), mapValues(ScopeAttributes)),
    LogAttributeItems Array(String) DEFAULT arrayMap((k, v) -> concat(k, char(31), v), mapKeys(LogAttributes), mapValues(LogAttributes)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_resource_attr_keys mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_resource_attr_vals mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_keys mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_vals mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_log_attr_keys mapKeys(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_log_attr_vals mapValues(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_lower_body lower(Body) TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8
)
ENGINE = MergeTree
PARTITION BY toDate(TimestampTime)
ORDER BY (OrgId, toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp)
TTL toDate(TimestampTime) + INTERVAL 30 DAY;

CREATE TABLE IF NOT EXISTS traces (
    OrgId LowCardinality(String),
    Timestamp DateTime64(9),
    TraceId String,
    SpanId String,
    ParentSpanId String,
    TraceState String,
    SpanName LowCardinality(String),
    SpanKind LowCardinality(String),
    ServiceName LowCardinality(String),
    ResourceSchemaUrl String,
    ResourceAttributes Map(LowCardinality(String), String),
    ScopeSchemaUrl String,
    ScopeName String,
    ScopeVersion String,
    ScopeAttributes Map(LowCardinality(String), String),
    Duration UInt64 DEFAULT 0,
    StatusCode LowCardinality(String),
    StatusMessage String,
    SpanAttributes Map(LowCardinality(String), String),
    EventsTimestamp Array(DateTime64(9)),
    EventsName Array(LowCardinality(String)),
    EventsAttributes Array(Map(LowCardinality(String), String)),
    LinksTraceId Array(String),
    LinksSpanId Array(String),
    LinksTraceState Array(String),
    LinksAttributes Array(Map(LowCardinality(String), String)),
	SampleRate Float64 DEFAULT multiIf(SpanAttributes['SampleRate'] != '' AND toFloat64OrZero(SpanAttributes['SampleRate']) >= 1.0, toFloat64OrZero(SpanAttributes['SampleRate']), match(TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0),
    IsEntryPoint UInt8 DEFAULT if(SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '', 1, 0),
    ResourceAttributeItems Array(String) DEFAULT arrayMap((k, v) -> concat(k, char(31), v), mapKeys(ResourceAttributes), mapValues(ResourceAttributes)),
    ScopeAttributeItems Array(String) DEFAULT arrayMap((k, v) -> concat(k, char(31), v), mapKeys(ScopeAttributes), mapValues(ScopeAttributes)),
    SpanAttributeItems Array(String) DEFAULT arrayMap((k, v) -> concat(k, char(31), v), mapKeys(SpanAttributes), mapValues(SpanAttributes)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_keys mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_vals mapValues(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_resource_attr_keys mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_resource_attr_vals mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_keys mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_vals mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, ServiceName, SpanName, toDateTime(Timestamp))
TTL toDate(Timestamp) + INTERVAL 30 DAY;

CREATE TABLE IF NOT EXISTS metrics_sum (
    OrgId LowCardinality(String),
    ResourceAttributes Map(LowCardinality(String), String),
    ResourceSchemaUrl String,
    ScopeName String,
    ScopeVersion String,
    ScopeAttributes Map(LowCardinality(String), String),
    ScopeSchemaUrl String,
    ServiceName LowCardinality(String),
    MetricName LowCardinality(String),
    MetricDescription LowCardinality(String),
    MetricUnit LowCardinality(String),
    Attributes Map(LowCardinality(String), String),
    StartTimeUnix DateTime64(9),
    TimeUnix DateTime64(9),
    Value Float64,
    Flags UInt32,
    ExemplarsTraceId Array(String),
    ExemplarsSpanId Array(String),
    ExemplarsTimestamp Array(DateTime64(9)),
    ExemplarsValue Array(Float64),
    ExemplarsFilteredAttributes Array(Map(LowCardinality(String), String)),
    AggregationTemporality Int32,
    IsMonotonic Bool
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (OrgId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
TTL toDate(TimeUnix) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS metrics_gauge (
    OrgId LowCardinality(String),
    ResourceAttributes Map(LowCardinality(String), String),
    ResourceSchemaUrl String,
    ScopeName String,
    ScopeVersion String,
    ScopeAttributes Map(LowCardinality(String), String),
    ScopeSchemaUrl String,
    ServiceName LowCardinality(String),
    MetricName LowCardinality(String),
    MetricDescription LowCardinality(String),
    MetricUnit LowCardinality(String),
    Attributes Map(LowCardinality(String), String),
    StartTimeUnix DateTime64(9),
    TimeUnix DateTime64(9),
    Value Float64,
    Flags UInt32,
    ExemplarsTraceId Array(String),
    ExemplarsSpanId Array(String),
    ExemplarsTimestamp Array(DateTime64(9)),
    ExemplarsValue Array(Float64),
    ExemplarsFilteredAttributes Array(Map(LowCardinality(String), String))
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (OrgId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
TTL toDate(TimeUnix) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS metrics_histogram (
    OrgId LowCardinality(String),
    ResourceAttributes Map(LowCardinality(String), String),
    ResourceSchemaUrl String,
    ScopeName String,
    ScopeVersion String,
    ScopeAttributes Map(LowCardinality(String), String),
    ScopeSchemaUrl String,
    ServiceName LowCardinality(String),
    MetricName LowCardinality(String),
    MetricDescription LowCardinality(String),
    MetricUnit LowCardinality(String),
    Attributes Map(LowCardinality(String), String),
    StartTimeUnix DateTime64(9),
    TimeUnix DateTime64(9),
    Count UInt64,
    Sum Float64,
    BucketCounts Array(UInt64),
    ExplicitBounds Array(Float64),
    ExemplarsTraceId Array(String),
    ExemplarsSpanId Array(String),
    ExemplarsTimestamp Array(DateTime64(9)),
    ExemplarsValue Array(Float64),
    ExemplarsFilteredAttributes Array(Map(LowCardinality(String), String)),
    Flags UInt32,
    Min Nullable(Float64),
    Max Nullable(Float64),
    AggregationTemporality Int32
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (OrgId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
TTL toDate(TimeUnix) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS metrics_exponential_histogram (
    OrgId LowCardinality(String),
    ResourceAttributes Map(LowCardinality(String), String),
    ResourceSchemaUrl String,
    ScopeName String,
    ScopeVersion String,
    ScopeAttributes Map(LowCardinality(String), String),
    ScopeSchemaUrl String,
    ServiceName LowCardinality(String),
    MetricName LowCardinality(String),
    MetricDescription LowCardinality(String),
    MetricUnit LowCardinality(String),
    Attributes Map(LowCardinality(String), String),
    StartTimeUnix DateTime64(9),
    TimeUnix DateTime64(9),
    Count UInt64,
    Sum Float64,
    Scale Int32,
    ZeroCount UInt64,
    PositiveOffset Int32,
    PositiveBucketCounts Array(UInt64),
    NegativeOffset Int32,
    NegativeBucketCounts Array(UInt64),
    ExemplarsTraceId Array(String),
    ExemplarsSpanId Array(String),
    ExemplarsTimestamp Array(DateTime64(9)),
    ExemplarsValue Array(Float64),
    ExemplarsFilteredAttributes Array(Map(LowCardinality(String), String)),
    Flags UInt32,
    Min Nullable(Float64),
    Max Nullable(Float64),
    AggregationTemporality Int32
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (OrgId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
TTL toDate(TimeUnix) + INTERVAL 90 DAY;
`

const sharedResourceAttributes = "map('service.namespace', 'payments', 'deployment.environment', 'test')"
const sharedAttributes =
	"map('db.system', 'postgresql', 'db.namespace', 'orders', 'db.operation.name', 'SELECT', 'db.query.text', 'SELECT * FROM orders')"
const insertStatements = [
	"INSERT INTO logs (OrgId, Timestamp, TimestampTime, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body) SELECT 'native-migration', now64(9), now(), 'trace-native-log', 'span-native-log', 1, 'INFO', 9, 'native-migration', 'legacy source'",
	`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, ResourceAttributes, SpanAttributes, StatusCode, StatusMessage) SELECT 'native-migration', now64(9), 'trace-native-db', 'span-native-db', '', '', 'SELECT orders', 'Client', 'native-migration', ${sharedResourceAttributes}, ${sharedAttributes}, 'Ok', ''`,
	`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, ResourceAttributes, SpanAttributes, StatusCode, StatusMessage) SELECT 'native-migration', now64(9), 'trace-native-server', 'span-native-server', '', '', 'GET /orders', 'Server', 'native-migration', ${sharedResourceAttributes}, map(), 'Ok', ''`,
	"INSERT INTO metrics_sum (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic) SELECT 'native-migration', 'native-migration', 'sum-native', now64(9), now64(9), 1, 2, true",
	"INSERT INTO metrics_gauge (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value) SELECT 'native-migration', 'native-migration', 'gauge-native', now64(9), now64(9), 1",
	"INSERT INTO metrics_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, AggregationTemporality) SELECT 'native-migration', 'native-migration', 'hist-native', now64(9), now64(9), 1, 1, [1], [1.0], 2",
	"INSERT INTO metrics_exponential_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, Scale, ZeroCount, PositiveOffset, PositiveBucketCounts, NegativeOffset, NegativeBucketCounts, AggregationTemporality) SELECT 'native-migration', 'native-migration', 'exp-native', now64(9), now64(9), 1, 1, 0, 0, 0, [1], 0, [], 2",
]

await markStoreOpenDurable(dataDir)
let db: Chdb | undefined
let closed = false
try {
	db = Chdb.open({ dataDir, configFile, schemaSql: LEGACY_SCHEMA_SQL })
	for (const statement of insertStatements) db.exec(statement)
	db.close()
	db = undefined
	closed = true
} finally {
	if (db !== undefined) db.close()
	if (closed) await markStoreClosedDurable(dataDir)
}
