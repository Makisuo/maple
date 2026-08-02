ATTACH TABLE _ UUID 'b2d50f17-d994-4a1c-8806-74abe4e8c73f'
(
    `OrgId` LowCardinality(String),
    `SessionId` String,
    `StartTime` DateTime64(9),
    `EndTime` Nullable(DateTime64(9)),
    `DurationMs` Nullable(UInt32),
    `Status` LowCardinality(String),
    `UserId` String,
    `UrlInitial` String,
    `UserAgent` String,
    `BrowserName` LowCardinality(String),
    `OsName` LowCardinality(String),
    `DeviceType` LowCardinality(String),
    `Country` LowCardinality(String) DEFAULT '',
    `ServiceName` LowCardinality(String),
    `PageViews` UInt32 DEFAULT 0,
    `ClickCount` UInt32 DEFAULT 0,
    `ErrorCount` UInt32 DEFAULT 0,
    `TraceIds` Array(String) DEFAULT [],
    `ResourceAttributes` Map(LowCardinality(String), String),
    `Version` UInt32,
    `VisitorId` String DEFAULT '',
    `VisitorIsNew` UInt8 DEFAULT 0,
    `UserEmail` String DEFAULT '',
    `UserName` String DEFAULT '',
    `GroupId` String DEFAULT '',
    `GroupName` String DEFAULT '',
    `UserTraits` Map(String, String) DEFAULT map(),
    `Referrer` String DEFAULT '',
    `ReferrerHost` LowCardinality(String) DEFAULT '',
    `UtmSource` LowCardinality(String) DEFAULT '',
    `UtmMedium` LowCardinality(String) DEFAULT '',
    `UtmCampaign` LowCardinality(String) DEFAULT '',
    `UtmTerm` String DEFAULT '',
    `UtmContent` String DEFAULT '',
    `Host` LowCardinality(String) DEFAULT '',
    `EntryPath` String DEFAULT '',
    `ExitPath` String DEFAULT '',
    `Language` LowCardinality(String) DEFAULT '',
    `LastActivityAt` Nullable(DateTime64(9))
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(StartTime)
ORDER BY (OrgId, SessionId)
TTL toDate(StartTime) + toIntervalDay(30)
SETTINGS index_granularity = 8192
