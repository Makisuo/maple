ATTACH TABLE _ UUID '49f07d1c-f844-4d18-80c2-e48719e099d6'
(
    `OrgId` LowCardinality(String),
    `RuleId` String,
    `GroupKey` String,
    `Timestamp` DateTime64(3),
    `Status` LowCardinality(String),
    `SignalType` LowCardinality(String),
    `Comparator` LowCardinality(String),
    `Threshold` Float64,
    `ObservedValue` Nullable(Float64),
    `SampleCount` UInt32,
    `WindowMinutes` UInt16,
    `WindowStart` DateTime64(3),
    `WindowEnd` DateTime64(3),
    `ConsecutiveBreaches` UInt16,
    `ConsecutiveHealthy` UInt16,
    `IncidentId` Nullable(String),
    `IncidentTransition` LowCardinality(String),
    `EvaluationDurationMs` UInt32,
    `ErrorMessage` Nullable(String),
    `ErrorCategory` LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, RuleId, GroupKey, Timestamp)
TTL toDate(Timestamp) + toIntervalDay(365)
SETTINGS index_granularity = 8192
