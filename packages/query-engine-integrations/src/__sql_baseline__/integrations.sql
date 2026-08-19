-- builder:ai-sessions:aiSessionListQuery:default
SELECT
          sessionId AS sessionId,
          argMin(vendorId, sessionStart) AS vendorId,
          argMin(vendorVersion, sessionStart) AS vendorVersion,
          count() AS traceCount,
          sum(spanCount) AS spanCount,
          sum(errorSpanCount) AS errorSpanCount,
          groupUniqArrayArray(serviceNames) AS serviceNames,
          toString(min(traceStart)) AS startTime,
          toString(fromUnixTimestamp64Nano(max(traceEndNanos))) AS endTime,
          intDiv(max(traceEndNanos) - toUnixTimestamp64Nano(min(traceStart)), 1000000) AS durationMs
        FROM (SELECT
          TraceId AS traceId,
          max(SpanAttributes['maple_ai.session.id']) AS sessionId,
          argMin(SpanAttributes['maple_ai.vendor.id'], if((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), Timestamp, toDateTime('2106-01-01 00:00:00'))) AS vendorId,
          argMin(SpanAttributes['maple_ai.vendor.version'], if((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), Timestamp, toDateTime('2106-01-01 00:00:00'))) AS vendorVersion,
          min(if((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), Timestamp, toDateTime('2106-01-01 00:00:00'))) AS sessionStart,
          count() AS spanCount,
          countIf(StatusCode = 'Error') AS errorSpanCount,
          groupUniqArray(ServiceName) AS serviceNames,
          min(Timestamp) AS traceStart,
          max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS traceEndNanos
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND TraceId IN (SELECT
          TraceId AS TraceId
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''))
        GROUP BY traceId) AS session_traces
        WHERE sessionId != ''
        GROUP BY sessionId
        ORDER BY startTime DESC
        LIMIT 50
        FORMAT JSON

-- builder:ai-sessions:aiSessionListQuery:filtered
SELECT
          sessionId AS sessionId,
          argMin(vendorId, sessionStart) AS vendorId,
          argMin(vendorVersion, sessionStart) AS vendorVersion,
          count() AS traceCount,
          sum(spanCount) AS spanCount,
          sum(errorSpanCount) AS errorSpanCount,
          groupUniqArrayArray(serviceNames) AS serviceNames,
          toString(min(traceStart)) AS startTime,
          toString(fromUnixTimestamp64Nano(max(traceEndNanos))) AS endTime,
          intDiv(max(traceEndNanos) - toUnixTimestamp64Nano(min(traceStart)), 1000000) AS durationMs
        FROM (SELECT
          TraceId AS traceId,
          max(SpanAttributes['maple_ai.session.id']) AS sessionId,
          argMin(SpanAttributes['maple_ai.vendor.id'], if((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), Timestamp, toDateTime('2106-01-01 00:00:00'))) AS vendorId,
          argMin(SpanAttributes['maple_ai.vendor.version'], if((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), Timestamp, toDateTime('2106-01-01 00:00:00'))) AS vendorVersion,
          min(if((mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != ''), Timestamp, toDateTime('2106-01-01 00:00:00'))) AS sessionStart,
          count() AS spanCount,
          countIf(StatusCode = 'Error') AS errorSpanCount,
          groupUniqArray(ServiceName) AS serviceNames,
          min(Timestamp) AS traceStart,
          max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS traceEndNanos
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND TraceId IN (SELECT
          TraceId AS TraceId
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != '')
          AND SpanAttributes['maple_ai.vendor.id'] IN ('eve')
          AND ServiceName IN ('maple-slack-agent'))
        GROUP BY traceId) AS session_traces
        WHERE sessionId != ''
        GROUP BY sessionId
        ORDER BY startTime DESC
        LIMIT 25
        FORMAT JSON

-- builder:ai-sessions:aiSessionSpansQuery:default
SELECT
          TraceId AS traceId,
          SpanId AS spanId,
          ParentSpanId AS parentSpanId,
          SpanName AS spanName,
          SpanKind AS spanKind,
          ServiceName AS serviceName,
          Duration / 1000000 AS durationMs,
          StatusCode AS statusCode,
          StatusMessage AS statusMessage,
          toString(Timestamp) AS timestamp,
          SpanAttributes AS spanAttributes,
          ResourceAttributes AS resourceAttributes
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND TraceId IN (SELECT
          TraceId AS TraceId
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (mapContains(SpanAttributes, 'maple_ai.session.id') AND SpanAttributes['maple_ai.session.id'] != '')
          AND SpanAttributes['maple_ai.session.id'] = 'wrun_sql_catalog')
        ORDER BY timestamp ASC, spanId ASC
        LIMIT 2000
        FORMAT JSON

-- builder:cloudflare-infra-breakdowns:cloudflareZoneBreakdownTimeseriesSQL:default
SELECT
          formatDateTime(toStartOfInterval(TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          if(Attributes['url.path'] IN ('/api/v2/traces'), Attributes['url.path'], 'other') AS key,
          sum(Value) AS requests
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'cloudflare-zone-example-com'
          AND MetricName = 'cloudflare.http.requests.by_path'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY bucket, key
        ORDER BY bucket ASC, key ASC
        FORMAT JSON

-- builder:cloudflare-infra-extended:cloudflareQueueGaugesSQL:default
SELECT
          ServiceName AS serviceName,
          if(countIf(MetricName = 'cloudflare.queue.backlog.messages') > 0, avgIf(Value, MetricName = 'cloudflare.queue.backlog.messages'), 0) AS backlogMessages,
          maxIf(Value, MetricName = 'cloudflare.queue.backlog.messages') AS backlogMessagesMax,
          if(countIf(MetricName = 'cloudflare.queue.backlog.bytes') > 0, avgIf(Value, MetricName = 'cloudflare.queue.backlog.bytes'), 0) AS backlogBytes,
          if(countIf(MetricName = 'cloudflare.queue.consumer.concurrency') > 0, avgIf(Value, MetricName = 'cloudflare.queue.consumer.concurrency'), 0) AS consumerConcurrency
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.queue.backlog.messages', 'cloudflare.queue.backlog.bytes', 'cloudflare.queue.consumer.concurrency')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        ORDER BY backlogMessagesMax DESC
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneLatencySQL:default
SELECT
          ServiceName AS serviceName,
          if(countIf((MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.5')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.5')), 0) AS ttfbP50Ms,
          if(countIf((MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.95')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.95')), 0) AS ttfbP95Ms,
          if(countIf((MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.99')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.edge.ttfb' AND Attributes['quantile'] = '0.99')), 0) AS ttfbP99Ms,
          if(countIf((MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.5')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.5')), 0) AS originP50Ms,
          if(countIf((MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.95')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.95')), 0) AS originP95Ms,
          if(countIf((MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.99')) > 0, avgIf(Value, (MetricName = 'cloudflare.http.origin.duration' AND Attributes['quantile'] = '0.99')), 0) AS originP99Ms
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.http.edge.ttfb', 'cloudflare.http.origin.duration')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneTimeseriesSQL:default
SELECT
          ServiceName AS serviceName,
          formatDateTime(toStartOfInterval(TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          sumIf(Value, MetricName = 'cloudflare.http.requests') AS requests,
          sumIf(Value, (MetricName = 'cloudflare.http.requests' AND Attributes['http.status_class'] = '5xx')) AS errors5xx,
          sumIf(Value, (MetricName = 'cloudflare.http.requests' AND Attributes['cache.status'] IN ('hit', 'stale', 'revalidated', 'updating'))) AS cacheHits,
          sumIf(Value, MetricName = 'cloudflare.http.bytes') AS bytes,
          sumIf(Value, MetricName = 'cloudflare.http.visits') AS visits
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.http.requests', 'cloudflare.http.bytes', 'cloudflare.http.visits')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName, bucket
        ORDER BY serviceName ASC, bucket ASC
        FORMAT JSON

-- builder:cloudflare-infra:cloudflareZoneTimeseriesSQL:filtered
SELECT
          ServiceName AS serviceName,
          formatDateTime(toStartOfInterval(TimeUnix, INTERVAL 300 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          sumIf(Value, MetricName = 'cloudflare.http.requests') AS requests,
          sumIf(Value, (MetricName = 'cloudflare.http.requests' AND Attributes['http.status_class'] = '5xx')) AS errors5xx,
          sumIf(Value, (MetricName = 'cloudflare.http.requests' AND Attributes['cache.status'] IN ('hit', 'stale', 'revalidated', 'updating'))) AS cacheHits,
          sumIf(Value, MetricName = 'cloudflare.http.bytes') AS bytes,
          sumIf(Value, MetricName = 'cloudflare.http.visits') AS visits
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.http.requests', 'cloudflare.http.bytes', 'cloudflare.http.visits')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND if(Attributes['server.address'] != '', Attributes['server.address'], Attributes['http.host']) IN ('example.com')
          AND Attributes['http.status_class'] IN ('5xx')
        GROUP BY serviceName, bucket
        ORDER BY serviceName ASC, bucket ASC
        FORMAT JSON

-- builder:cloudflare-map:cloudflareServiceLatencySQL:default
SELECT
          ServiceName AS serviceName,
          if(countIf((MetricName = 'cloudflare.worker.duration' AND Attributes['quantile'] = '0.99')) > 0, avgIf(Value, (MetricName = 'cloudflare.worker.duration' AND Attributes['quantile'] = '0.99')), 0) AS latencyP99Ms,
          if(countIf((MetricName = 'cloudflare.worker.cpu_time' AND Attributes['quantile'] = '0.99')) > 0, avgIf(Value, (MetricName = 'cloudflare.worker.cpu_time' AND Attributes['quantile'] = '0.99')), 0) AS cpuP99Ms
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.worker.duration', 'cloudflare.worker.cpu_time')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName
        LIMIT 500
        FORMAT JSON

-- builder:cloudflare-usage:cloudflareUsageQuery:default
SELECT
          ServiceName AS serviceName,
          formatDateTime(toStartOfInterval(TimeUnix, INTERVAL 3600 SECOND), '%Y-%m-%dT%H:%i:%S.%fZ') AS bucket,
          sum(Value) AS requests,
          count() AS datapoints,
          formatDateTime(max(TimeUnix), '%Y-%m-%dT%H:%i:%S.%fZ') AS lastTimeUnix
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('cloudflare.http.requests', 'cloudflare.worker.requests')
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY serviceName, bucket
        ORDER BY serviceName ASC, bucket ASC
        FORMAT JSON

-- builder:planetscale-map:planetscaleGaugesSQL:default
SELECT
          coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) AS database,
          maxIf(Value, MetricName IN ('planetscale_pods_cpu_util_percentages')) AS cpuMaxPercent,
          maxIf(Value, MetricName IN ('planetscale_pods_mem_util_percentages')) AS memMaxPercent,
          maxIf(Value, MetricName IN ('planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds')) AS replicaLagMaxSeconds
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName IN ('planetscale_pods_cpu_util_percentages', 'planetscale_pods_mem_util_percentages', 'planetscale_mysql_replica_lag_seconds', 'planetscale_vttablet_replication_lag', 'planetscale_postgres_replica_lag_seconds')
          AND coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) != ''
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY database
        LIMIT 500
        FORMAT JSON