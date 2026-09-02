-- builder:activity:activeOrgsByErrorEventsQuery:default  [eae8a088]
SELECT
          OrgId AS orgId
        FROM error_events_by_time
        WHERE Timestamp >= '2026-01-01 10:30:00'
        GROUP BY orgId
        FORMAT JSON

-- builder:activity:activeOrgsByLogsQuery:default  [8c4b87f8]
SELECT
          OrgId AS orgId
        FROM logs_aggregates_hourly
        WHERE Hour >= '2026-01-01 10:30:00'
        GROUP BY orgId
        FORMAT JSON

-- builder:activity:activeOrgsByTracesQuery:default  [80107423]
SELECT
          OrgId AS orgId
        FROM traces_aggregates_hourly
        WHERE Hour >= '2026-01-01 10:30:00'
        GROUP BY orgId
        FORMAT JSON

-- builder:containers:containerCountersSummaryQuery:default  [6bbc043d]
SELECT
          avg(memoryBytesAvg) AS memoryBytesAvg,
          max(memoryLimitBytes) AS memoryLimitBytes,
          sum(restartsDelta) AS restartsDelta,
          avg(pidsAvg) AS pidsAvg
        FROM (SELECT
          ResourceAttributes['host.name'] AS hostName,
          ifNotFinite(avgIf(Value, MetricName = 'container.memory.usage.total'), 0) AS memoryBytesAvg,
          ifNotFinite(maxIf(Value, MetricName = 'container.memory.usage.limit'), 0) AS memoryLimitBytes,
          ifNotFinite(maxIf(Value, MetricName = 'container.restarts') - minIf(Value, MetricName = 'container.restarts'), 0) AS restartsDelta,
          ifNotFinite(avgIf(Value, MetricName = 'container.pids.count'), 0) AS pidsAvg
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] = 'api'
          AND ResourceAttributes['host.name'] = 'ip-10-0-1-42'
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('container.memory.usage.total', 'container.memory.usage.limit', 'container.restarts', 'container.pids.count')
        GROUP BY hostName) AS hosts
        FORMAT JSON

-- builder:containers:containerDetailSummaryQuery:default  [6063da9a]
SELECT
          ResourceAttributes['container.name'] AS containerName,
          any(ResourceAttributes['host.name']) AS hostName,
          any(ResourceAttributes['container.id']) AS containerId,
          any(ResourceAttributes['container.image.name']) AS imageName,
          any(ResourceAttributes['compose.project']) AS composeProject,
          any(ResourceAttributes['compose.service']) AS composeService,
          any(ResourceAttributes['container.runtime']) AS runtime,
          min(TimeUnix) AS firstSeen,
          max(TimeUnix) AS lastSeen,
          ifNotFinite(avgIf(Value, MetricName = 'container.cpu.utilization'), 0) / 100 AS cpuPct,
          ifNotFinite(avgIf(Value, MetricName = 'container.memory.percent'), 0) / 100 AS memoryPct,
          ifNotFinite(avgIf(Value, MetricName = 'container.cpu.limit'), 0) AS cpuLimitCores,
          ifNotFinite(maxIf(Value, MetricName = 'container.uptime'), 0) AS uptimeSeconds
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] = 'api'
          AND ResourceAttributes['host.name'] = 'ip-10-0-1-42'
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('container.cpu.utilization', 'container.memory.percent', 'container.uptime', 'container.cpu.limit')
        GROUP BY containerName
        FORMAT JSON

-- builder:containers:containerFacetsQuery:default  [4d105ebe]
SELECT
          ResourceAttributes['container.name'] AS name,
          uniq(ResourceAttributes['container.id']) AS count,
          'container' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] != ''
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('container.cpu.utilization')
          AND ResourceAttributes['container.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 200
UNION ALL
SELECT
          ResourceAttributes['host.name'] AS name,
          uniq(ResourceAttributes['container.id']) AS count,
          'host' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] != ''
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('container.cpu.utilization')
          AND ResourceAttributes['host.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          ResourceAttributes['container.image.name'] AS name,
          uniq(ResourceAttributes['container.id']) AS count,
          'image' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] != ''
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('container.cpu.utilization')
          AND ResourceAttributes['container.image.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          ResourceAttributes['compose.project'] AS name,
          uniq(ResourceAttributes['container.id']) AS count,
          'composeProject' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] != ''
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('container.cpu.utilization')
          AND ResourceAttributes['compose.project'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          ResourceAttributes['compose.service'] AS name,
          uniq(ResourceAttributes['container.id']) AS count,
          'composeService' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] != ''
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('container.cpu.utilization')
          AND ResourceAttributes['compose.service'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS name,
          uniq(ResourceAttributes['container.id']) AS count,
          'environment' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] != ''
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('container.cpu.utilization')
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- builder:containers:containerGaugeTimeseriesQuery:percent  [092a5f0c]
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 300 SECOND) AS bucket,
          '' AS attributeValue,
          avg(Value) / 100 AS avgValue
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] = 'api'
          AND ResourceAttributes['host.name'] = 'ip-10-0-1-42'
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName = 'container.cpu.utilization'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:containers:containerGaugeTimeseriesQuery:unscaled  [6a0ebdb5]
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 300 SECOND) AS bucket,
          '' AS attributeValue,
          avg(Value) AS avgValue
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] = 'api'
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName = 'container.uptime'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:containers:containerSumTimeseriesQuery:blockio  [88784134]
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 300 SECOND) AS bucket,
          Attributes['operation'] AS attributeValue,
          sum(Value) AS sumValue
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] = 'api'
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('container.blockio.io_service_bytes_recursive')
        GROUP BY bucket, attributeValue
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:containers:containerSumTimeseriesQuery:memory-average  [ab3a920e]
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 300 SECOND) AS bucket,
          '' AS attributeValue,
          avg(Value) AS sumValue
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] = 'api'
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('container.memory.usage.total')
        GROUP BY bucket, attributeValue
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:containers:containerSumTimeseriesQuery:network  [6010f053]
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 300 SECOND) AS bucket,
          multiIf(MetricName = 'container.network.io.usage.rx_bytes', 'receive', MetricName = 'container.network.io.usage.tx_bytes', 'transmit', '') AS attributeValue,
          sum(Value) AS sumValue
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] = 'api'
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('container.network.io.usage.rx_bytes', 'container.network.io.usage.tx_bytes')
        GROUP BY bucket, attributeValue
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:containers:listContainersQuery:default  [fe84ad79]
SELECT
          containerName AS containerName,
          hostName AS hostName,
          containerId AS containerId,
          imageName AS imageName,
          composeProject AS composeProject,
          composeService AS composeService,
          runtime AS runtime,
          environment AS environment,
          lastSeen AS lastSeen,
          cpuPct AS cpuPct,
          memoryPct AS memoryPct,
          cpuPctPeak AS cpuPctPeak,
          memoryPctPeak AS memoryPctPeak,
          cpuLimitCores AS cpuLimitCores,
          uptimeSeconds AS uptimeSeconds,
          saturation AS saturation
        FROM (SELECT
          ResourceAttributes['container.name'] AS containerName,
          ResourceAttributes['host.name'] AS hostName,
          any(ResourceAttributes['container.id']) AS containerId,
          any(ResourceAttributes['container.image.name']) AS imageName,
          any(ResourceAttributes['compose.project']) AS composeProject,
          any(ResourceAttributes['compose.service']) AS composeService,
          any(ResourceAttributes['container.runtime']) AS runtime,
          any(coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment'])) AS environment,
          max(TimeUnix) AS lastSeen,
          ifNotFinite(avgIf(Value, MetricName = 'container.cpu.utilization'), 0) / 100 AS cpuPct,
          ifNotFinite(avgIf(Value, MetricName = 'container.memory.percent'), 0) / 100 AS memoryPct,
          ifNotFinite(maxIf(Value, MetricName = 'container.cpu.utilization'), 0) / 100 AS cpuPctPeak,
          ifNotFinite(maxIf(Value, MetricName = 'container.memory.percent'), 0) / 100 AS memoryPctPeak,
          ifNotFinite(avgIf(Value, MetricName = 'container.cpu.limit'), 0) AS cpuLimitCores,
          ifNotFinite(maxIf(Value, MetricName = 'container.uptime'), 0) AS uptimeSeconds,
          greatest(ifNotFinite(maxIf(Value, MetricName = 'container.cpu.utilization'), 0) / 100, ifNotFinite(maxIf(Value, MetricName = 'container.memory.percent'), 0) / 100) AS saturation
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] != ''
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('container.cpu.utilization', 'container.memory.percent', 'container.uptime', 'container.cpu.limit')
        GROUP BY containerName, hostName) AS containers
        ORDER BY saturation DESC, cpuPctPeak DESC, containerName ASC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:containers:listContainersQuery:filtered  [75408df7]
SELECT
          containerName AS containerName,
          hostName AS hostName,
          containerId AS containerId,
          imageName AS imageName,
          composeProject AS composeProject,
          composeService AS composeService,
          runtime AS runtime,
          environment AS environment,
          lastSeen AS lastSeen,
          cpuPct AS cpuPct,
          memoryPct AS memoryPct,
          cpuPctPeak AS cpuPctPeak,
          memoryPctPeak AS memoryPctPeak,
          cpuLimitCores AS cpuLimitCores,
          uptimeSeconds AS uptimeSeconds,
          saturation AS saturation
        FROM (SELECT
          ResourceAttributes['container.name'] AS containerName,
          ResourceAttributes['host.name'] AS hostName,
          any(ResourceAttributes['container.id']) AS containerId,
          any(ResourceAttributes['container.image.name']) AS imageName,
          any(ResourceAttributes['compose.project']) AS composeProject,
          any(ResourceAttributes['compose.service']) AS composeService,
          any(ResourceAttributes['container.runtime']) AS runtime,
          any(coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment'])) AS environment,
          max(TimeUnix) AS lastSeen,
          ifNotFinite(avgIf(Value, MetricName = 'container.cpu.utilization'), 0) / 100 AS cpuPct,
          ifNotFinite(avgIf(Value, MetricName = 'container.memory.percent'), 0) / 100 AS memoryPct,
          ifNotFinite(maxIf(Value, MetricName = 'container.cpu.utilization'), 0) / 100 AS cpuPctPeak,
          ifNotFinite(maxIf(Value, MetricName = 'container.memory.percent'), 0) / 100 AS memoryPctPeak,
          ifNotFinite(avgIf(Value, MetricName = 'container.cpu.limit'), 0) AS cpuLimitCores,
          ifNotFinite(maxIf(Value, MetricName = 'container.uptime'), 0) AS uptimeSeconds,
          greatest(ifNotFinite(maxIf(Value, MetricName = 'container.cpu.utilization'), 0) / 100, ifNotFinite(maxIf(Value, MetricName = 'container.memory.percent'), 0) / 100) AS saturation
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] != ''
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('container.cpu.utilization', 'container.memory.percent', 'container.uptime', 'container.cpu.limit')
          AND positionCaseInsensitive(ResourceAttributes['container.name'], 'api') > 0
          AND ResourceAttributes['container.name'] NOT IN ('buildkitd')
          AND ResourceAttributes['host.name'] IN ('ip-10-0-1-42')
          AND ResourceAttributes['container.image.name'] IN ('ghcr.io/acme/api:1.4.2')
          AND ResourceAttributes['compose.project'] IN ('shop')
        GROUP BY containerName, hostName) AS containers
        ORDER BY cpuPct DESC, cpuPctPeak DESC, containerName ASC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:containers:listContainersQuery:scoped  [41805227]
SELECT
          containerName AS containerName,
          hostName AS hostName,
          containerId AS containerId,
          imageName AS imageName,
          composeProject AS composeProject,
          composeService AS composeService,
          runtime AS runtime,
          environment AS environment,
          lastSeen AS lastSeen,
          cpuPct AS cpuPct,
          memoryPct AS memoryPct,
          cpuPctPeak AS cpuPctPeak,
          memoryPctPeak AS memoryPctPeak,
          cpuLimitCores AS cpuLimitCores,
          uptimeSeconds AS uptimeSeconds,
          saturation AS saturation
        FROM (SELECT
          ResourceAttributes['container.name'] AS containerName,
          ResourceAttributes['host.name'] AS hostName,
          any(ResourceAttributes['container.id']) AS containerId,
          any(ResourceAttributes['container.image.name']) AS imageName,
          any(ResourceAttributes['compose.project']) AS composeProject,
          any(ResourceAttributes['compose.service']) AS composeService,
          any(ResourceAttributes['container.runtime']) AS runtime,
          any(coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment'])) AS environment,
          max(TimeUnix) AS lastSeen,
          ifNotFinite(avgIf(Value, MetricName = 'container.cpu.utilization'), 0) / 100 AS cpuPct,
          ifNotFinite(avgIf(Value, MetricName = 'container.memory.percent'), 0) / 100 AS memoryPct,
          ifNotFinite(maxIf(Value, MetricName = 'container.cpu.utilization'), 0) / 100 AS cpuPctPeak,
          ifNotFinite(maxIf(Value, MetricName = 'container.memory.percent'), 0) / 100 AS memoryPctPeak,
          ifNotFinite(avgIf(Value, MetricName = 'container.cpu.limit'), 0) AS cpuLimitCores,
          ifNotFinite(maxIf(Value, MetricName = 'container.uptime'), 0) AS uptimeSeconds,
          greatest(ifNotFinite(maxIf(Value, MetricName = 'container.cpu.utilization'), 0) / 100, ifNotFinite(maxIf(Value, MetricName = 'container.memory.percent'), 0) / 100) AS saturation
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] != ''
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('container.cpu.utilization', 'container.memory.percent', 'container.uptime', 'container.cpu.limit')
        GROUP BY containerName, hostName) AS containers
        WHERE saturation >= 0.9
        ORDER BY saturation DESC, cpuPctPeak DESC, containerName ASC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:containers:listContainersSummaryQuery:default  [5709c9ea]
SELECT
          count() AS totalContainers,
          countIf(saturation >= 0.9) AS saturatedContainers,
          countIf((saturation >= 0.6 AND saturation < 0.9)) AS elevatedContainers,
          countIf(lastSeen < '2026-01-03 14:15:00' - INTERVAL 300 SECOND) AS staleContainers
        FROM (SELECT
          ResourceAttributes['container.name'] AS containerName,
          ResourceAttributes['host.name'] AS hostName,
          max(TimeUnix) AS lastSeen,
          greatest(ifNotFinite(maxIf(Value, MetricName = 'container.cpu.utilization'), 0) / 100, ifNotFinite(maxIf(Value, MetricName = 'container.memory.percent'), 0) / 100) AS saturation
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['container.name'] != ''
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('container.cpu.utilization', 'container.memory.percent')
        GROUP BY containerName, hostName) AS containers
        FORMAT JSON

-- builder:errors:errorFingerprintsQuery:envFiltered  [f1269c9f]
SELECT
          toString(FingerprintHash) AS fingerprintHash
        FROM error_events_by_time
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName IN ('api')
          AND DeploymentEnv IN ('production')
        GROUP BY fingerprintHash
        LIMIT 1000
        FORMAT JSON

-- builder:errors:errorIssueEnvironmentsQuery:default  [16b2e68d]
SELECT
          DeploymentEnv AS name,
          count() AS count
        FROM error_events
        WHERE OrgId = 'org_sql_catalog'
          AND FingerprintHash = toUInt64('11640393269246331608')
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
        FORMAT JSON

-- builder:errors:errorIssueSampleTracesQuery:default  [165204e4]
SELECT
          TraceId AS traceId,
          SpanId AS spanId,
          ServiceName AS serviceName,
          Timestamp AS timestamp,
          ExceptionMessage AS exceptionMessage,
          intDiv(Duration, 1000) AS durationMicros
        FROM error_events
        WHERE OrgId = 'org_sql_catalog'
          AND FingerprintHash = toUInt64('11640393269246331608')
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        ORDER BY timestamp DESC
        LIMIT 5
        FORMAT JSON

-- builder:errors:errorIssuesQuery:scan  [ce76d415]
SELECT
          toString(FingerprintHash) AS fingerprintHash,
          any(ServiceName) AS serviceName,
          any(ExceptionType) AS exceptionType,
          any(ExceptionMessage) AS exceptionMessage,
          any(ErrorLabel) AS errorLabel,
          any(TopFrame) AS topFrame,
          count() AS count,
          uniq(ServiceName) AS affectedServicesCount,
          min(Timestamp) AS firstSeen,
          max(Timestamp) AS lastSeen
        FROM error_events_by_time
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY fingerprintHash
        ORDER BY count DESC
        LIMIT 500
        FORMAT JSON

-- builder:errors:errorIssueTimeseriesQuery:default  [8ea53a5e]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 300 SECOND) AS bucket,
          count() AS count
        FROM error_events
        WHERE OrgId = 'org_sql_catalog'
          AND FingerprintHash = toUInt64('11640393269246331608')
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:errors:errorIssueVersionsSinceQuery:default  [77012b3a]
SELECT
          ServiceVersion AS serviceVersion,
          count() AS count
        FROM error_events
        WHERE OrgId = 'org_sql_catalog'
          AND FingerprintHash = toUInt64('11640393269246331608')
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY serviceVersion
        ORDER BY count DESC
        LIMIT 100
        FORMAT JSON

-- builder:errors:errorsSparkQuery:default  [89ec2bb4]
SELECT
          toString(FingerprintHash) AS fingerprintHash,
          toStartOfInterval(Timestamp, INTERVAL 300 SECOND) AS bucket,
          count() AS count
        FROM error_events
        WHERE OrgId = 'org_sql_catalog'
          AND FingerprintHash IN (toUInt64('11640393269246331608'))
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY fingerprintHash, bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:errors:errorTickBootstrapIssuesQuery:bootstrap-window  [733ef0e1]
SELECT
          toString(FingerprintHash) AS fingerprintHash,
          any(ServiceName) AS serviceName,
          any(ExceptionType) AS exceptionType,
          any(ExceptionMessage) AS exceptionMessage,
          any(ErrorLabel) AS errorLabel,
          any(TopFrame) AS topFrame,
          groupUniqArray(ServiceVersion) AS serviceVersions,
          count() AS count,
          min(Timestamp) AS firstSeen,
          max(Timestamp) AS lastSeen
        FROM error_events_by_time
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp < '2026-01-03 14:15:00'
        GROUP BY fingerprintHash
        FORMAT JSON

-- builder:errors:errorTickIssuesQuery:cursor-window  [7641e14b]
SELECT
          toString(FingerprintHash) AS fingerprintHash,
          any(ServiceName) AS serviceName,
          any(ExceptionType) AS exceptionType,
          any(ExceptionMessage) AS exceptionMessage,
          any(ErrorLabel) AS errorLabel,
          any(TopFrame) AS topFrame,
          groupUniqArrayArray(ServiceVersions) AS serviceVersions,
          sum(OccurrenceCount) AS count,
          min(FirstSeen) AS firstSeen,
          max(LastSeen) AS lastSeen
        FROM error_fingerprints_minutely
        WHERE OrgId = 'org_sql_catalog'
          AND Minute >= '2026-01-01 10:30:00'
          AND Minute < '2026-01-03 14:15:00'
        GROUP BY fingerprintHash
        FORMAT JSON

-- builder:errors:spanDetailQuery:default  [64ddf7c1]
SELECT
          TraceId AS traceId,
          SpanId AS spanId,
          ParentSpanId AS parentSpanId,
          if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) AS spanName,
          ServiceName AS serviceName,
          SpanKind AS spanKind,
          Duration / 1000000 AS durationMs,
          Timestamp AS startTime,
          StatusCode AS statusCode,
          StatusMessage AS statusMessage,
          toJSONString(SpanAttributes) AS spanAttributes,
          toJSONString(ResourceAttributes) AS resourceAttributes
        FROM trace_detail_spans
        WHERE TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND SpanId = 'b7ad6b7169203331'
          AND OrgId = 'org_sql_catalog'
        LIMIT 1
        FORMAT JSON

-- builder:errors:spanDetailQuery:narrowByTime  [b78705cd]
SELECT
          TraceId AS traceId,
          SpanId AS spanId,
          ParentSpanId AS parentSpanId,
          if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) AS spanName,
          ServiceName AS serviceName,
          SpanKind AS spanKind,
          Duration / 1000000 AS durationMs,
          Timestamp AS startTime,
          StatusCode AS statusCode,
          StatusMessage AS statusMessage,
          toJSONString(SpanAttributes) AS spanAttributes,
          toJSONString(ResourceAttributes) AS resourceAttributes
        FROM trace_detail_spans
        WHERE TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND SpanId = 'b7ad6b7169203331'
          AND OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        LIMIT 1
        FORMAT JSON

-- builder:infra:hostGaugeTimeseriesQuery:default  [7d9ca740]
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 300 SECOND) AS bucket,
          '' AS attributeValue,
          avg(Value) AS avgValue
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['host.name'] = 'ip-10-0-1-42'
          AND MetricName = 'system.cpu.utilization'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:infra:hostGaugeTimeseriesQuery:grouped  [bc031666]
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 300 SECOND) AS bucket,
          Attributes['cpu'] AS attributeValue,
          avg(Value) AS avgValue
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['host.name'] = 'ip-10-0-1-42'
          AND MetricName = 'system.cpu.utilization'
        GROUP BY bucket, attributeValue
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:infra:infraPresenceQuery:default  [886d36c7]
SELECT
          'hosts' AS surface
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND MetricName = 'system.cpu.utilization'
          AND ResourceAttributes['host.name'] != ''
        LIMIT 1
UNION ALL
SELECT
          'containers' AS surface
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND MetricName = 'container.cpu.utilization'
          AND ResourceAttributes['container.name'] != ''
        LIMIT 1
UNION ALL
SELECT
          'k8sPods' AS surface
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND MetricName = 'k8s.pod.cpu.usage'
          AND ResourceAttributes['k8s.pod.name'] != ''
        LIMIT 1
UNION ALL
SELECT
          'k8sNodes' AS surface
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND MetricName = 'k8s.node.cpu.usage'
          AND ResourceAttributes['k8s.node.name'] != ''
        LIMIT 1
UNION ALL
SELECT
          'k8sWorkloads' AS surface
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND MetricName = 'k8s.pod.cpu.usage'
          AND ((ResourceAttributes['k8s.deployment.name'] != '' OR ResourceAttributes['k8s.statefulset.name'] != '') OR ResourceAttributes['k8s.daemonset.name'] != '')
        LIMIT 1
FORMAT JSON

-- builder:infra:nodeFacetsQuery:default  [483ce011]
SELECT
          ResourceAttributes['k8s.node.name'] AS name,
          uniq(ResourceAttributes['k8s.node.name']) AS count,
          'node' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.node.name'] != ''
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('k8s.node.cpu.usage')
          AND ResourceAttributes['k8s.node.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 200
UNION ALL
SELECT
          ResourceAttributes['k8s.cluster.name'] AS name,
          uniq(ResourceAttributes['k8s.node.name']) AS count,
          'cluster' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.node.name'] != ''
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('k8s.node.cpu.usage')
          AND ResourceAttributes['k8s.cluster.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS name,
          uniq(ResourceAttributes['k8s.node.name']) AS count,
          'environment' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.node.name'] != ''
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName IN ('k8s.node.cpu.usage')
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- builder:infra:nodeGaugeTimeseriesQuery:default  [6a0ebdb5]
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 300 SECOND) AS bucket,
          '' AS attributeValue,
          avg(Value) AS avgValue
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.node.name'] = 'ip-10-0-1-42.ec2.internal'
          AND ResourceAttributes['k8s.pod.name'] = ''
          AND MetricName = 'k8s.node.cpu.utilization'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:infra:podFacetsQuery:default  [c7a651d6]
SELECT
          ResourceAttributes['k8s.pod.name'] AS name,
          uniq(ResourceAttributes['k8s.pod.uid']) AS count,
          'pod' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.pod.name'] != ''
          AND MetricName IN ('k8s.pod.cpu.usage')
          AND ResourceAttributes['k8s.pod.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 200
UNION ALL
SELECT
          ResourceAttributes['k8s.namespace.name'] AS name,
          uniq(ResourceAttributes['k8s.pod.uid']) AS count,
          'namespace' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.pod.name'] != ''
          AND MetricName IN ('k8s.pod.cpu.usage')
          AND ResourceAttributes['k8s.namespace.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          ResourceAttributes['k8s.node.name'] AS name,
          uniq(ResourceAttributes['k8s.pod.uid']) AS count,
          'node' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.pod.name'] != ''
          AND MetricName IN ('k8s.pod.cpu.usage')
          AND ResourceAttributes['k8s.node.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          ResourceAttributes['k8s.cluster.name'] AS name,
          uniq(ResourceAttributes['k8s.pod.uid']) AS count,
          'cluster' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.pod.name'] != ''
          AND MetricName IN ('k8s.pod.cpu.usage')
          AND ResourceAttributes['k8s.cluster.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          ResourceAttributes['k8s.deployment.name'] AS name,
          uniq(ResourceAttributes['k8s.pod.uid']) AS count,
          'deployment' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.pod.name'] != ''
          AND MetricName IN ('k8s.pod.cpu.usage')
          AND ResourceAttributes['k8s.deployment.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          ResourceAttributes['k8s.statefulset.name'] AS name,
          uniq(ResourceAttributes['k8s.pod.uid']) AS count,
          'statefulset' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.pod.name'] != ''
          AND MetricName IN ('k8s.pod.cpu.usage')
          AND ResourceAttributes['k8s.statefulset.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          ResourceAttributes['k8s.daemonset.name'] AS name,
          uniq(ResourceAttributes['k8s.pod.uid']) AS count,
          'daemonset' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.pod.name'] != ''
          AND MetricName IN ('k8s.pod.cpu.usage')
          AND ResourceAttributes['k8s.daemonset.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          ResourceAttributes['k8s.job.name'] AS name,
          uniq(ResourceAttributes['k8s.pod.uid']) AS count,
          'job' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.pod.name'] != ''
          AND MetricName IN ('k8s.pod.cpu.usage')
          AND ResourceAttributes['k8s.job.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS name,
          uniq(ResourceAttributes['k8s.pod.uid']) AS count,
          'environment' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.pod.name'] != ''
          AND MetricName IN ('k8s.pod.cpu.usage')
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          ResourceAttributes['eks.amazonaws.com/compute-type'] AS name,
          uniq(ResourceAttributes['k8s.pod.uid']) AS count,
          'computeType' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.pod.name'] != ''
          AND MetricName IN ('k8s.pod.cpu.usage')
          AND ResourceAttributes['eks.amazonaws.com/compute-type'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
FORMAT JSON

-- builder:infra:podGaugeTimeseriesQuery:default  [6a0ebdb5]
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 300 SECOND) AS bucket,
          '' AS attributeValue,
          avg(Value) AS avgValue
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.pod.name'] = 'api-7d9f8b6c5-x2n4k'
          AND ResourceAttributes['k8s.namespace.name'] = 'backend'
          AND MetricName = 'k8s.pod.cpu.utilization'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:infra:workloadFacetsQuery:default  [b424bb44]
SELECT
          ResourceAttributes['k8s.deployment.name'] AS name,
          uniq(ResourceAttributes['k8s.deployment.name']) AS count,
          'workload' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.deployment.name'] != ''
          AND MetricName IN ('k8s.pod.cpu.usage')
          AND ResourceAttributes['k8s.deployment.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 200
UNION ALL
SELECT
          ResourceAttributes['k8s.namespace.name'] AS name,
          uniq(ResourceAttributes['k8s.deployment.name']) AS count,
          'namespace' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.deployment.name'] != ''
          AND MetricName IN ('k8s.pod.cpu.usage')
          AND ResourceAttributes['k8s.namespace.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          ResourceAttributes['k8s.cluster.name'] AS name,
          uniq(ResourceAttributes['k8s.deployment.name']) AS count,
          'cluster' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.deployment.name'] != ''
          AND MetricName IN ('k8s.pod.cpu.usage')
          AND ResourceAttributes['k8s.cluster.name'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS name,
          uniq(ResourceAttributes['k8s.deployment.name']) AS count,
          'environment' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.deployment.name'] != ''
          AND MetricName IN ('k8s.pod.cpu.usage')
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          ResourceAttributes['eks.amazonaws.com/compute-type'] AS name,
          uniq(ResourceAttributes['k8s.deployment.name']) AS count,
          'computeType' AS facetType
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.deployment.name'] != ''
          AND MetricName IN ('k8s.pod.cpu.usage')
          AND ResourceAttributes['eks.amazonaws.com/compute-type'] != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
FORMAT JSON

-- builder:infra:workloadGaugeTimeseriesQuery:default  [6a0ebdb5]
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 300 SECOND) AS bucket,
          '' AS attributeValue,
          avg(Value) AS avgValue
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.deployment.name'] = 'api'
          AND ResourceAttributes['k8s.namespace.name'] = 'backend'
          AND MetricName = 'k8s.pod.cpu.utilization'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:infra:workloadGaugeTimeseriesQuery:groupedByPod  [ceff2e1f]
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 300 SECOND) AS bucket,
          ResourceAttributes['k8s.pod.name'] AS attributeValue,
          avg(Value) AS avgValue
        FROM metrics_gauge
        WHERE OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ResourceAttributes['k8s.statefulset.name'] = 'clickhouse'
          AND ResourceAttributes['k8s.namespace.name'] = 'data'
          AND MetricName = 'k8s.pod.memory.usage'
        GROUP BY bucket, attributeValue
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:product-events:productEventNamesQuery:default  [7c7336c7]
SELECT
          EventName AS eventName,
          Kind AS kind,
          count() AS count,
          uniqIf(SessionId, SessionId != '') AS sessions,
          uniq(if(UserId != '', UserId, VisitorId)) AS persons
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY eventName, kind
        ORDER BY count DESC, eventName ASC
        LIMIT 100
        FORMAT JSON

-- builder:product-events:productEventNamesQuery:filtered  [a47865a2]
SELECT
          EventName AS eventName,
          Kind AS kind,
          count() AS count,
          uniqIf(SessionId, SessionId != '') AS sessions,
          uniq(if(UserId != '', UserId, VisitorId)) AS persons
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Host = 'maple.dev'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND PagePath = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY sessionId)
        GROUP BY eventName, kind
        ORDER BY count DESC, eventName ASC
        LIMIT 100
        FORMAT JSON

-- builder:product-events:productEventsFunnelBreakdownQuery:attribute-session-step  [ac39fa69]
SELECT
          group AS group,
          arrayJoin([1, 2, 3, 4]) AS step,
          arrayElement(counts, step) AS count
        FROM (SELECT
          group AS group,
          [countIf(level >= 1), countIf(level >= 2), countIf(level >= 3), countIf(level >= 4)] AS counts,
          countIf(level >= 1) AS entered
        FROM (SELECT
          key AS key,
          windowFunnel(604800000)(ts, s1 = 1, s2 = 1, s3 = 1, s4 = 1) AS level,
          argMinIf(dim, ts, dim != '') AS group
        FROM (
SELECT
          UserId AS key,
          toUInt64(toUnixTimestamp64Milli(StartTime)) AS ts,
          1 AS s1,
          0 AS s2,
          0 AS s3,
          0 AS s4,
          '' AS dim
        FROM session_replays AS s
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND ReferrerHost = 'news.ycombinator.com'
          AND UserId != ''
UNION ALL
SELECT
          UserId AS key,
          toUInt64(toUnixTimestamp64Milli(Timestamp)) AS ts,
          0 AS s1,
          toUInt8(((Kind = 'navigation' AND PagePath = '/pricing') AND Host = 'maple.dev')) AS s2,
          toUInt8(EventName = 'signup_completed') AS s3,
          toUInt8((EventName = 'plan_started' AND Attributes['plan'] = 'startup')) AS s4,
          Attributes['plan'] AS dim
        FROM product_events AS e
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ((((Kind = 'navigation' AND PagePath = '/pricing') AND Host = 'maple.dev') OR EventName = 'signup_completed') OR (EventName = 'plan_started' AND Attributes['plan'] = 'startup'))
          AND UserId != ''
) AS funnel_events
        GROUP BY key) AS levels
        GROUP BY group
        ORDER BY entered DESC, group ASC
        LIMIT 5) AS groups
        ORDER BY group ASC, step ASC
        FORMAT JSON

-- builder:product-events:productEventsFunnelBreakdownQuery:session-dimension  [f52bc5e1]
SELECT
          group AS group,
          arrayJoin([1, 2, 3]) AS step,
          arrayElement(counts, step) AS count
        FROM (SELECT
          group AS group,
          [countIf(level >= 1), countIf(level >= 2), countIf(level >= 3)] AS counts,
          countIf(level >= 1) AS entered
        FROM (SELECT
          key AS key,
          windowFunnel(604800000)(ts, s1 = 1, s2 = 1, s3 = 1) AS level,
          argMinIf(dim, ts, dim != '') AS group
        FROM (SELECT
          multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) AS key,
          toUInt64(toUnixTimestamp64Milli(e.Timestamp)) AS ts,
          toUInt8(((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev')) AS s1,
          toUInt8(e.EventName = 'signup_completed') AS s2,
          toUInt8((e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup')) AS s3,
          coalesce(sd.Value, '') AS dim
        FROM product_events AS e
        LEFT JOIN (SELECT
          VisitorId AS VisitorId,
          argMin(UserId, FirstSeen) AS UserId
        FROM (SELECT
          VisitorId AS VisitorId,
          UserId AS UserId,
          min(FirstSeen) AS FirstSeen
        FROM identity_links
        WHERE OrgId = 'org_sql_catalog'
        GROUP BY VisitorId, UserId) AS pair_links
        GROUP BY VisitorId) AS link ON e.VisitorId = link.VisitorId
        LEFT JOIN (SELECT
          SessionId AS SessionId,
          max(UtmSource) AS Value
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
        GROUP BY SessionId) AS sd ON e.SessionId = sd.SessionId
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND ((((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev') OR e.EventName = 'signup_completed') OR (e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup'))
          AND multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) != '') AS funnel_events
        GROUP BY key) AS levels
        GROUP BY group
        ORDER BY entered DESC, group ASC
        LIMIT 10) AS groups
        ORDER BY group ASC, step ASC
        FORMAT JSON

-- builder:product-events:productEventsFunnelQuery:person  [41bb75cc]
SELECT
          arrayJoin([1, 2, 3]) AS step,
          arrayElement(counts, step) AS count
        FROM (SELECT
          [countIf(level >= 1), countIf(level >= 2), countIf(level >= 3)] AS counts
        FROM (SELECT
          key AS key,
          windowFunnel(604800000)(ts, s1 = 1, s2 = 1, s3 = 1) AS level
        FROM (SELECT
          multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) AS key,
          toUInt64(toUnixTimestamp64Milli(e.Timestamp)) AS ts,
          toUInt8(((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev')) AS s1,
          toUInt8(e.EventName = 'signup_completed') AS s2,
          toUInt8((e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup')) AS s3
        FROM product_events AS e
        LEFT JOIN (SELECT
          VisitorId AS VisitorId,
          argMin(UserId, FirstSeen) AS UserId
        FROM (SELECT
          VisitorId AS VisitorId,
          UserId AS UserId,
          min(FirstSeen) AS FirstSeen
        FROM identity_links
        WHERE OrgId = 'org_sql_catalog'
        GROUP BY VisitorId, UserId) AS pair_links
        GROUP BY VisitorId) AS link ON e.VisitorId = link.VisitorId
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND ((((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev') OR e.EventName = 'signup_completed') OR (e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup'))
          AND multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) != '') AS funnel_events
        GROUP BY key) AS levels) AS totals
        ORDER BY step ASC
        FORMAT JSON

-- builder:product-events:productEventsFunnelQuery:session-key  [619f95db]
SELECT
          arrayJoin([1, 2, 3]) AS step,
          arrayElement(counts, step) AS count
        FROM (SELECT
          [countIf(level >= 1), countIf(level >= 2), countIf(level >= 3)] AS counts
        FROM (SELECT
          key AS key,
          windowFunnel(1800000)(ts, s1 = 1, s2 = 1, s3 = 1) AS level
        FROM (SELECT
          SessionId AS key,
          toUInt64(toUnixTimestamp64Milli(Timestamp)) AS ts,
          toUInt8(((Kind = 'navigation' AND PagePath = '/pricing') AND Host = 'maple.dev')) AS s1,
          toUInt8(EventName = 'signup_completed') AS s2,
          toUInt8((EventName = 'plan_started' AND Attributes['plan'] = 'startup')) AS s3
        FROM product_events AS e
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ((((Kind = 'navigation' AND PagePath = '/pricing') AND Host = 'maple.dev') OR EventName = 'signup_completed') OR (EventName = 'plan_started' AND Attributes['plan'] = 'startup'))
          AND SessionId != '') AS funnel_events
        GROUP BY key) AS levels) AS totals
        ORDER BY step ASC
        FORMAT JSON

-- builder:product-events:productEventsFunnelQuery:session-step-filtered  [98d45a39]
SELECT
          arrayJoin([1, 2, 3, 4]) AS step,
          arrayElement(counts, step) AS count
        FROM (SELECT
          [countIf(level >= 1), countIf(level >= 2), countIf(level >= 3), countIf(level >= 4)] AS counts
        FROM (SELECT
          key AS key,
          windowFunnel(604800000)(ts, s1 = 1, s2 = 1, s3 = 1, s4 = 1) AS level
        FROM (
SELECT
          multiIf(s.UserId != '', s.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), s.VisitorId) AS key,
          toUInt64(toUnixTimestamp64Milli(s.StartTime)) AS ts,
          1 AS s1,
          0 AS s2,
          0 AS s3,
          0 AS s4
        FROM session_replays AS s
        LEFT JOIN (SELECT
          VisitorId AS VisitorId,
          argMin(UserId, FirstSeen) AS UserId
        FROM (SELECT
          VisitorId AS VisitorId,
          UserId AS UserId,
          min(FirstSeen) AS FirstSeen
        FROM identity_links
        WHERE OrgId = 'org_sql_catalog'
        GROUP BY VisitorId, UserId) AS pair_links
        GROUP BY VisitorId) AS link ON s.VisitorId = link.VisitorId
        WHERE s.OrgId = 'org_sql_catalog'
          AND s.StartTime >= '2026-01-01 10:30:00'
          AND s.StartTime <= '2026-01-03 14:15:00'
          AND s.ReferrerHost = 'news.ycombinator.com'
          AND multiIf(s.UserId != '', s.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), s.VisitorId) != ''
          AND multiIf(s.UserId != '', s.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), s.VisitorId) IN (SELECT
          multiIf(s.UserId != '', s.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), s.VisitorId) AS key
        FROM session_replays AS s
        LEFT JOIN (SELECT
          VisitorId AS VisitorId,
          argMin(UserId, FirstSeen) AS UserId
        FROM (SELECT
          VisitorId AS VisitorId,
          UserId AS UserId,
          min(FirstSeen) AS FirstSeen
        FROM identity_links
        WHERE OrgId = 'org_sql_catalog'
        GROUP BY VisitorId, UserId) AS pair_links
        GROUP BY VisitorId) AS link ON s.VisitorId = link.VisitorId
        WHERE s.OrgId = 'org_sql_catalog'
          AND s.StartTime >= '2026-01-01 10:30:00'
          AND s.StartTime <= '2026-01-03 14:15:00'
          AND s.SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
          AND PagePath = '/pricing'
        GROUP BY sessionId)
          AND s.ReferrerHost = 't.co'
          AND s.Country = 'DE'
          AND s.DeviceType = 'desktop'
          AND s.BrowserName = 'Chrome'
          AND s.OsName = 'macOS'
          AND s.Language = 'en-US'
          AND s.UtmSource = 'twitter'
          AND s.UtmMedium = 'social'
          AND s.UtmCampaign = 'launch'
          AND s.VisitorIsNew = 1
          AND s.SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY key)
UNION ALL
SELECT
          multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) AS key,
          toUInt64(toUnixTimestamp64Milli(e.Timestamp)) AS ts,
          0 AS s1,
          toUInt8(((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev')) AS s2,
          toUInt8(e.EventName = 'signup_completed') AS s3,
          toUInt8((e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup')) AS s4
        FROM product_events AS e
        LEFT JOIN (SELECT
          VisitorId AS VisitorId,
          argMin(UserId, FirstSeen) AS UserId
        FROM (SELECT
          VisitorId AS VisitorId,
          UserId AS UserId,
          min(FirstSeen) AS FirstSeen
        FROM identity_links
        WHERE OrgId = 'org_sql_catalog'
        GROUP BY VisitorId, UserId) AS pair_links
        GROUP BY VisitorId) AS link ON e.VisitorId = link.VisitorId
        WHERE e.OrgId = 'org_sql_catalog'
          AND e.Timestamp >= '2026-01-01 10:30:00'
          AND e.Timestamp <= '2026-01-03 14:15:00'
          AND ((((e.Kind = 'navigation' AND e.PagePath = '/pricing') AND e.Host = 'maple.dev') OR e.EventName = 'signup_completed') OR (e.EventName = 'plan_started' AND e.Attributes['plan'] = 'startup'))
          AND multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) != ''
          AND multiIf(e.UserId != '', e.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), e.VisitorId) IN (SELECT
          multiIf(s.UserId != '', s.UserId, coalesce(link.UserId, '') != '', coalesce(link.UserId, ''), s.VisitorId) AS key
        FROM session_replays AS s
        LEFT JOIN (SELECT
          VisitorId AS VisitorId,
          argMin(UserId, FirstSeen) AS UserId
        FROM (SELECT
          VisitorId AS VisitorId,
          UserId AS UserId,
          min(FirstSeen) AS FirstSeen
        FROM identity_links
        WHERE OrgId = 'org_sql_catalog'
        GROUP BY VisitorId, UserId) AS pair_links
        GROUP BY VisitorId) AS link ON s.VisitorId = link.VisitorId
        WHERE s.OrgId = 'org_sql_catalog'
          AND s.StartTime >= '2026-01-01 10:30:00'
          AND s.StartTime <= '2026-01-03 14:15:00'
          AND s.SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
          AND PagePath = '/pricing'
        GROUP BY sessionId)
          AND s.ReferrerHost = 't.co'
          AND s.Country = 'DE'
          AND s.DeviceType = 'desktop'
          AND s.BrowserName = 'Chrome'
          AND s.OsName = 'macOS'
          AND s.Language = 'en-US'
          AND s.UtmSource = 'twitter'
          AND s.UtmMedium = 'social'
          AND s.UtmCampaign = 'launch'
          AND s.VisitorIsNew = 1
          AND s.SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY key)
) AS funnel_events
        GROUP BY key) AS levels) AS totals
        ORDER BY step ASC
        FORMAT JSON

-- builder:product-events:productEventsFunnelQuery:visitor-session-step  [1eb9e5d6]
SELECT
          arrayJoin([1, 2, 3, 4]) AS step,
          arrayElement(counts, step) AS count
        FROM (SELECT
          [countIf(level >= 1), countIf(level >= 2), countIf(level >= 3), countIf(level >= 4)] AS counts
        FROM (SELECT
          key AS key,
          windowFunnel(3600000)(ts, s1 = 1, s2 = 1, s3 = 1, s4 = 1) AS level
        FROM (
SELECT
          VisitorId AS key,
          toUInt64(toUnixTimestamp64Milli(StartTime)) AS ts,
          1 AS s1,
          0 AS s2,
          0 AS s3,
          0 AS s4
        FROM session_replays AS s
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND ReferrerHost = 'news.ycombinator.com'
          AND VisitorId != ''
UNION ALL
SELECT
          VisitorId AS key,
          toUInt64(toUnixTimestamp64Milli(Timestamp)) AS ts,
          0 AS s1,
          toUInt8(((Kind = 'navigation' AND PagePath = '/pricing') AND Host = 'maple.dev')) AS s2,
          toUInt8(EventName = 'signup_completed') AS s3,
          toUInt8((EventName = 'plan_started' AND Attributes['plan'] = 'startup')) AS s4
        FROM product_events AS e
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ((((Kind = 'navigation' AND PagePath = '/pricing') AND Host = 'maple.dev') OR EventName = 'signup_completed') OR (EventName = 'plan_started' AND Attributes['plan'] = 'startup'))
          AND VisitorId != ''
) AS funnel_events
        GROUP BY key) AS levels) AS totals
        ORDER BY step ASC
        FORMAT JSON

-- builder:service-endpoints:serviceEndpointsSummaryQuery:default  [3e379104]
SELECT
          bSpanName AS spanName,
          sum(bSpanCount) AS spanCount,
          sum(bEstimatedSpanCount) AS estimatedSpanCount,
          sum(bErrorCount) AS errorCount,
          sum(bEstimatedErrorCount) AS estimatedErrorCount,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedErrorCount) / sum(bEstimatedSpanCount), 0) AS errorRate,
          if(sum(bSpanCount) > 0, sum(bDurationSum) / sum(bSpanCount) / 1000000, 0) AS avgDurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000, 0) AS p50DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000, 0) AS p99DurationMs
        FROM (
SELECT
          if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) AS bSpanName,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
          AND match(if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName), '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ')
        GROUP BY bSpanName
UNION ALL
SELECT
          SpanName AS bSpanName,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_minutely
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
          AND (Minute < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Minute >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND match(SpanName, '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ')
        GROUP BY bSpanName
UNION ALL
SELECT
          SpanName AS bSpanName,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND match(SpanName, '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ')
        GROUP BY bSpanName
) AS operation_windows
        GROUP BY spanName
        ORDER BY estimatedSpanCount DESC
        LIMIT 50
        FORMAT JSON

-- builder:service-endpoints:serviceEndpointsSummaryQuery:envFiltered  [55532472]
SELECT
          bSpanName AS spanName,
          sum(bSpanCount) AS spanCount,
          sum(bEstimatedSpanCount) AS estimatedSpanCount,
          sum(bErrorCount) AS errorCount,
          sum(bEstimatedErrorCount) AS estimatedErrorCount,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedErrorCount) / sum(bEstimatedSpanCount), 0) AS errorRate,
          if(sum(bSpanCount) > 0, sum(bDurationSum) / sum(bSpanCount) / 1000000, 0) AS avgDurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000, 0) AS p50DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000, 0) AS p99DurationMs
        FROM (
SELECT
          if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) AS bSpanName,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
          AND match(if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName), '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ')
        GROUP BY bSpanName
UNION ALL
SELECT
          SpanName AS bSpanName,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_minutely
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND DeploymentEnv IN ('production')
          AND Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
          AND (Minute < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Minute >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND match(SpanName, '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ')
        GROUP BY bSpanName
UNION ALL
SELECT
          SpanName AS bSpanName,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND DeploymentEnv IN ('production')
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND match(SpanName, '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ')
        GROUP BY bSpanName
) AS operation_windows
        GROUP BY spanName
        ORDER BY estimatedSpanCount DESC
        LIMIT 50
        FORMAT JSON

-- builder:service-map-rollup:serviceMapEdgesExistingHoursSQL:default  [6a2a284a]
SELECT
          toUnixTimestamp(Hour) AS hourTs
        FROM service_map_edges_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour < '2026-01-03 14:15:00'
        GROUP BY hourTs
        FORMAT JSON

-- builder:service-map-rollup:serviceMapEdgesRollupSQL:default  [739f1f00]
SELECT
          p.OrgId AS OrgId,
          toStartOfHour(p.Timestamp) AS Hour,
          p.ServiceName AS SourceService,
          c.ServiceName AS TargetService,
          p.DeploymentEnv AS DeploymentEnv,
          count() AS CallCount,
          countIf(c.StatusCode = 'Error') AS ErrorCount,
          sum(c.Duration / 1000000) AS DurationSumMs,
          max(c.Duration / 1000000) AS MaxDurationMs,
          countIf(match(c.TraceState, 'th:[0-9a-f]+')) AS SampledSpanCount,
          countIf(NOT (match(c.TraceState, 'th:[0-9a-f]+'))) AS UnsampledSpanCount,
          sum(multiIf(match(c.TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0)) AS SampleRateSum
        FROM (SELECT
          OrgId AS OrgId,
          Timestamp AS Timestamp,
          TraceId AS TraceId,
          SpanId AS SpanId,
          ServiceName AS ServiceName,
          DeploymentEnv AS DeploymentEnv
        FROM service_map_spans
        WHERE SpanKind IN ('Client', 'Producer')
          AND Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp < toDateTime('2026-01-03 14:15:00')
          AND OrgId = 'org_sql_catalog') AS p
        INNER JOIN (SELECT
          TraceId AS TraceId,
          ParentSpanId AS ParentSpanId,
          ServiceName AS ServiceName,
          Duration AS Duration,
          StatusCode AS StatusCode,
          TraceState AS TraceState
        FROM service_map_children
        WHERE Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp < toDateTime('2026-01-03 14:15:00')
          AND OrgId = 'org_sql_catalog') AS c ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)
        WHERE p.ServiceName != c.ServiceName
        GROUP BY OrgId, Hour, SourceService, TargetService, DeploymentEnv
        FORMAT JSON

-- builder:service-map-rollup:serviceMapResolutionsExistingHoursSQL:default  [ea1bee51]
SELECT
          toUnixTimestamp(Hour) AS hourTs
        FROM service_address_resolutions_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour < '2026-01-03 14:15:00'
        GROUP BY hourTs
        FORMAT JSON

-- builder:service-map:serviceDbEdgesForServiceQuery:default  [7adb3fed]
SELECT
          sourceService AS sourceService,
          dbSystem AS dbSystem,
          dbNamespace AS dbNamespace,
          sum(bucketCallCount) AS callCount,
          sum(bucketErrorCount) AS errorCount,
          sum(bucketDurationSumMs) / nullIf(sum(bucketCallCount), 0) AS avgDurationMs,
          max(bucketMaxDurationMs) AS maxDurationMs,
          if(sum(bucketCallCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bucketDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          sum(bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          ServiceName AS sourceService,
          DbSystem AS dbSystem,
          if(match(DbNamespace, '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', DbNamespace) AS dbNamespace,
          sum(CallCount) AS bucketCallCount,
          sum(ErrorCount) AS bucketErrorCount,
          sum(DurationSumMs) AS bucketDurationSumMs,
          max(MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(SampleRateSum > 0, SampleRateSum, toFloat64(CallCount))) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bucketDurationQuantiles
        FROM service_map_db_edges_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'web'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND DbSystem != ''
        GROUP BY sourceService, dbSystem, dbNamespace
UNION ALL
SELECT
          ServiceName AS sourceService,
          coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) AS dbSystem,
          if(match(coalesce(nullIf(SpanAttributes['db.namespace'], ''), nullIf(SpanAttributes['db.name'], ''), nullIf(SpanAttributes['server.address'], ''), SpanAttributes['net.peer.name']), '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', coalesce(nullIf(SpanAttributes['db.namespace'], ''), nullIf(SpanAttributes['db.name'], ''), nullIf(SpanAttributes['server.address'], ''), SpanAttributes['net.peer.name'])) AS dbNamespace,
          count() AS bucketCallCount,
          countIf(StatusCode = 'Error') AS bucketErrorCount,
          sum(Duration / 1000000) AS bucketDurationSumMs,
          max(Duration / 1000000) AS bucketMaxDurationMs,
          sum(SampleRate) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bucketDurationQuantiles
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'web'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND SpanKind IN ('Client', 'Producer')
          AND coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) != ''
        GROUP BY sourceService, dbSystem, dbNamespace
) AS edges
        GROUP BY sourceService, dbSystem, dbNamespace
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceDbEdgesSQL:default  [e06f1809]
SELECT
          sourceService AS sourceService,
          dbSystem AS dbSystem,
          dbNamespace AS dbNamespace,
          sum(bucketCallCount) AS callCount,
          sum(bucketErrorCount) AS errorCount,
          sum(bucketDurationSumMs) / nullIf(sum(bucketCallCount), 0) AS avgDurationMs,
          max(bucketMaxDurationMs) AS maxDurationMs,
          if(sum(bucketCallCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bucketDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          sum(bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          ServiceName AS sourceService,
          DbSystem AS dbSystem,
          if(match(DbNamespace, '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', DbNamespace) AS dbNamespace,
          sum(CallCount) AS bucketCallCount,
          sum(ErrorCount) AS bucketErrorCount,
          sum(DurationSumMs) AS bucketDurationSumMs,
          max(MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(SampleRateSum > 0, SampleRateSum, toFloat64(CallCount))) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bucketDurationQuantiles
        FROM service_map_db_edges_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND DbSystem != ''
        GROUP BY sourceService, dbSystem, dbNamespace
UNION ALL
SELECT
          ServiceName AS sourceService,
          coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) AS dbSystem,
          if(match(coalesce(nullIf(SpanAttributes['db.namespace'], ''), nullIf(SpanAttributes['db.name'], ''), nullIf(SpanAttributes['server.address'], ''), SpanAttributes['net.peer.name']), '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', coalesce(nullIf(SpanAttributes['db.namespace'], ''), nullIf(SpanAttributes['db.name'], ''), nullIf(SpanAttributes['server.address'], ''), SpanAttributes['net.peer.name'])) AS dbNamespace,
          count() AS bucketCallCount,
          countIf(StatusCode = 'Error') AS bucketErrorCount,
          sum(Duration / 1000000) AS bucketDurationSumMs,
          max(Duration / 1000000) AS bucketMaxDurationMs,
          sum(SampleRate) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bucketDurationQuantiles
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName != ''
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND SpanKind IN ('Client', 'Producer')
          AND coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) != ''
        GROUP BY sourceService, dbSystem, dbNamespace
) AS edges
        GROUP BY sourceService, dbSystem, dbNamespace
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceDbEdgesSQL:env-scoped  [64270f13]
SELECT
          sourceService AS sourceService,
          dbSystem AS dbSystem,
          dbNamespace AS dbNamespace,
          sum(bucketCallCount) AS callCount,
          sum(bucketErrorCount) AS errorCount,
          sum(bucketDurationSumMs) / nullIf(sum(bucketCallCount), 0) AS avgDurationMs,
          max(bucketMaxDurationMs) AS maxDurationMs,
          if(sum(bucketCallCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bucketDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          sum(bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          ServiceName AS sourceService,
          DbSystem AS dbSystem,
          if(match(DbNamespace, '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', DbNamespace) AS dbNamespace,
          sum(CallCount) AS bucketCallCount,
          sum(ErrorCount) AS bucketErrorCount,
          sum(DurationSumMs) AS bucketDurationSumMs,
          max(MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(SampleRateSum > 0, SampleRateSum, toFloat64(CallCount))) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bucketDurationQuantiles
        FROM service_map_db_edges_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND DbSystem != ''
          AND DeploymentEnv = 'production'
        GROUP BY sourceService, dbSystem, dbNamespace
UNION ALL
SELECT
          ServiceName AS sourceService,
          coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) AS dbSystem,
          if(match(coalesce(nullIf(SpanAttributes['db.namespace'], ''), nullIf(SpanAttributes['db.name'], ''), nullIf(SpanAttributes['server.address'], ''), SpanAttributes['net.peer.name']), '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', coalesce(nullIf(SpanAttributes['db.namespace'], ''), nullIf(SpanAttributes['db.name'], ''), nullIf(SpanAttributes['server.address'], ''), SpanAttributes['net.peer.name'])) AS dbNamespace,
          count() AS bucketCallCount,
          countIf(StatusCode = 'Error') AS bucketErrorCount,
          sum(Duration / 1000000) AS bucketDurationSumMs,
          max(Duration / 1000000) AS bucketMaxDurationMs,
          sum(SampleRate) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bucketDurationQuantiles
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName != ''
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND SpanKind IN ('Client', 'Producer')
          AND coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) != ''
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) = 'production'
        GROUP BY sourceService, dbSystem, dbNamespace
) AS edges
        GROUP BY sourceService, dbSystem, dbNamespace
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceDbQuerySummarySQL:default  [75954ced]
SELECT
          sum(bCount) AS queryCount,
          sum(bEst) AS estimatedQueryCount,
          sum(bErr) AS errorCount,
          sum(bEstErr) AS estimatedErrorCount,
          if(sum(bEst) > 0, sum(bEstErr) / sum(bEst), 0) AS errorRate,
          if(sum(bEst) > 0, sum(bWDur) / sum(bEst), 0) AS avgDurationMs,
          if(sum(bCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bQ), 1) / 1000000, 0) AS p50DurationMs,
          if(sum(bCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bQ), 2) / 1000000, 0) AS p95DurationMs,
          uniqMerge(bSvc) AS activeServiceCount
        FROM (
SELECT
          sum(CallCount) AS bCount,
          sum(EstimatedCount) AS bEst,
          sum(ErrorCount) AS bErr,
          sum(EstimatedErrorCount) AS bEstErr,
          sum(WeightedDurationSumMs) AS bWDur,
          uniqState(toString(ServiceName)) AS bSvc,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bQ
        FROM service_map_db_query_shapes_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND DbSystem = 'postgresql'
UNION ALL
SELECT
          count() AS bCount,
          sum(SampleRate) AS bEst,
          countIf(StatusCode = 'Error') AS bErr,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstErr,
          sum(toFloat64(Duration) * SampleRate / 1000000) AS bWDur,
          uniqState(toString(ServiceName)) AS bSvc,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bQ
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp <= toDateTime('2026-01-03 14:15:00')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND SpanKind IN ('Client', 'Producer')
          AND ServiceName != ''
          AND coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) = 'postgresql'
) AS branches
        FORMAT JSON

-- builder:service-map:serviceDbQueryTimeseriesSQL:hourly-buckets  [341c6689]
SELECT
          bucket AS bucket,
          sum(bCount) AS queryCount,
          sum(bEst) AS estimatedQueryCount,
          sum(bErr) AS errorCount,
          if(sum(bEst) > 0, sum(bEstErr) / sum(bEst), 0) AS errorRate,
          if(sum(bEst) > 0, sum(bWDur) / sum(bEst), 0) AS avgDurationMs,
          if(sum(bCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bQ), 1) / 1000000, 0) AS p50DurationMs,
          if(sum(bCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bQ), 2) / 1000000, 0) AS p95DurationMs
        FROM (
SELECT
          toStartOfInterval(Hour, INTERVAL 3600 SECOND) AS bucket,
          sum(CallCount) AS bCount,
          sum(EstimatedCount) AS bEst,
          sum(ErrorCount) AS bErr,
          sum(EstimatedErrorCount) AS bEstErr,
          sum(WeightedDurationSumMs) AS bWDur,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bQ
        FROM service_map_db_query_shapes_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND DbSystem = 'postgresql'
        GROUP BY bucket
UNION ALL
SELECT
          toStartOfInterval(toDateTime(Timestamp), INTERVAL 3600 SECOND) AS bucket,
          count() AS bCount,
          sum(SampleRate) AS bEst,
          countIf(StatusCode = 'Error') AS bErr,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstErr,
          sum(toFloat64(Duration) * SampleRate / 1000000) AS bWDur,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bQ
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp <= toDateTime('2026-01-03 14:15:00')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND SpanKind IN ('Client', 'Producer')
          AND ServiceName != ''
          AND coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) = 'postgresql'
        GROUP BY bucket
) AS buckets
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT 2000
        FORMAT JSON

-- builder:service-map:serviceDbQueryTimeseriesSQL:sub-hour-buckets  [e1315d1d]
SELECT
          toStartOfInterval(toDateTime(Timestamp), INTERVAL 300 SECOND) AS bucket,
          count() AS queryCount,
          sum(SampleRate) AS estimatedQueryCount,
          countIf(StatusCode = 'Error') AS errorCount,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          if(sum(SampleRate) > 0, sum(toFloat64(Duration) * SampleRate) / sum(SampleRate) / 1000000, 0) AS avgDurationMs,
          if(count() > 0, arrayElement(quantilesTDigestWeighted(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))), 1) / 1000000, 0) AS p50DurationMs,
          if(count() > 0, arrayElement(quantilesTDigestWeighted(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))), 2) / 1000000, 0) AS p95DurationMs
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp <= toDateTime('2026-01-03 14:15:00')
          AND SpanKind IN ('Client', 'Producer')
          AND ServiceName != ''
          AND coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) = 'postgresql'
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT 2000
        FORMAT JSON

-- builder:service-map:serviceDbTopQueriesSQL:default  [d9f3469a]
SELECT
          queryKey AS queryKey,
          if(sampleStatement != '', substring(trimBoth(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(sampleStatement, '\'[^\']*\'', '?'), '(?i)\\bin\\s*\\([^)]*\\)', 'IN (?)'), '[0-9]+(\\.[0-9]+)?', '?'), '\\s+', ' ')), 1, 220), fallbackLabel) AS queryLabel,
          sampleStatement AS sampleStatement,
          sampleService AS sampleService,
          serviceCount AS serviceCount,
          queryCount AS queryCount,
          estimatedQueryCount AS estimatedQueryCount,
          errorCount AS errorCount,
          errorRate AS errorRate,
          avgDurationMs AS avgDurationMs,
          p50DurationMs AS p50DurationMs,
          p95DurationMs AS p95DurationMs,
          lastSeen AS lastSeen
        FROM (SELECT
          queryKey AS queryKey,
          any(bLabel) AS fallbackLabel,
          anyIf(bStatement, bStatement != '') AS sampleStatement,
          any(bSampleService) AS sampleService,
          uniqMerge(bServices) AS serviceCount,
          sum(bCount) AS queryCount,
          sum(bEst) AS estimatedQueryCount,
          sum(bErr) AS errorCount,
          if(sum(bEst) > 0, sum(bEstErr) / sum(bEst), 0) AS errorRate,
          if(sum(bEst) > 0, sum(bWDur) / sum(bEst), 0) AS avgDurationMs,
          if(sum(bCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bQ), 1) / 1000000, 0) AS p50DurationMs,
          if(sum(bCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bQ), 2) / 1000000, 0) AS p95DurationMs,
          max(bLastSeen) AS lastSeen
        FROM (
SELECT
          QueryKey AS queryKey,
          any(QueryLabel) AS bLabel,
          any(SampleStatement) AS bStatement,
          any(toString(ServiceName)) AS bSampleService,
          uniqState(toString(ServiceName)) AS bServices,
          sum(CallCount) AS bCount,
          sum(EstimatedCount) AS bEst,
          sum(ErrorCount) AS bErr,
          sum(EstimatedErrorCount) AS bEstErr,
          sum(WeightedDurationSumMs) AS bWDur,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bQ,
          max(Hour) AS bLastSeen
        FROM service_map_db_query_shapes_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND DbSystem = 'postgresql'
        GROUP BY queryKey
UNION ALL
SELECT
          coalesce(
  nullIf(SpanAttributes['db.query.fingerprint'], ''),
  nullIf(SpanAttributes['db.statement.fingerprint'], ''),
  nullIf(if(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']) != '', toString(cityHash64(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(lower(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement'])), '\'[^\']*\'', '?'), '\\bin\\s*\\([^)]*\\)', 'in (?)'), '[0-9]+(\\.[0-9]+)?', '?'), '\\s+', ' '), '^\\s+|\\s+$', ''))), ''), ''),
  toString(cityHash64(coalesce(
  nullIf(SpanAttributes['db.query.summary'], ''),
  nullIf(if(SpanAttributes['db.operation.name'] != '', trimBoth(concat(SpanAttributes['db.operation.name'], if(coalesce(nullIf(SpanAttributes['db.collection.name'], ''), SpanAttributes['db.namespace']) != '', concat(' ', coalesce(nullIf(SpanAttributes['db.collection.name'], ''), SpanAttributes['db.namespace'])), ''))), ''), ''),
  nullIf(if(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']) != '', trimBoth(concat(upper(extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '^\\s*(\\w+)')), if(extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '(?i)(?:from|into|update|join|table)\\s+\\W?([\\w.]+)') != '', concat(' ', extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '(?i)(?:from|into|update|join|table)\\s+\\W?([\\w.]+)')), ''))), ''), ''),
  nullIf(SpanAttributes['query.context'], ''),
  nullIf(SpanAttributes['db.operation.name'], ''),
  nullIf(SpanAttributes['db.operation'], ''),
  SpanName
)))
) AS queryKey,
          any(substring(coalesce(
  nullIf(SpanAttributes['db.query.summary'], ''),
  nullIf(if(SpanAttributes['db.operation.name'] != '', trimBoth(concat(SpanAttributes['db.operation.name'], if(coalesce(nullIf(SpanAttributes['db.collection.name'], ''), SpanAttributes['db.namespace']) != '', concat(' ', coalesce(nullIf(SpanAttributes['db.collection.name'], ''), SpanAttributes['db.namespace'])), ''))), ''), ''),
  nullIf(if(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']) != '', trimBoth(concat(upper(extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '^\\s*(\\w+)')), if(extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '(?i)(?:from|into|update|join|table)\\s+\\W?([\\w.]+)') != '', concat(' ', extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '(?i)(?:from|into|update|join|table)\\s+\\W?([\\w.]+)')), ''))), ''), ''),
  nullIf(SpanAttributes['query.context'], ''),
  nullIf(SpanAttributes['db.operation.name'], ''),
  nullIf(SpanAttributes['db.operation'], ''),
  SpanName
), 1, 220)) AS bLabel,
          any(substring(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), 1, 1000)) AS bStatement,
          any(toString(ServiceName)) AS bSampleService,
          uniqState(toString(ServiceName)) AS bServices,
          count() AS bCount,
          sum(SampleRate) AS bEst,
          countIf(StatusCode = 'Error') AS bErr,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstErr,
          sum(toFloat64(Duration) * SampleRate / 1000000) AS bWDur,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bQ,
          max(toDateTime(Timestamp)) AS bLastSeen
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp <= toDateTime('2026-01-03 14:15:00')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND SpanKind IN ('Client', 'Producer')
          AND ServiceName != ''
          AND coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) = 'postgresql'
        GROUP BY queryKey
) AS shapes
        GROUP BY queryKey) AS shape
        ORDER BY estimatedQueryCount DESC
        LIMIT 10
        FORMAT JSON

-- builder:service-map:serviceDependenciesForServiceQuery:default  [1a386155]
SELECT
          sourceService AS sourceService,
          targetService AS targetService,
          sum(bucketCallCount) AS callCount,
          sum(bucketErrorCount) AS errorCount,
          sum(bucketDurationSumMs) / nullIf(sum(bucketCallCount), 0) AS avgDurationMs,
          max(bucketMaxDurationMs) AS maxDurationMs,
          sum(bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          SourceService AS sourceService,
          TargetService AS targetService,
          sum(CallCount) AS bucketCallCount,
          sum(ErrorCount) AS bucketErrorCount,
          sum(DurationSumMs) AS bucketDurationSumMs,
          max(MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(SampleRateSum > 0, SampleRateSum, toFloat64(CallCount))) AS bucketEstimatedSpanCount
        FROM service_map_edges_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND SourceService = 'web'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY sourceService, targetService
UNION ALL
SELECT
          p.ServiceName AS sourceService,
          c.ServiceName AS targetService,
          count() AS bucketCallCount,
          countIf(c.StatusCode = 'Error') AS bucketErrorCount,
          sum(c.Duration / 1000000) AS bucketDurationSumMs,
          max(c.Duration / 1000000) AS bucketMaxDurationMs,
          sum(multiIf(match(c.TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0)) AS bucketEstimatedSpanCount
        FROM (SELECT
          OrgId AS OrgId,
          Timestamp AS Timestamp,
          TraceId AS TraceId,
          SpanId AS SpanId,
          ServiceName AS ServiceName,
          DeploymentEnv AS DeploymentEnv
        FROM service_map_spans
        WHERE SpanKind IN ('Client', 'Producer')
          AND Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp < toDateTime('2026-01-03 14:15:00')
          AND OrgId = 'org_sql_catalog'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND ServiceName = 'web') AS p
        INNER JOIN (SELECT
          TraceId AS TraceId,
          ParentSpanId AS ParentSpanId,
          ServiceName AS ServiceName,
          Duration AS Duration,
          StatusCode AS StatusCode,
          TraceState AS TraceState
        FROM service_map_children
        WHERE Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp < toDateTime('2026-01-03 14:15:00')
          AND OrgId = 'org_sql_catalog'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))) AS c ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)
        WHERE p.ServiceName != c.ServiceName
        GROUP BY sourceService, targetService
) AS edges
        GROUP BY sourceService, targetService
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceDependenciesSQL:default  [d0522185]
SELECT
          sourceService AS sourceService,
          targetService AS targetService,
          sum(bucketCallCount) AS callCount,
          sum(bucketErrorCount) AS errorCount,
          sum(bucketDurationSumMs) / nullIf(sum(bucketCallCount), 0) AS avgDurationMs,
          max(bucketMaxDurationMs) AS maxDurationMs,
          sum(bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          SourceService AS sourceService,
          TargetService AS targetService,
          sum(CallCount) AS bucketCallCount,
          sum(ErrorCount) AS bucketErrorCount,
          sum(DurationSumMs) AS bucketDurationSumMs,
          max(MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(SampleRateSum > 0, SampleRateSum, toFloat64(CallCount))) AS bucketEstimatedSpanCount
        FROM service_map_edges_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY sourceService, targetService
UNION ALL
SELECT
          p.ServiceName AS sourceService,
          c.ServiceName AS targetService,
          count() AS bucketCallCount,
          countIf(c.StatusCode = 'Error') AS bucketErrorCount,
          sum(c.Duration / 1000000) AS bucketDurationSumMs,
          max(c.Duration / 1000000) AS bucketMaxDurationMs,
          sum(multiIf(match(c.TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0)) AS bucketEstimatedSpanCount
        FROM (SELECT
          OrgId AS OrgId,
          Timestamp AS Timestamp,
          TraceId AS TraceId,
          SpanId AS SpanId,
          ServiceName AS ServiceName,
          DeploymentEnv AS DeploymentEnv
        FROM service_map_spans
        WHERE SpanKind IN ('Client', 'Producer')
          AND Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp < toDateTime('2026-01-03 14:15:00')
          AND OrgId = 'org_sql_catalog'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))) AS p
        INNER JOIN (SELECT
          TraceId AS TraceId,
          ParentSpanId AS ParentSpanId,
          ServiceName AS ServiceName,
          Duration AS Duration,
          StatusCode AS StatusCode,
          TraceState AS TraceState
        FROM service_map_children
        WHERE Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp < toDateTime('2026-01-03 14:15:00')
          AND OrgId = 'org_sql_catalog'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))) AS c ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)
        WHERE p.ServiceName != c.ServiceName
        GROUP BY sourceService, targetService
) AS edges
        GROUP BY sourceService, targetService
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceDependenciesSQL:env-scoped  [89695720]
SELECT
          sourceService AS sourceService,
          targetService AS targetService,
          sum(bucketCallCount) AS callCount,
          sum(bucketErrorCount) AS errorCount,
          sum(bucketDurationSumMs) / nullIf(sum(bucketCallCount), 0) AS avgDurationMs,
          max(bucketMaxDurationMs) AS maxDurationMs,
          sum(bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          SourceService AS sourceService,
          TargetService AS targetService,
          sum(CallCount) AS bucketCallCount,
          sum(ErrorCount) AS bucketErrorCount,
          sum(DurationSumMs) AS bucketDurationSumMs,
          max(MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(SampleRateSum > 0, SampleRateSum, toFloat64(CallCount))) AS bucketEstimatedSpanCount
        FROM service_map_edges_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND DeploymentEnv = 'production'
        GROUP BY sourceService, targetService
UNION ALL
SELECT
          p.ServiceName AS sourceService,
          c.ServiceName AS targetService,
          count() AS bucketCallCount,
          countIf(c.StatusCode = 'Error') AS bucketErrorCount,
          sum(c.Duration / 1000000) AS bucketDurationSumMs,
          max(c.Duration / 1000000) AS bucketMaxDurationMs,
          sum(multiIf(match(c.TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0)) AS bucketEstimatedSpanCount
        FROM (SELECT
          OrgId AS OrgId,
          Timestamp AS Timestamp,
          TraceId AS TraceId,
          SpanId AS SpanId,
          ServiceName AS ServiceName,
          DeploymentEnv AS DeploymentEnv
        FROM service_map_spans
        WHERE SpanKind IN ('Client', 'Producer')
          AND Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp < toDateTime('2026-01-03 14:15:00')
          AND OrgId = 'org_sql_catalog'
          AND DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))) AS p
        INNER JOIN (SELECT
          TraceId AS TraceId,
          ParentSpanId AS ParentSpanId,
          ServiceName AS ServiceName,
          Duration AS Duration,
          StatusCode AS StatusCode,
          TraceState AS TraceState
        FROM service_map_children
        WHERE Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp < toDateTime('2026-01-03 14:15:00')
          AND OrgId = 'org_sql_catalog'
          AND DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))) AS c ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)
        WHERE p.ServiceName != c.ServiceName
        GROUP BY sourceService, targetService
) AS edges
        GROUP BY sourceService, targetService
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceExternalEdgesSQL:default  [1709b03d]
SELECT
          sourceService AS sourceService,
          targetType AS targetType,
          targetSystem AS targetSystem,
          targetName AS targetName,
          sum(bucketCallCount) AS callCount,
          sum(bucketErrorCount) AS errorCount,
          sum(bucketDurationSumMs) / nullIf(sum(bucketCallCount), 0) AS avgDurationMs,
          max(bucketMaxDurationMs) AS maxDurationMs,
          if(sum(bucketCallCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bucketDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          sum(bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          ServiceName AS sourceService,
          TargetType AS targetType,
          TargetSystem AS targetSystem,
          TargetName AS targetName,
          sum(CallCount) AS bucketCallCount,
          sum(ErrorCount) AS bucketErrorCount,
          sum(DurationSumMs) AS bucketDurationSumMs,
          max(MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(SampleRateSum > 0, SampleRateSum, toFloat64(CallCount))) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bucketDurationQuantiles
        FROM service_external_edges_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'web'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND TargetName != ''
        GROUP BY sourceService, targetType, targetSystem, targetName
UNION ALL
SELECT
          ServiceName AS sourceService,
          multiIf((coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '' OR SpanAttributes['messaging.system'] != ''), 'messaging', (SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != ''), 'rpc', 'http') AS targetType,
          multiIf((coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '' OR SpanAttributes['messaging.system'] != ''), SpanAttributes['messaging.system'], (SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != ''), SpanAttributes['rpc.system'], '') AS targetSystem,
          multiIf((coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '' OR SpanAttributes['messaging.system'] != ''), if(coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '', coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']), SpanAttributes['messaging.system']), (SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != ''), if(SpanAttributes['rpc.service'] != '', SpanAttributes['rpc.service'], SpanAttributes['rpc.system']), if(SpanAttributes['server.address'] != '', SpanAttributes['server.address'], if(SpanAttributes['http.host'] != '', SpanAttributes['http.host'], SpanAttributes['url.authority']))) AS targetName,
          count() AS bucketCallCount,
          countIf(StatusCode = 'Error') AS bucketErrorCount,
          sum(Duration / 1000000) AS bucketDurationSumMs,
          max(Duration / 1000000) AS bucketMaxDurationMs,
          sum(SampleRate) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bucketDurationQuantiles
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'web'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND SpanKind IN ('Client', 'Producer')
          AND SpanAttributes['db.system.name'] = ''
          AND ((((((SpanAttributes['server.address'] != '' OR SpanAttributes['http.host'] != '') OR SpanAttributes['url.authority'] != '') OR coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '') OR SpanAttributes['messaging.system'] != '') OR SpanAttributes['rpc.service'] != '') OR SpanAttributes['rpc.system'] != '')
        GROUP BY sourceService, targetType, targetSystem, targetName
        HAVING targetName != ''
) AS edges
        WHERE NOT ((targetType = 'http' AND targetName IN (SELECT
          ParentServerAddress AS ParentServerAddress
        FROM service_address_resolutions_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND SourceService = 'web'
          AND Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND ParentServerAddress != ''
        GROUP BY ParentServerAddress)))
        GROUP BY sourceService, targetType, targetSystem, targetName
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceExternalEdgesSQL:env-scoped  [f137812a]
SELECT
          sourceService AS sourceService,
          targetType AS targetType,
          targetSystem AS targetSystem,
          targetName AS targetName,
          sum(bucketCallCount) AS callCount,
          sum(bucketErrorCount) AS errorCount,
          sum(bucketDurationSumMs) / nullIf(sum(bucketCallCount), 0) AS avgDurationMs,
          max(bucketMaxDurationMs) AS maxDurationMs,
          if(sum(bucketCallCount) > 0, arrayElement(quantilesTDigestWeightedMerge(0.5, 0.95)(bucketDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          sum(bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          ServiceName AS sourceService,
          TargetType AS targetType,
          TargetSystem AS targetSystem,
          TargetName AS targetName,
          sum(CallCount) AS bucketCallCount,
          sum(ErrorCount) AS bucketErrorCount,
          sum(DurationSumMs) AS bucketDurationSumMs,
          max(MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(SampleRateSum > 0, SampleRateSum, toFloat64(CallCount))) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedMergeState(0.5, 0.95)(DurationQuantiles) AS bucketDurationQuantiles
        FROM service_external_edges_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'web'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND TargetName != ''
          AND DeploymentEnv = 'production'
        GROUP BY sourceService, targetType, targetSystem, targetName
UNION ALL
SELECT
          ServiceName AS sourceService,
          multiIf((coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '' OR SpanAttributes['messaging.system'] != ''), 'messaging', (SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != ''), 'rpc', 'http') AS targetType,
          multiIf((coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '' OR SpanAttributes['messaging.system'] != ''), SpanAttributes['messaging.system'], (SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != ''), SpanAttributes['rpc.system'], '') AS targetSystem,
          multiIf((coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '' OR SpanAttributes['messaging.system'] != ''), if(coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '', coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']), SpanAttributes['messaging.system']), (SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != ''), if(SpanAttributes['rpc.service'] != '', SpanAttributes['rpc.service'], SpanAttributes['rpc.system']), if(SpanAttributes['server.address'] != '', SpanAttributes['server.address'], if(SpanAttributes['http.host'] != '', SpanAttributes['http.host'], SpanAttributes['url.authority']))) AS targetName,
          count() AS bucketCallCount,
          countIf(StatusCode = 'Error') AS bucketErrorCount,
          sum(Duration / 1000000) AS bucketDurationSumMs,
          max(Duration / 1000000) AS bucketMaxDurationMs,
          sum(SampleRate) AS bucketEstimatedSpanCount,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS bucketDurationQuantiles
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'web'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND SpanKind IN ('Client', 'Producer')
          AND SpanAttributes['db.system.name'] = ''
          AND ((((((SpanAttributes['server.address'] != '' OR SpanAttributes['http.host'] != '') OR SpanAttributes['url.authority'] != '') OR coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '') OR SpanAttributes['messaging.system'] != '') OR SpanAttributes['rpc.service'] != '') OR SpanAttributes['rpc.system'] != '')
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) = 'production'
        GROUP BY sourceService, targetType, targetSystem, targetName
        HAVING targetName != ''
) AS edges
        WHERE NOT ((targetType = 'http' AND targetName IN (SELECT
          ParentServerAddress AS ParentServerAddress
        FROM service_address_resolutions_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND SourceService = 'web'
          AND Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND ParentServerAddress != ''
          AND DeploymentEnv = 'production'
        GROUP BY ParentServerAddress)))
        GROUP BY sourceService, targetType, targetSystem, targetName
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- builder:service-map:serviceMapEdgeJoinQuery:rollup-hour  [739f1f00]
SELECT
          p.OrgId AS OrgId,
          toStartOfHour(p.Timestamp) AS Hour,
          p.ServiceName AS SourceService,
          c.ServiceName AS TargetService,
          p.DeploymentEnv AS DeploymentEnv,
          count() AS CallCount,
          countIf(c.StatusCode = 'Error') AS ErrorCount,
          sum(c.Duration / 1000000) AS DurationSumMs,
          max(c.Duration / 1000000) AS MaxDurationMs,
          countIf(match(c.TraceState, 'th:[0-9a-f]+')) AS SampledSpanCount,
          countIf(NOT (match(c.TraceState, 'th:[0-9a-f]+'))) AS UnsampledSpanCount,
          sum(multiIf(match(c.TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0)) AS SampleRateSum
        FROM (SELECT
          OrgId AS OrgId,
          Timestamp AS Timestamp,
          TraceId AS TraceId,
          SpanId AS SpanId,
          ServiceName AS ServiceName,
          DeploymentEnv AS DeploymentEnv
        FROM service_map_spans
        WHERE SpanKind IN ('Client', 'Producer')
          AND Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp < toDateTime('2026-01-03 14:15:00')
          AND OrgId = 'org_sql_catalog') AS p
        INNER JOIN (SELECT
          TraceId AS TraceId,
          ParentSpanId AS ParentSpanId,
          ServiceName AS ServiceName,
          Duration AS Duration,
          StatusCode AS StatusCode,
          TraceState AS TraceState
        FROM service_map_children
        WHERE Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp < toDateTime('2026-01-03 14:15:00')
          AND OrgId = 'org_sql_catalog') AS c ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)
        WHERE p.ServiceName != c.ServiceName
        GROUP BY OrgId, Hour, SourceService, TargetService, DeploymentEnv
        FORMAT JSON

-- builder:service-map:serviceMapEdgeJoinQuery:scoped-to-service  [184fee2b]
SELECT
          p.OrgId AS OrgId,
          toStartOfHour(p.Timestamp) AS Hour,
          p.ServiceName AS SourceService,
          c.ServiceName AS TargetService,
          p.DeploymentEnv AS DeploymentEnv,
          count() AS CallCount,
          countIf(c.StatusCode = 'Error') AS ErrorCount,
          sum(c.Duration / 1000000) AS DurationSumMs,
          max(c.Duration / 1000000) AS MaxDurationMs,
          countIf(match(c.TraceState, 'th:[0-9a-f]+')) AS SampledSpanCount,
          countIf(NOT (match(c.TraceState, 'th:[0-9a-f]+'))) AS UnsampledSpanCount,
          sum(multiIf(match(c.TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0)) AS SampleRateSum
        FROM (SELECT
          OrgId AS OrgId,
          Timestamp AS Timestamp,
          TraceId AS TraceId,
          SpanId AS SpanId,
          ServiceName AS ServiceName,
          DeploymentEnv AS DeploymentEnv
        FROM service_map_spans
        WHERE SpanKind IN ('Client', 'Producer')
          AND Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp < toDateTime('2026-01-03 14:15:00')
          AND OrgId = 'org_sql_catalog'
          AND DeploymentEnv = 'production'
          AND ServiceName = 'web') AS p
        INNER JOIN (SELECT
          TraceId AS TraceId,
          ParentSpanId AS ParentSpanId,
          ServiceName AS ServiceName,
          Duration AS Duration,
          StatusCode AS StatusCode,
          TraceState AS TraceState
        FROM service_map_children
        WHERE Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp < toDateTime('2026-01-03 14:15:00')
          AND OrgId = 'org_sql_catalog'
          AND DeploymentEnv = 'production') AS c ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)
        WHERE p.ServiceName != c.ServiceName
        GROUP BY OrgId, Hour, SourceService, TargetService, DeploymentEnv
        FORMAT JSON

-- builder:service-operations:serviceOperationsSummaryQuery:default  [369067d7]
SELECT
          bSpanName AS spanName,
          sum(bSpanCount) AS spanCount,
          sum(bEstimatedSpanCount) AS estimatedSpanCount,
          sum(bErrorCount) AS errorCount,
          sum(bEstimatedErrorCount) AS estimatedErrorCount,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedErrorCount) / sum(bEstimatedSpanCount), 0) AS errorRate,
          if(sum(bSpanCount) > 0, sum(bDurationSum) / sum(bSpanCount) / 1000000, 0) AS avgDurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000, 0) AS p50DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000, 0) AS p99DurationMs
        FROM (
SELECT
          if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) AS bSpanName,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bSpanName
UNION ALL
SELECT
          SpanName AS bSpanName,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_minutely
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
          AND (Minute < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Minute >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bSpanName
UNION ALL
SELECT
          SpanName AS bSpanName,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bSpanName
) AS operation_windows
        GROUP BY spanName
        ORDER BY estimatedSpanCount DESC
        LIMIT 50
        FORMAT JSON

-- builder:service-operations:serviceOperationsSummaryQuery:envFiltered  [df13f9c7]
SELECT
          bSpanName AS spanName,
          sum(bSpanCount) AS spanCount,
          sum(bEstimatedSpanCount) AS estimatedSpanCount,
          sum(bErrorCount) AS errorCount,
          sum(bEstimatedErrorCount) AS estimatedErrorCount,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedErrorCount) / sum(bEstimatedSpanCount), 0) AS errorRate,
          if(sum(bSpanCount) > 0, sum(bDurationSum) / sum(bSpanCount) / 1000000, 0) AS avgDurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000, 0) AS p50DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000, 0) AS p95DurationMs,
          if(sum(bSpanCount) > 0, arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000, 0) AS p99DurationMs
        FROM (
SELECT
          if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) AS bSpanName,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bSpanName
UNION ALL
SELECT
          SpanName AS bSpanName,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_minutely
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND DeploymentEnv IN ('production')
          AND Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
          AND (Minute < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Minute >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bSpanName
UNION ALL
SELECT
          SpanName AS bSpanName,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles
        FROM service_operations_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND DeploymentEnv IN ('production')
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bSpanName
) AS operation_windows
        GROUP BY spanName
        ORDER BY estimatedSpanCount DESC
        LIMIT 50
        FORMAT JSON

-- builder:service-operations:serviceOperationsTimeseriesQuery:default  [aa8bcdc7]
SELECT
          bucket AS bucket,
          spanName AS spanName,
          sum(count) AS count
        FROM (
SELECT
          toStartOfInterval(Timestamp, INTERVAL 300 SECOND) AS bucket,
          if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) AS spanName,
          sum(SampleRate) AS count
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
          AND if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) IN ('GET /v2/services', 'POST /v2/alerts')
        GROUP BY bucket, spanName
UNION ALL
SELECT
          toStartOfInterval(Minute, INTERVAL 300 SECOND) AS bucket,
          SpanName AS spanName,
          sum(EstimatedSpanCount) AS count
        FROM service_operations_minutely
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
          AND SpanName IN ('GET /v2/services', 'POST /v2/alerts')
        GROUP BY bucket, spanName
) AS operation_buckets
        GROUP BY bucket, spanName
        ORDER BY bucket ASC
        LIMIT 10000
        FORMAT JSON

-- builder:services:serviceCatalogQuery:default  [4475276a]
SELECT
          bServiceName AS serviceName,
          arraySort(arrayFilter(x -> x != '', arrayDistinct(groupArray(bServiceNamespace)))) AS serviceNamespaces,
          arraySort(arrayFilter(x -> x != '', arrayDistinct(groupArray(bEnvironment)))) AS deploymentEnvironments,
          sum(bSpanCount) AS spanCount,
          sum(bErrorCount) AS errorCount,
          sum(bEstimatedErrorCount) AS estimatedErrorCount,
          sum(bEstimatedSpanCount) AS estimatedSpanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99LatencyMs
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY serviceName
        ORDER BY estimatedSpanCount DESC, serviceName ASC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:services:serviceCatalogQuery:filtered  [4a803960]
SELECT
          bServiceName AS serviceName,
          arraySort(arrayFilter(x -> x != '', arrayDistinct(groupArray(bServiceNamespace)))) AS serviceNamespaces,
          arraySort(arrayFilter(x -> x != '', arrayDistinct(groupArray(bEnvironment)))) AS deploymentEnvironments,
          sum(bSpanCount) AS spanCount,
          sum(bErrorCount) AS errorCount,
          sum(bEstimatedErrorCount) AS estimatedErrorCount,
          sum(bEstimatedSpanCount) AS estimatedSpanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99LatencyMs
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv IN ('production')
          AND ServiceNamespace IN ('backend')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND DeploymentEnv IN ('production')
          AND ServiceNamespace IN ('backend')
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY serviceName
        ORDER BY estimatedSpanCount DESC, serviceName ASC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:session-events:sessionActivityQuery:default  [daf1704b]
SELECT
          sessionId AS sessionId,
          sumIf(gapMs, (gapMs > 0 AND gapMs <= 15000)) AS activeTimeMs,
          sumIf(gapMs, gapMs > 15000) AS idleTimeMs,
          count() AS eventCount
        FROM (SELECT
          SessionId AS sessionId,
          toFloat64(toUnixTimestamp64Nano(Timestamp) - toUnixTimestamp64Nano(lagInFrame(Timestamp, 1, Timestamp) OVER (PARTITION BY SessionId ORDER BY Timestamp ASC, Seq ASC ROWS BETWEEN 1 PRECEDING AND CURRENT ROW))) / 1000000 AS gapMs
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND SessionId = 'sess_0af7651916cd43dd'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00') AS g
        GROUP BY sessionId
        LIMIT 1
        FORMAT JSON

-- builder:session-events:sessionTranscriptQuery:default  [744f689b]
SELECT
          Timestamp AS timestamp,
          Seq AS seq,
          Type AS type,
          Url AS url,
          TraceId AS traceId,
          Level AS level,
          Message AS message,
          TargetSelector AS targetSelector,
          TargetText AS targetText,
          NetMethod AS netMethod,
          NetUrl AS netUrl,
          NetStatus AS netStatus,
          NetDurationMs AS netDurationMs,
          ErrorStack AS errorStack,
          toJSONString(Attributes) AS attributes
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND SessionId = 'sess_0af7651916cd43dd'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        ORDER BY timestamp ASC, seq ASC
        LIMIT 100
        OFFSET 0
        FORMAT JSON

-- builder:session-replays:getSessionReplayQuery:default  [f13cecf7]
SELECT
          Version AS version,
          SessionId AS sessionId,
          StartTime AS startTime,
          EndTime AS endTime,
          DurationMs AS durationMs,
          Status AS status,
          UserId AS userId,
          UrlInitial AS urlInitial,
          UserAgent AS userAgent,
          BrowserName AS browserName,
          OsName AS osName,
          DeviceType AS deviceType,
          Country AS country,
          ServiceName AS serviceName,
          PageViews AS pageViews,
          ClickCount AS clickCount,
          ErrorCount AS errorCount,
          TraceIds AS traceIds,
          toJSONString(ResourceAttributes) AS resourceAttributes,
          VisitorId AS visitorId,
          VisitorIsNew AS visitorIsNew,
          UserEmail AS userEmail,
          UserName AS userName,
          GroupId AS groupId,
          GroupName AS groupName,
          toJSONString(UserTraits) AS userTraits,
          Referrer AS referrer,
          ReferrerHost AS referrerHost,
          UtmSource AS utmSource,
          UtmMedium AS utmMedium,
          UtmCampaign AS utmCampaign,
          UtmTerm AS utmTerm,
          UtmContent AS utmContent,
          Host AS host,
          EntryPath AS entryPath,
          ExitPath AS exitPath,
          Language AS language,
          LastActivityAt AS lastActivityAt
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND SessionId = 'sess_0af7651916cd43dd'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
        ORDER BY version DESC
        LIMIT 1
        FORMAT JSON

-- builder:session-replays:sessionReplayChunkIndexQuery:default  [2e322b20]
SELECT
          ChunkSeq AS chunkSeq,
          Timestamp AS timestamp,
          DurationMs AS durationMs,
          EventCount AS eventCount,
          ByteSize AS byteSize,
          IsCheckpoint AS isCheckpoint
        FROM session_replay_events
        WHERE OrgId = 'org_sql_catalog'
          AND SessionId = 'sess_0af7651916cd43dd'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        ORDER BY chunkSeq ASC
        FORMAT JSON

-- builder:session-replays:sessionReplayEventsQuery:default  [42cce486]
SELECT
          ChunkSeq AS chunkSeq,
          Timestamp AS timestamp,
          DurationMs AS durationMs,
          EventCount AS eventCount,
          ByteSize AS byteSize,
          Events AS events,
          IsCheckpoint AS isCheckpoint
        FROM session_replay_events
        WHERE OrgId = 'org_sql_catalog'
          AND SessionId = 'sess_0af7651916cd43dd'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        ORDER BY chunkSeq ASC
        FORMAT JSON

-- builder:session-replays:sessionReplayEventsQuery:ranged  [5bdfa930]
SELECT
          ChunkSeq AS chunkSeq,
          Timestamp AS timestamp,
          DurationMs AS durationMs,
          EventCount AS eventCount,
          ByteSize AS byteSize,
          Events AS events,
          IsCheckpoint AS isCheckpoint
        FROM session_replay_events
        WHERE OrgId = 'org_sql_catalog'
          AND SessionId = 'sess_0af7651916cd43dd'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ChunkSeq >= 16
          AND ChunkSeq <= 31
        ORDER BY chunkSeq ASC
        LIMIT 40
        FORMAT JSON

-- builder:session-replays:sessionReplaysFacetsQuery:default  [028f5de8]
SELECT
          ServiceName AS name,
          uniq(SessionId) AS count,
          'service' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND ServiceName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          BrowserName AS name,
          uniq(SessionId) AS count,
          'browser' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND BrowserName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          Country AS name,
          uniq(SessionId) AS count,
          'country' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND Country != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          DeviceType AS name,
          uniq(SessionId) AS count,
          'device' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND DeviceType != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          GroupName AS name,
          uniq(SessionId) AS count,
          'group' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND GroupName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          toString(toUInt64(round(pow(2, floor(log2(greatest(DurationMs, 1000) / 1000) * 2) / 2) * 1000))) AS name,
          uniq(SessionId) AS count,
          'durationBucket' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND DurationMs > 0
        GROUP BY name
        LIMIT 40
UNION ALL
SELECT
          'p50' AS name,
          toUInt64(ifNotFinite(round(quantile(0.5)(assumeNotNull(DurationMs))), 0)) AS count,
          'durationStat' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND DurationMs > 0
UNION ALL
SELECT
          'p95' AS name,
          toUInt64(ifNotFinite(round(quantile(0.95)(assumeNotNull(DurationMs))), 0)) AS count,
          'durationStat' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND DurationMs > 0
UNION ALL
SELECT
          'error' AS name,
          uniq(SessionId) AS count,
          'error' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND ErrorCount > 0
FORMAT JSON

-- builder:session-replays:sessionReplaysFacetsQuery:identity-filtered  [92d30094]
SELECT
          ServiceName AS name,
          uniq(SessionId) AS count,
          'service' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND GroupName = 'Acme Inc'
          AND (UserName ILIKE '%ada%' OR UserEmail ILIKE '%ada%')
          AND ServiceName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          BrowserName AS name,
          uniq(SessionId) AS count,
          'browser' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND GroupName = 'Acme Inc'
          AND (UserName ILIKE '%ada%' OR UserEmail ILIKE '%ada%')
          AND BrowserName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          Country AS name,
          uniq(SessionId) AS count,
          'country' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND GroupName = 'Acme Inc'
          AND (UserName ILIKE '%ada%' OR UserEmail ILIKE '%ada%')
          AND Country != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          DeviceType AS name,
          uniq(SessionId) AS count,
          'device' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND GroupName = 'Acme Inc'
          AND (UserName ILIKE '%ada%' OR UserEmail ILIKE '%ada%')
          AND DeviceType != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          GroupName AS name,
          uniq(SessionId) AS count,
          'group' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND (UserName ILIKE '%ada%' OR UserEmail ILIKE '%ada%')
          AND GroupName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          toString(toUInt64(round(pow(2, floor(log2(greatest(DurationMs, 1000) / 1000) * 2) / 2) * 1000))) AS name,
          uniq(SessionId) AS count,
          'durationBucket' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND GroupName = 'Acme Inc'
          AND (UserName ILIKE '%ada%' OR UserEmail ILIKE '%ada%')
          AND DurationMs > 0
        GROUP BY name
        LIMIT 40
UNION ALL
SELECT
          'p50' AS name,
          toUInt64(ifNotFinite(round(quantile(0.5)(assumeNotNull(DurationMs))), 0)) AS count,
          'durationStat' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND GroupName = 'Acme Inc'
          AND (UserName ILIKE '%ada%' OR UserEmail ILIKE '%ada%')
          AND DurationMs > 0
UNION ALL
SELECT
          'p95' AS name,
          toUInt64(ifNotFinite(round(quantile(0.95)(assumeNotNull(DurationMs))), 0)) AS count,
          'durationStat' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND GroupName = 'Acme Inc'
          AND (UserName ILIKE '%ada%' OR UserEmail ILIKE '%ada%')
          AND DurationMs > 0
UNION ALL
SELECT
          'error' AS name,
          uniq(SessionId) AS count,
          'error' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND GroupName = 'Acme Inc'
          AND (UserName ILIKE '%ada%' OR UserEmail ILIKE '%ada%')
          AND ErrorCount > 0
FORMAT JSON

-- builder:session-replays:sessionReplaysListQuery:default  [291656ac]
SELECT
          SessionId AS sessionId,
          argMax(StartTime, Version) AS startTime,
          argMax(EndTime, Version) AS endTime,
          argMax(DurationMs, Version) AS durationMs,
          argMax(Status, Version) AS status,
          argMax(UserId, Version) AS userId,
          argMax(UserName, Version) AS userName,
          argMax(UserEmail, Version) AS userEmail,
          argMax(GroupId, Version) AS groupId,
          argMax(GroupName, Version) AS groupName,
          argMax(VisitorId, Version) AS visitorId,
          argMax(UtmSource, Version) AS utmSource,
          argMax(EntryPath, Version) AS entryPath,
          argMax(UrlInitial, Version) AS urlInitial,
          argMax(BrowserName, Version) AS browserName,
          argMax(OsName, Version) AS osName,
          argMax(DeviceType, Version) AS deviceType,
          argMax(Country, Version) AS country,
          argMax(ServiceName, Version) AS serviceName,
          argMax(PageViews, Version) AS pageViews,
          argMax(ClickCount, Version) AS clickCount,
          argMax(ErrorCount, Version) AS errorCount,
          length(argMax(TraceIds, Version)) AS traceCount,
          argMax(ResourceAttributes['maple.session.recorded'], Version) AS recorded
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
        GROUP BY sessionId
        ORDER BY startTime DESC, sessionId DESC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:session-replays:sessionReplaysListQuery:filtered  [42983806]
SELECT
          s.sessionId AS sessionId,
          s.startTime AS startTime,
          s.endTime AS endTime,
          s.durationMs AS durationMs,
          s.status AS status,
          s.userId AS userId,
          s.userName AS userName,
          s.userEmail AS userEmail,
          s.groupId AS groupId,
          s.groupName AS groupName,
          s.visitorId AS visitorId,
          s.utmSource AS utmSource,
          s.entryPath AS entryPath,
          s.urlInitial AS urlInitial,
          s.browserName AS browserName,
          s.osName AS osName,
          s.deviceType AS deviceType,
          s.country AS country,
          s.serviceName AS serviceName,
          s.pageViews AS pageViews,
          s.clickCount AS clickCount,
          s.errorCount AS errorCount,
          s.traceCount AS traceCount,
          s.recorded AS recorded
        FROM (SELECT
          SessionId AS sessionId,
          argMax(StartTime, Version) AS startTime,
          argMax(EndTime, Version) AS endTime,
          argMax(DurationMs, Version) AS durationMs,
          argMax(Status, Version) AS status,
          argMax(UserId, Version) AS userId,
          argMax(UserName, Version) AS userName,
          argMax(UserEmail, Version) AS userEmail,
          argMax(GroupId, Version) AS groupId,
          argMax(GroupName, Version) AS groupName,
          argMax(VisitorId, Version) AS visitorId,
          argMax(UtmSource, Version) AS utmSource,
          argMax(EntryPath, Version) AS entryPath,
          argMax(UrlInitial, Version) AS urlInitial,
          argMax(BrowserName, Version) AS browserName,
          argMax(OsName, Version) AS osName,
          argMax(DeviceType, Version) AS deviceType,
          argMax(Country, Version) AS country,
          argMax(ServiceName, Version) AS serviceName,
          argMax(PageViews, Version) AS pageViews,
          argMax(ClickCount, Version) AS clickCount,
          argMax(ErrorCount, Version) AS errorCount,
          length(argMax(TraceIds, Version)) AS traceCount,
          argMax(ResourceAttributes['maple.session.recorded'], Version) AS recorded
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND ServiceName = 'web'
          AND (UserName ILIKE '%ada%' OR UserEmail ILIKE '%ada%')
          AND GroupName = 'Acme Inc'
          AND ErrorCount > 0
          AND UrlInitial ILIKE '%checkout%'
        GROUP BY sessionId) AS s
        LEFT JOIN (SELECT
          sessionId AS sessionId,
          sumIf(gapMs, (gapMs > 0 AND gapMs <= 15000)) AS activeTimeMs,
          sumIf(gapMs, gapMs > 15000) AS idleTimeMs,
          count() AS eventCount
        FROM (SELECT
          SessionId AS sessionId,
          toFloat64(toUnixTimestamp64Nano(Timestamp) - toUnixTimestamp64Nano(lagInFrame(Timestamp, 1, Timestamp) OVER (PARTITION BY SessionId ORDER BY Timestamp ASC, Seq ASC ROWS BETWEEN 1 PRECEDING AND CURRENT ROW))) / 1000000 AS gapMs
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00') AS g
        GROUP BY sessionId) AS a ON s.sessionId = a.sessionId
        WHERE s.durationMs >= 1000
          AND coalesce(a.activeTimeMs, 0) >= 500
        ORDER BY startTime DESC, sessionId DESC
        LIMIT 50
        OFFSET 0
        FORMAT JSON

-- builder:session-replays:sessionsForTraceQuery:default  [279e957f]
SELECT
          SessionId AS sessionId,
          argMax(StartTime, Version) AS startTime,
          argMax(DurationMs, Version) AS durationMs
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND has(TraceIds, '0af7651916cd43dd8448eb211c80319c')
        GROUP BY sessionId
        ORDER BY startTime DESC, sessionId DESC
        LIMIT 10
        OFFSET 0
        FORMAT JSON

-- builder:session-replays:sessionTraceSummariesQuery:default  [cd6dac42]
SELECT
          TraceId AS traceId,
          min(Timestamp) AS startTime,
          if(maxIf(Duration, ParentSpanId = '') / 1000000 > 0, maxIf(Duration, ParentSpanId = '') / 1000000, max(Duration) / 1000000) AS durationMs,
          coalesce(nullIf(anyIf(SpanName, ParentSpanId = ''), ''), any(SpanName)) AS rootSpanName,
          coalesce(nullIf(anyIf(ServiceName, ParentSpanId = ''), ''), any(ServiceName)) AS rootServiceName,
          anyIf(SpanKind, ParentSpanId = '') AS rootSpanKind,
          anyIf(toJSONString(SpanAttributes), ParentSpanId = '') AS rootSpanAttributes,
          count() AS spanCount,
          if(countIf(StatusCode = 'Error') > 0, 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND TraceId IN ('0af7651916cd43dd8448eb211c80319c')
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        ORDER BY startTime ASC
        LIMIT 200
        FORMAT JSON

-- builder:traces:traceServicesByTraceIdsQuery:page-enrichment  [4e5e4b4b]
SELECT
          TraceId AS traceId,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(ServiceName)), argMin(ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services
        FROM service_map_spans
        WHERE OrgId = 'org_sql_catalog'
          AND TraceId IN ('0af7651916cd43dd8448eb211c80319c', '4bf92f3577b34da6a3ce929d0e0e4736')
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        LIMIT 2
        FORMAT JSON

-- builder:web-analytics:webAnalyticsBreakdownsQuery:all-dimensions-filtered  [dd21e64d]
SELECT
          if(ReferrerHost = '', '(none)', ReferrerHost) AS name,
          uniq(SessionId) AS count,
          'referrerHost' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND domain(Url) = 'maple.dev'
          AND path(Url) = '/pricing'
        GROUP BY sessionId)
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND Message = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          Country AS name,
          uniq(SessionId) AS count,
          'country' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND domain(Url) = 'maple.dev'
          AND path(Url) = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND Message = 'signup_started'
        GROUP BY sessionId)
          AND Country != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          DeviceType AS name,
          uniq(SessionId) AS count,
          'deviceType' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND domain(Url) = 'maple.dev'
          AND path(Url) = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND Message = 'signup_started'
        GROUP BY sessionId)
          AND DeviceType != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          BrowserName AS name,
          uniq(SessionId) AS count,
          'browserName' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND domain(Url) = 'maple.dev'
          AND path(Url) = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND Message = 'signup_started'
        GROUP BY sessionId)
          AND BrowserName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          OsName AS name,
          uniq(SessionId) AS count,
          'osName' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND domain(Url) = 'maple.dev'
          AND path(Url) = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND Message = 'signup_started'
        GROUP BY sessionId)
          AND OsName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          Language AS name,
          uniq(SessionId) AS count,
          'language' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND domain(Url) = 'maple.dev'
          AND path(Url) = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND Message = 'signup_started'
        GROUP BY sessionId)
          AND Language != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(UtmSource = '', '(none)', UtmSource) AS name,
          uniq(SessionId) AS count,
          'utmSource' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND domain(Url) = 'maple.dev'
          AND path(Url) = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND Message = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(UtmMedium = '', '(none)', UtmMedium) AS name,
          uniq(SessionId) AS count,
          'utmMedium' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND domain(Url) = 'maple.dev'
          AND path(Url) = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND Message = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(UtmCampaign = '', '(none)', UtmCampaign) AS name,
          uniq(SessionId) AS count,
          'utmCampaign' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND domain(Url) = 'maple.dev'
          AND path(Url) = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND Message = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          EntryPath AS name,
          uniq(SessionId) AS count,
          'entryPath' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND domain(Url) = 'maple.dev'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND Message = 'signup_started'
        GROUP BY sessionId)
          AND EntryPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          ExitPath AS name,
          uniq(SessionId) AS count,
          'exitPath' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND domain(Url) = 'maple.dev'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND Message = 'signup_started'
        GROUP BY sessionId)
          AND ExitPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          Host AS name,
          uniq(SessionId) AS count,
          'host' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND path(Url) = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND Message = 'signup_started'
        GROUP BY sessionId)
          AND Host != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- builder:web-analytics:webAnalyticsBreakdownsQuery:all-dimensions-filtered-rollup  [858177f5]
SELECT
          if(ReferrerHost = '', '(none)', ReferrerHost) AS name,
          uniq(SessionId) AS count,
          'referrerHost' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
          AND PagePath = '/pricing'
        GROUP BY sessionId)
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          Country AS name,
          uniq(SessionId) AS count,
          'country' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
          AND PagePath = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
          AND Country != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          DeviceType AS name,
          uniq(SessionId) AS count,
          'deviceType' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
          AND PagePath = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
          AND DeviceType != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          BrowserName AS name,
          uniq(SessionId) AS count,
          'browserName' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
          AND PagePath = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
          AND BrowserName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          OsName AS name,
          uniq(SessionId) AS count,
          'osName' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
          AND PagePath = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
          AND OsName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          Language AS name,
          uniq(SessionId) AS count,
          'language' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
          AND PagePath = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
          AND Language != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(UtmSource = '', '(none)', UtmSource) AS name,
          uniq(SessionId) AS count,
          'utmSource' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
          AND PagePath = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(UtmMedium = '', '(none)', UtmMedium) AS name,
          uniq(SessionId) AS count,
          'utmMedium' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
          AND PagePath = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(UtmCampaign = '', '(none)', UtmCampaign) AS name,
          uniq(SessionId) AS count,
          'utmCampaign' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
          AND PagePath = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          EntryPath AS name,
          uniq(SessionId) AS count,
          'entryPath' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
          AND EntryPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          ExitPath AS name,
          uniq(SessionId) AS count,
          'exitPath' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
          AND ExitPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          Host AS name,
          uniq(SessionId) AS count,
          'host' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND PagePath = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
          AND Host != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- builder:web-analytics:webAnalyticsBreakdownsQuery:default  [49a69b46]
SELECT
          if(ReferrerHost = '', '(none)', ReferrerHost) AS name,
          uniq(SessionId) AS count,
          'referrerHost' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          Country AS name,
          uniq(SessionId) AS count,
          'country' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND Country != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          DeviceType AS name,
          uniq(SessionId) AS count,
          'deviceType' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND DeviceType != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          BrowserName AS name,
          uniq(SessionId) AS count,
          'browserName' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND BrowserName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          OsName AS name,
          uniq(SessionId) AS count,
          'osName' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND OsName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          Language AS name,
          uniq(SessionId) AS count,
          'language' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND Language != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(UtmSource = '', '(none)', UtmSource) AS name,
          uniq(SessionId) AS count,
          'utmSource' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(UtmMedium = '', '(none)', UtmMedium) AS name,
          uniq(SessionId) AS count,
          'utmMedium' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(UtmCampaign = '', '(none)', UtmCampaign) AS name,
          uniq(SessionId) AS count,
          'utmCampaign' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          EntryPath AS name,
          uniq(SessionId) AS count,
          'entryPath' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND EntryPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          ExitPath AS name,
          uniq(SessionId) AS count,
          'exitPath' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND ExitPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          Host AS name,
          uniq(SessionId) AS count,
          'host' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND Host != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- builder:web-analytics:webAnalyticsBreakdownsQuery:default-rollup  [49a69b46]
SELECT
          if(ReferrerHost = '', '(none)', ReferrerHost) AS name,
          uniq(SessionId) AS count,
          'referrerHost' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          Country AS name,
          uniq(SessionId) AS count,
          'country' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND Country != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          DeviceType AS name,
          uniq(SessionId) AS count,
          'deviceType' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND DeviceType != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          BrowserName AS name,
          uniq(SessionId) AS count,
          'browserName' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND BrowserName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          OsName AS name,
          uniq(SessionId) AS count,
          'osName' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND OsName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          Language AS name,
          uniq(SessionId) AS count,
          'language' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND Language != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(UtmSource = '', '(none)', UtmSource) AS name,
          uniq(SessionId) AS count,
          'utmSource' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(UtmMedium = '', '(none)', UtmMedium) AS name,
          uniq(SessionId) AS count,
          'utmMedium' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          if(UtmCampaign = '', '(none)', UtmCampaign) AS name,
          uniq(SessionId) AS count,
          'utmCampaign' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          EntryPath AS name,
          uniq(SessionId) AS count,
          'entryPath' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND EntryPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          ExitPath AS name,
          uniq(SessionId) AS count,
          'exitPath' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND ExitPath != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          Host AS name,
          uniq(SessionId) AS count,
          'host' AS facetType
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND Host != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- builder:web-analytics:webAnalyticsEventsQuery:default  [7a2203c7]
SELECT
          Message AS name,
          count() AS events,
          uniq(SessionId) AS sessions
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND Message != ''
        GROUP BY name
        ORDER BY events DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsEventsQuery:default-rollup  [fcb15a4e]
SELECT
          EventName AS name,
          count() AS events,
          uniq(SessionId) AS sessions
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName != ''
        GROUP BY name
        ORDER BY events DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsEventsQuery:semi-joined  [9f5b9302]
SELECT
          Message AS name,
          count() AS events,
          uniq(SessionId) AS sessions
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND Country = 'DE'
        GROUP BY sessionId)
          AND Message != ''
        GROUP BY name
        ORDER BY events DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsEventsQuery:semi-joined-rollup  [69728711]
SELECT
          EventName AS name,
          count() AS events,
          uniq(SessionId) AS sessions
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND Country = 'DE'
        GROUP BY sessionId)
          AND EventName != ''
        GROUP BY name
        ORDER BY events DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsEventsQuery:url-filtered  [8b46502c]
SELECT
          Message AS name,
          count() AS events,
          uniq(SessionId) AS sessions
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND domain(Url) = 'maple.dev'
          AND Message != ''
        GROUP BY name
        ORDER BY events DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsEventsQuery:url-filtered-rollup  [031766f1]
SELECT
          EventName AS name,
          count() AS events,
          uniq(SessionId) AS sessions
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND Host = 'maple.dev'
          AND EventName != ''
        GROUP BY name
        ORDER BY events DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsLiveQuery:default  [faaf4388]
SELECT
          uniqIf(VisitorId, VisitorId != '') AS visitors,
          uniq(SessionId) AS sessions
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND coalesce(LastActivityAt, StartTime) >= toDateTime('2026-01-03 14:15:00') - INTERVAL 300 SECOND
        FORMAT JSON

-- builder:web-analytics:webAnalyticsLiveQuery:default-rollup  [faaf4388]
SELECT
          uniqIf(VisitorId, VisitorId != '') AS visitors,
          uniq(SessionId) AS sessions
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND coalesce(LastActivityAt, StartTime) >= toDateTime('2026-01-03 14:15:00') - INTERVAL 300 SECOND
        FORMAT JSON

-- builder:web-analytics:webAnalyticsLiveQuery:filtered  [09c5aef6]
SELECT
          uniqIf(VisitorId, VisitorId != '') AS visitors,
          uniq(SessionId) AS sessions
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND domain(Url) = 'maple.dev'
          AND path(Url) = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND Message = 'signup_started'
        GROUP BY sessionId)
          AND coalesce(LastActivityAt, StartTime) >= toDateTime('2026-01-03 14:15:00') - INTERVAL 300 SECOND
        FORMAT JSON

-- builder:web-analytics:webAnalyticsLiveQuery:filtered-rollup  [b0b00a05]
SELECT
          uniqIf(VisitorId, VisitorId != '') AS visitors,
          uniq(SessionId) AS sessions
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
          AND PagePath = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
          AND coalesce(LastActivityAt, StartTime) >= toDateTime('2026-01-03 14:15:00') - INTERVAL 300 SECOND
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPagesQuery:default  [ee65a1f8]
SELECT
          domain(Url) AS host,
          path(Url) AS pagePath,
          count() AS pageViews,
          uniq(SessionId) AS sessions
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND domain(Url) != ''
        GROUP BY host, pagePath
        ORDER BY pageViews DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPagesQuery:default-rollup  [db25069a]
SELECT
          Host AS host,
          PagePath AS pagePath,
          count() AS pageViews,
          uniq(SessionId) AS sessions
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host != ''
        GROUP BY host, pagePath
        ORDER BY pageViews DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPagesQuery:semi-joined  [1af66515]
SELECT
          domain(Url) AS host,
          path(Url) AS pagePath,
          count() AS pageViews,
          uniq(SessionId) AS sessions
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND Country = 'DE'
        GROUP BY sessionId)
          AND domain(Url) != ''
        GROUP BY host, pagePath
        ORDER BY pageViews DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPagesQuery:semi-joined-rollup  [95c72121]
SELECT
          Host AS host,
          PagePath AS pagePath,
          count() AS pageViews,
          uniq(SessionId) AS sessions
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND Country = 'DE'
        GROUP BY sessionId)
          AND Host != ''
        GROUP BY host, pagePath
        ORDER BY pageViews DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPagesQuery:url-filtered  [6e64a0b5]
SELECT
          domain(Url) AS host,
          path(Url) AS pagePath,
          count() AS pageViews,
          uniq(SessionId) AS sessions
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND domain(Url) = 'maple.dev'
          AND domain(Url) != ''
        GROUP BY host, pagePath
        ORDER BY pageViews DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPagesQuery:url-filtered-rollup  [d0bf84d1]
SELECT
          Host AS host,
          PagePath AS pagePath,
          count() AS pageViews,
          uniq(SessionId) AS sessions
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
          AND Host != ''
        GROUP BY host, pagePath
        ORDER BY pageViews DESC
        LIMIT 100
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPageviewsTimeseriesQuery:default  [17056c86]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket,
          count() AS pageViews,
          uniq(SessionId) AS sessions
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPageviewsTimeseriesQuery:default-rollup  [f5af91eb]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket,
          count() AS pageViews,
          uniq(SessionId) AS sessions
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPageviewsTimeseriesQuery:semi-joined  [b52b714d]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket,
          count() AS pageViews,
          uniq(SessionId) AS sessions
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND ReferrerHost = 't.co'
          AND VisitorIsNew = 0
        GROUP BY sessionId)
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:web-analytics:webAnalyticsPageviewsTimeseriesQuery:semi-joined-rollup  [6d125446]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket,
          count() AS pageViews,
          uniq(SessionId) AS sessions
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND ReferrerHost = 't.co'
          AND VisitorIsNew = 0
        GROUP BY sessionId)
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:web-analytics:webAnalyticsSummaryQuery:default  [9a0359fc]
SELECT
          uniqIf(VisitorId, VisitorId != '') AS visitors,
          uniq(SessionId) AS sessions,
          uniqIf(SessionId, VisitorIsNew = 1) AS newSessions,
          uniqIf(SessionId, VisitorId != '') - uniqIf(SessionId, (PageViews > 1 AND VisitorId != '')) AS bouncedSessions,
          uniqIf(SessionId, VisitorId != '') AS identifiedSessions,
          uniqIf(SessionId, multiSearchAnyCaseInsensitive(UserAgent, ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http'])) AS botSessions,
          round(ifNotFinite(avgIf(assumeNotNull(DurationMs), DurationMs > 0), 0)) AS avgDurationMs
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
        FORMAT JSON

-- builder:web-analytics:webAnalyticsSummaryQuery:default-rollup  [9a0359fc]
SELECT
          uniqIf(VisitorId, VisitorId != '') AS visitors,
          uniq(SessionId) AS sessions,
          uniqIf(SessionId, VisitorIsNew = 1) AS newSessions,
          uniqIf(SessionId, VisitorId != '') - uniqIf(SessionId, (PageViews > 1 AND VisitorId != '')) AS bouncedSessions,
          uniqIf(SessionId, VisitorId != '') AS identifiedSessions,
          uniqIf(SessionId, multiSearchAnyCaseInsensitive(UserAgent, ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http'])) AS botSessions,
          round(ifNotFinite(avgIf(assumeNotNull(DurationMs), DurationMs > 0), 0)) AS avgDurationMs
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
        FORMAT JSON

-- builder:web-analytics:webAnalyticsSummaryQuery:filtered  [7be4ede6]
SELECT
          uniqIf(VisitorId, VisitorId != '') AS visitors,
          uniq(SessionId) AS sessions,
          uniqIf(SessionId, VisitorIsNew = 1) AS newSessions,
          uniqIf(SessionId, VisitorId != '') - uniqIf(SessionId, (PageViews > 1 AND VisitorId != '')) AS bouncedSessions,
          uniqIf(SessionId, VisitorId != '') AS identifiedSessions,
          uniqIf(SessionId, multiSearchAnyCaseInsensitive(UserAgent, ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http'])) AS botSessions,
          round(ifNotFinite(avgIf(assumeNotNull(DurationMs), DurationMs > 0), 0)) AS avgDurationMs
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'navigation'
          AND domain(Url) = 'maple.dev'
          AND path(Url) = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM session_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Type = 'custom'
          AND Message = 'signup_started'
        GROUP BY sessionId)
        FORMAT JSON

-- builder:web-analytics:webAnalyticsSummaryQuery:filtered-rollup  [81474d1b]
SELECT
          uniqIf(VisitorId, VisitorId != '') AS visitors,
          uniq(SessionId) AS sessions,
          uniqIf(SessionId, VisitorIsNew = 1) AS newSessions,
          uniqIf(SessionId, VisitorId != '') - uniqIf(SessionId, (PageViews > 1 AND VisitorId != '')) AS bouncedSessions,
          uniqIf(SessionId, VisitorId != '') AS identifiedSessions,
          uniqIf(SessionId, multiSearchAnyCaseInsensitive(UserAgent, ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'meta-webindexer', 'Bytespider', 'CCBot', 'Amazonbot', 'DuckAssistBot', 'Googlebot', 'GoogleOther', 'AdsBot-Google', 'Google-Read-Aloud', 'bingbot', 'YandexBot', 'Baiduspider', 'DuckDuckBot', 'Applebot', 'Sogou', 'SeznamBot', 'AhrefsSiteAudit', 'AhrefsBot', 'SemrushBot', 'DataForSeoBot', 'DotBot', 'MJ12bot', 'Barkrowler', 'Screaming Frog', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot', 'Pinterest', 'HubSpot Crawler', 'Stripebot', 'UptimeRobot', 'Pingdom', 'StatusCake', 'Headless', 'bot/', 'bot\x3B', 'bot)', 'crawler', 'spider', '+http'])) AS botSessions,
          round(ifNotFinite(avgIf(assumeNotNull(DurationMs), DurationMs > 0), 0)) AS avgDurationMs
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'navigation'
          AND Host = 'maple.dev'
          AND PagePath = '/pricing'
        GROUP BY sessionId)
          AND ReferrerHost = 't.co'
          AND Country = 'DE'
          AND DeviceType = 'desktop'
          AND BrowserName = 'Chrome'
          AND OsName = 'macOS'
          AND Language = 'en-US'
          AND UtmSource = 'twitter'
          AND UtmMedium = 'social'
          AND UtmCampaign = 'launch'
          AND VisitorIsNew = 1
          AND SessionId IN (SELECT
          SessionId AS sessionId
        FROM product_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Kind = 'custom'
          AND EventName = 'signup_started'
        GROUP BY sessionId)
        FORMAT JSON

-- builder:web-analytics:webAnalyticsTimeseriesQuery:default  [7ac5c3d6]
SELECT
          toStartOfInterval(StartTime, INTERVAL 3600 SECOND) AS bucket,
          uniqIf(VisitorId, VisitorId != '') AS visitors,
          uniq(SessionId) AS sessions,
          uniqIf(SessionId, VisitorIsNew = 1) AS newSessions,
          uniqIf(SessionId, VisitorId != '') - uniqIf(SessionId, (PageViews > 1 AND VisitorId != '')) AS bouncedSessions,
          uniqIf(SessionId, VisitorId != '') AS identifiedSessions,
          round(ifNotFinite(avgIf(assumeNotNull(DurationMs), DurationMs > 0), 0)) AS avgDurationMs
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- builder:web-analytics:webAnalyticsTimeseriesQuery:default-rollup  [7ac5c3d6]
SELECT
          toStartOfInterval(StartTime, INTERVAL 3600 SECOND) AS bucket,
          uniqIf(VisitorId, VisitorId != '') AS visitors,
          uniq(SessionId) AS sessions,
          uniqIf(SessionId, VisitorIsNew = 1) AS newSessions,
          uniqIf(SessionId, VisitorId != '') - uniqIf(SessionId, (PageViews > 1 AND VisitorId != '')) AS bouncedSessions,
          uniqIf(SessionId, VisitorId != '') AS identifiedSessions,
          round(ifNotFinite(avgIf(assumeNotNull(DurationMs), DurationMs > 0), 0)) AS avgDurationMs
        FROM session_replays
        WHERE OrgId = 'org_sql_catalog'
          AND StartTime >= '2026-01-01 10:30:00'
          AND StartTime <= '2026-01-03 14:15:00'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- pipe:custom_traces_breakdown:all-root-only:baseline  [e5eb098f]
SELECT
          'all' AS name,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 1
        FORMAT JSON

-- pipe:custom_traces_breakdown:all-scoped:baseline  [311ca1dd]
SELECT
          'all' AS name,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND DeploymentEnv IN ('production')
          AND ServiceNamespace IN ('commerce')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 1
        FORMAT JSON

-- pipe:custom_traces_breakdown:by-attribute:baseline  [a82b913f]
SELECT
          SpanAttributes['http.route'] AS name,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- pipe:custom_traces_breakdown:by-attribute:bloom  [a82b913f]
SELECT
          SpanAttributes['http.route'] AS name,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- pipe:custom_traces_breakdown:by-attribute:text  [a82b913f]
SELECT
          SpanAttributes['http.route'] AS name,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- pipe:custom_traces_breakdown:by-environment:baseline  [de3cd3da]
SELECT
          DeploymentEnv AS name,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- pipe:custom_traces_breakdown:by-namespace:baseline  [735a6bbc]
SELECT
          ServiceNamespace AS name,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- pipe:custom_traces_breakdown:by-service:baseline  [12aefc0f]
SELECT
          ServiceName AS name,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- pipe:custom_traces_timeseries:errors-only:baseline  [8def6b38]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(SampleRate) AS estimatedSpanCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND StatusCode = 'Error'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:grouped-by-attribute:baseline  [30cd2a59]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(arrayStringConcat([toString(SpanAttributes['http.route']), toString(SpanAttributes['http.method'])], ' · '), ''), 'all') AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:grouped-by-attribute:bloom  [30cd2a59]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(arrayStringConcat([toString(SpanAttributes['http.route']), toString(SpanAttributes['http.method'])], ' · '), ''), 'all') AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:grouped-by-attribute:text  [30cd2a59]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(arrayStringConcat([toString(SpanAttributes['http.route']), toString(SpanAttributes['http.method'])], ' · '), ''), 'all') AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:grouped-by-service:baseline  [7574977e]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 60 SECOND) AS bucket,
          coalesce(nullIf(toString(ServiceName), ''), 'all') AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:grouped-by-service:bloom  [7574977e]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 60 SECOND) AS bucket,
          coalesce(nullIf(toString(ServiceName), ''), 'all') AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:grouped-by-service:text  [7574977e]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 60 SECOND) AS bucket,
          coalesce(nullIf(toString(ServiceName), ''), 'all') AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:root-only:baseline  [9924d9ca]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(SampleRate) AS estimatedSpanCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:custom_traces_timeseries:ungrouped:baseline  [2856fa21]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- pipe:error_detail_traces:default:baseline  [99fb32db]
SELECT
          TraceId AS traceId,
          min(Timestamp) AS startTime,
          intDiv(max(Duration), 1000) AS durationMicros,
          count() AS spanCount,
          groupUniqArray(ServiceName) AS services,
          anyIf(SpanName, ParentSpanId = '') AS rootSpanName,
          any(StatusMessage) AS errorMessage
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND TraceId IN (SELECT
          TraceId AS TraceId
        FROM (SELECT
          TraceId AS TraceId,
          max(Timestamp) AS lastErrorSeen
        FROM error_events
        WHERE OrgId = 'org_sql_catalog'
          AND FingerprintHash = toUInt64('11640393269246331608')
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY TraceId
        ORDER BY lastErrorSeen DESC
        LIMIT 10) AS matching_traces)
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY traceId
        ORDER BY startTime DESC
        FORMAT JSON

-- pipe:error_issue_environments:default:baseline  [16b2e68d]
SELECT
          DeploymentEnv AS name,
          count() AS count
        FROM error_events
        WHERE OrgId = 'org_sql_catalog'
          AND FingerprintHash = toUInt64('11640393269246331608')
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
        FORMAT JSON

-- pipe:error_issue_sample_traces:default:baseline  [165204e4]
SELECT
          TraceId AS traceId,
          SpanId AS spanId,
          ServiceName AS serviceName,
          Timestamp AS timestamp,
          ExceptionMessage AS exceptionMessage,
          intDiv(Duration, 1000) AS durationMicros
        FROM error_events
        WHERE OrgId = 'org_sql_catalog'
          AND FingerprintHash = toUInt64('11640393269246331608')
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        ORDER BY timestamp DESC
        LIMIT 25
        FORMAT JSON

-- pipe:error_issue_timeseries:default:baseline  [8ea53a5e]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket,
          count() AS count
        FROM error_events
        WHERE OrgId = 'org_sql_catalog'
          AND FingerprintHash = toUInt64('11640393269246331608')
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- pipe:error_issues:default:baseline  [ce76d415]
SELECT
          toString(FingerprintHash) AS fingerprintHash,
          any(ServiceName) AS serviceName,
          any(ExceptionType) AS exceptionType,
          any(ExceptionMessage) AS exceptionMessage,
          any(ErrorLabel) AS errorLabel,
          any(TopFrame) AS topFrame,
          count() AS count,
          uniq(ServiceName) AS affectedServicesCount,
          min(Timestamp) AS firstSeen,
          max(Timestamp) AS lastSeen
        FROM error_events_by_time
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY fingerprintHash
        ORDER BY count DESC
        LIMIT 50
        FORMAT JSON

-- pipe:error_rate_by_service:default:baseline  [915de03d]
SELECT
          serviceName AS serviceName,
          sum(bucketTotalLogs) AS totalLogs,
          sum(bucketErrorLogs) AS errorLogs,
          round(sum(bucketErrorLogs) / sum(bucketTotalLogs), 6) AS errorRate
        FROM (
SELECT
          ServiceName AS serviceName,
          count() AS bucketTotalLogs,
          countIf(SeverityText IN ('ERROR', 'FATAL')) AS bucketErrorLogs,
          0 AS errorRate
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY serviceName
UNION ALL
SELECT
          ServiceName AS serviceName,
          sum(Count) AS bucketTotalLogs,
          sumIf(Count, SeverityText IN ('ERROR', 'FATAL')) AS bucketErrorLogs,
          0 AS errorRate
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY serviceName
) AS rates
        GROUP BY serviceName
        ORDER BY errorRate DESC
        FORMAT JSON

-- pipe:errors_by_type:default:baseline  [155d011e]
SELECT
          toString(FingerprintHash) AS fingerprintHash,
          any(ErrorLabel) AS errorLabel,
          any(StatusMessage) AS sampleMessage,
          count() AS count,
          uniq(ServiceName) AS affectedServicesCount,
          min(Timestamp) AS firstSeen,
          max(Timestamp) AS lastSeen
        FROM error_events_by_time
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY fingerprintHash
        ORDER BY count DESC
        LIMIT 50
        FORMAT JSON

-- pipe:errors_by_type:fingerprint-scoped:baseline  [1a02650c]
SELECT
          toString(FingerprintHash) AS fingerprintHash,
          any(ErrorLabel) AS errorLabel,
          any(StatusMessage) AS sampleMessage,
          count() AS count,
          uniq(ServiceName) AS affectedServicesCount,
          min(Timestamp) AS firstSeen,
          max(Timestamp) AS lastSeen
        FROM error_events
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND DeploymentEnv IN ('production')
          AND FingerprintHash IN (toUInt64('11640393269246331608'))
        GROUP BY fingerprintHash
        ORDER BY count DESC
        LIMIT 1
        FORMAT JSON

-- pipe:errors_facets:default:baseline  [fe66f114]
SELECT
          ServiceName AS name,
          uniq(FingerprintHash) AS count,
          'service' AS facetType
        FROM error_events_by_time
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          DeploymentEnv AS name,
          uniq(FingerprintHash) AS count,
          'environment' AS facetType
        FROM error_events_by_time
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          ErrorLabel AS name,
          uniq(FingerprintHash) AS count,
          'error_type' AS facetType
        FROM error_events_by_time
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          ServiceVersion AS name,
          uniq(FingerprintHash) AS count,
          'version' AS facetType
        FROM error_events_by_time
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceVersion != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- pipe:errors_summary:default:baseline  [e28ab64c]
SELECT
          e.totalErrors AS totalErrors,
          s.totalSpans AS totalSpans,
          if(s.totalSpans > 0, round(e.totalErrors / s.totalSpans, 6), 0) AS errorRate,
          e.affectedServicesCount AS affectedServicesCount,
          e.affectedTracesCount AS affectedTracesCount
        FROM (SELECT
          count() AS totalErrors,
          uniq(ServiceName) AS affectedServicesCount,
          uniq(TraceId) AS affectedTracesCount
        FROM error_events_by_time
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00') AS e
        CROSS JOIN (SELECT
          sum(TraceCount) AS totalSpans
        FROM service_usage
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00') AS s
        FORMAT JSON

-- pipe:errors_timeseries:default:baseline  [8ea53a5e]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket,
          count() AS count
        FROM error_events
        WHERE OrgId = 'org_sql_catalog'
          AND FingerprintHash = toUInt64('11640393269246331608')
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- pipe:get_service_usage_compare:by-services:baseline  [3a119ef6]
SELECT 'current' AS period, * FROM (
SELECT
          ServiceName AS serviceName,
          sum(LogCount) AS totalLogCount,
          sum(LogSizeBytes) AS totalLogSizeBytes,
          sum(TraceCount) AS totalTraceCount,
          sum(TraceSizeBytes) AS totalTraceSizeBytes,
          sum(SumMetricCount) AS totalSumMetricCount,
          sum(SumMetricSizeBytes) AS totalSumMetricSizeBytes,
          sum(GaugeMetricCount) AS totalGaugeMetricCount,
          sum(GaugeMetricSizeBytes) AS totalGaugeMetricSizeBytes,
          sum(HistogramMetricCount) AS totalHistogramMetricCount,
          sum(HistogramMetricSizeBytes) AS totalHistogramMetricSizeBytes,
          sum(ExpHistogramMetricCount) AS totalExpHistogramMetricCount,
          sum(ExpHistogramMetricSizeBytes) AS totalExpHistogramMetricSizeBytes,
          sum(LogSizeBytes) + sum(TraceSizeBytes) + sum(SumMetricSizeBytes) + sum(GaugeMetricSizeBytes) + sum(HistogramMetricSizeBytes) + sum(ExpHistogramMetricSizeBytes) AS totalSizeBytes
        FROM service_usage
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND ServiceName IN ('api', 'checkout')
        GROUP BY serviceName
        ORDER BY totalSizeBytes DESC
)
UNION ALL
SELECT 'previous' AS period, * FROM (
SELECT
          ServiceName AS serviceName,
          sum(LogCount) AS totalLogCount,
          sum(LogSizeBytes) AS totalLogSizeBytes,
          sum(TraceCount) AS totalTraceCount,
          sum(TraceSizeBytes) AS totalTraceSizeBytes,
          sum(SumMetricCount) AS totalSumMetricCount,
          sum(SumMetricSizeBytes) AS totalSumMetricSizeBytes,
          sum(GaugeMetricCount) AS totalGaugeMetricCount,
          sum(GaugeMetricSizeBytes) AS totalGaugeMetricSizeBytes,
          sum(HistogramMetricCount) AS totalHistogramMetricCount,
          sum(HistogramMetricSizeBytes) AS totalHistogramMetricSizeBytes,
          sum(ExpHistogramMetricCount) AS totalExpHistogramMetricCount,
          sum(ExpHistogramMetricSizeBytes) AS totalExpHistogramMetricSizeBytes,
          sum(LogSizeBytes) + sum(TraceSizeBytes) + sum(SumMetricSizeBytes) + sum(GaugeMetricSizeBytes) + sum(HistogramMetricSizeBytes) + sum(ExpHistogramMetricSizeBytes) AS totalSizeBytes
        FROM service_usage
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= toStartOfHour(toDateTime('2025-12-30 10:30:00'))
          AND Hour <= toStartOfHour(toDateTime('2026-01-01 14:15:00'))
          AND ServiceName IN ('api', 'checkout')
        GROUP BY serviceName
        ORDER BY totalSizeBytes DESC
)
FORMAT JSON

-- pipe:get_service_usage_compare:default:baseline  [2d4d90c6]
SELECT 'current' AS period, * FROM (
SELECT
          ServiceName AS serviceName,
          sum(LogCount) AS totalLogCount,
          sum(LogSizeBytes) AS totalLogSizeBytes,
          sum(TraceCount) AS totalTraceCount,
          sum(TraceSizeBytes) AS totalTraceSizeBytes,
          sum(SumMetricCount) AS totalSumMetricCount,
          sum(SumMetricSizeBytes) AS totalSumMetricSizeBytes,
          sum(GaugeMetricCount) AS totalGaugeMetricCount,
          sum(GaugeMetricSizeBytes) AS totalGaugeMetricSizeBytes,
          sum(HistogramMetricCount) AS totalHistogramMetricCount,
          sum(HistogramMetricSizeBytes) AS totalHistogramMetricSizeBytes,
          sum(ExpHistogramMetricCount) AS totalExpHistogramMetricCount,
          sum(ExpHistogramMetricSizeBytes) AS totalExpHistogramMetricSizeBytes,
          sum(LogSizeBytes) + sum(TraceSizeBytes) + sum(SumMetricSizeBytes) + sum(GaugeMetricSizeBytes) + sum(HistogramMetricSizeBytes) + sum(ExpHistogramMetricSizeBytes) AS totalSizeBytes
        FROM service_usage
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND ServiceName = 'api'
        GROUP BY serviceName
        ORDER BY totalSizeBytes DESC
)
UNION ALL
SELECT 'previous' AS period, * FROM (
SELECT
          ServiceName AS serviceName,
          sum(LogCount) AS totalLogCount,
          sum(LogSizeBytes) AS totalLogSizeBytes,
          sum(TraceCount) AS totalTraceCount,
          sum(TraceSizeBytes) AS totalTraceSizeBytes,
          sum(SumMetricCount) AS totalSumMetricCount,
          sum(SumMetricSizeBytes) AS totalSumMetricSizeBytes,
          sum(GaugeMetricCount) AS totalGaugeMetricCount,
          sum(GaugeMetricSizeBytes) AS totalGaugeMetricSizeBytes,
          sum(HistogramMetricCount) AS totalHistogramMetricCount,
          sum(HistogramMetricSizeBytes) AS totalHistogramMetricSizeBytes,
          sum(ExpHistogramMetricCount) AS totalExpHistogramMetricCount,
          sum(ExpHistogramMetricSizeBytes) AS totalExpHistogramMetricSizeBytes,
          sum(LogSizeBytes) + sum(TraceSizeBytes) + sum(SumMetricSizeBytes) + sum(GaugeMetricSizeBytes) + sum(HistogramMetricSizeBytes) + sum(ExpHistogramMetricSizeBytes) AS totalSizeBytes
        FROM service_usage
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= toStartOfHour(toDateTime('2025-12-30 10:30:00'))
          AND Hour <= toStartOfHour(toDateTime('2026-01-01 14:15:00'))
          AND ServiceName = 'api'
        GROUP BY serviceName
        ORDER BY totalSizeBytes DESC
)
FORMAT JSON

-- pipe:get_service_usage:by-services:baseline  [a804ee75]
SELECT
          ServiceName AS serviceName,
          sum(LogCount) AS totalLogCount,
          sum(LogSizeBytes) AS totalLogSizeBytes,
          sum(TraceCount) AS totalTraceCount,
          sum(TraceSizeBytes) AS totalTraceSizeBytes,
          sum(SumMetricCount) AS totalSumMetricCount,
          sum(SumMetricSizeBytes) AS totalSumMetricSizeBytes,
          sum(GaugeMetricCount) AS totalGaugeMetricCount,
          sum(GaugeMetricSizeBytes) AS totalGaugeMetricSizeBytes,
          sum(HistogramMetricCount) AS totalHistogramMetricCount,
          sum(HistogramMetricSizeBytes) AS totalHistogramMetricSizeBytes,
          sum(ExpHistogramMetricCount) AS totalExpHistogramMetricCount,
          sum(ExpHistogramMetricSizeBytes) AS totalExpHistogramMetricSizeBytes,
          sum(LogSizeBytes) + sum(TraceSizeBytes) + sum(SumMetricSizeBytes) + sum(GaugeMetricSizeBytes) + sum(HistogramMetricSizeBytes) + sum(ExpHistogramMetricSizeBytes) AS totalSizeBytes
        FROM service_usage
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND ServiceName IN ('api', 'checkout')
        GROUP BY serviceName
        ORDER BY totalSizeBytes DESC
        FORMAT JSON

-- pipe:get_service_usage:default:baseline  [9baa30ad]
SELECT
          ServiceName AS serviceName,
          sum(LogCount) AS totalLogCount,
          sum(LogSizeBytes) AS totalLogSizeBytes,
          sum(TraceCount) AS totalTraceCount,
          sum(TraceSizeBytes) AS totalTraceSizeBytes,
          sum(SumMetricCount) AS totalSumMetricCount,
          sum(SumMetricSizeBytes) AS totalSumMetricSizeBytes,
          sum(GaugeMetricCount) AS totalGaugeMetricCount,
          sum(GaugeMetricSizeBytes) AS totalGaugeMetricSizeBytes,
          sum(HistogramMetricCount) AS totalHistogramMetricCount,
          sum(HistogramMetricSizeBytes) AS totalHistogramMetricSizeBytes,
          sum(ExpHistogramMetricCount) AS totalExpHistogramMetricCount,
          sum(ExpHistogramMetricSizeBytes) AS totalExpHistogramMetricSizeBytes,
          sum(LogSizeBytes) + sum(TraceSizeBytes) + sum(SumMetricSizeBytes) + sum(GaugeMetricSizeBytes) + sum(HistogramMetricSizeBytes) + sum(ExpHistogramMetricSizeBytes) AS totalSizeBytes
        FROM service_usage
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= toStartOfHour(toDateTime('2026-01-01 10:30:00'))
          AND Hour <= toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND ServiceName = 'api'
        GROUP BY serviceName
        ORDER BY totalSizeBytes DESC
        FORMAT JSON

-- pipe:list_logs:default:baseline  [2122d9b9]
SELECT
          Timestamp AS timestamp,
          SeverityText AS severityText,
          SeverityNumber AS severityNumber,
          ServiceName AS serviceName,
          Body AS body,
          TraceId AS traceId,
          SpanId AS spanId,
          hex(MD5(toJSONString(tuple(Timestamp, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body, ResourceSchemaUrl, ResourceAttributes, ScopeSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, LogAttributes)))) AS recordIdentity,
          toJSONString(LogAttributes) AS logAttributes,
          toJSONString(ResourceAttributes) AS resourceAttributes
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC, serviceName ASC, traceId ASC, spanId ASC, recordIdentity ASC
        LIMIT 50
        FORMAT JSON

-- pipe:list_logs:default:bloom  [2122d9b9]
SELECT
          Timestamp AS timestamp,
          SeverityText AS severityText,
          SeverityNumber AS severityNumber,
          ServiceName AS serviceName,
          Body AS body,
          TraceId AS traceId,
          SpanId AS spanId,
          hex(MD5(toJSONString(tuple(Timestamp, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body, ResourceSchemaUrl, ResourceAttributes, ScopeSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, LogAttributes)))) AS recordIdentity,
          toJSONString(LogAttributes) AS logAttributes,
          toJSONString(ResourceAttributes) AS resourceAttributes
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC, serviceName ASC, traceId ASC, spanId ASC, recordIdentity ASC
        LIMIT 50
        FORMAT JSON

-- pipe:list_logs:default:text  [2122d9b9]
SELECT
          Timestamp AS timestamp,
          SeverityText AS severityText,
          SeverityNumber AS severityNumber,
          ServiceName AS serviceName,
          Body AS body,
          TraceId AS traceId,
          SpanId AS spanId,
          hex(MD5(toJSONString(tuple(Timestamp, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body, ResourceSchemaUrl, ResourceAttributes, ScopeSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, LogAttributes)))) AS recordIdentity,
          toJSONString(LogAttributes) AS logAttributes,
          toJSONString(ResourceAttributes) AS resourceAttributes
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC, serviceName ASC, traceId ASC, spanId ASC, recordIdentity ASC
        LIMIT 50
        FORMAT JSON

-- pipe:list_logs:searched:baseline  [f4e5cc5d]
SELECT
          Timestamp AS timestamp,
          SeverityText AS severityText,
          SeverityNumber AS severityNumber,
          ServiceName AS serviceName,
          Body AS body,
          TraceId AS traceId,
          SpanId AS spanId,
          hex(MD5(toJSONString(tuple(Timestamp, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body, ResourceSchemaUrl, ResourceAttributes, ScopeSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, LogAttributes)))) AS recordIdentity,
          toJSONString(LogAttributes) AS logAttributes,
          toJSONString(ResourceAttributes) AS resourceAttributes
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND SeverityText = 'ERROR'
          AND TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND Body ILIKE '%connection refused%'
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND SeverityText = 'ERROR'
          AND TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND Body ILIKE '%connection refused%'
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC, serviceName ASC, traceId ASC, spanId ASC, recordIdentity ASC
        LIMIT 50
        FORMAT JSON

-- pipe:list_logs:searched:bloom  [efc50db5]
SELECT
          Timestamp AS timestamp,
          SeverityText AS severityText,
          SeverityNumber AS severityNumber,
          ServiceName AS serviceName,
          Body AS body,
          TraceId AS traceId,
          SpanId AS spanId,
          hex(MD5(toJSONString(tuple(Timestamp, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body, ResourceSchemaUrl, ResourceAttributes, ScopeSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, LogAttributes)))) AS recordIdentity,
          toJSONString(LogAttributes) AS logAttributes,
          toJSONString(ResourceAttributes) AS resourceAttributes
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND SeverityText = 'ERROR'
          AND TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND ((hasToken(lower(Body), 'connection') AND hasToken(lower(Body), 'refused')) AND Body ILIKE '%connection refused%')
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND SeverityText = 'ERROR'
          AND TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND ((hasToken(lower(Body), 'connection') AND hasToken(lower(Body), 'refused')) AND Body ILIKE '%connection refused%')
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC, serviceName ASC, traceId ASC, spanId ASC, recordIdentity ASC
        LIMIT 50
        FORMAT JSON

-- pipe:list_logs:searched:text  [fad2e4f1]
SELECT
          Timestamp AS timestamp,
          SeverityText AS severityText,
          SeverityNumber AS severityNumber,
          ServiceName AS serviceName,
          Body AS body,
          TraceId AS traceId,
          SpanId AS spanId,
          hex(MD5(toJSONString(tuple(Timestamp, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body, ResourceSchemaUrl, ResourceAttributes, ScopeSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, LogAttributes)))) AS recordIdentity,
          toJSONString(LogAttributes) AS logAttributes,
          toJSONString(ResourceAttributes) AS resourceAttributes
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND SeverityText = 'ERROR'
          AND TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND (hasAllTokens(lower(Body), 'connection refused') AND Body ILIKE '%connection refused%')
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND SeverityText = 'ERROR'
          AND TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND (hasAllTokens(lower(Body), 'connection refused') AND Body ILIKE '%connection refused%')
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC, serviceName ASC, traceId ASC, spanId ASC, recordIdentity ASC
        LIMIT 50
        FORMAT JSON

-- pipe:list_metrics:default:baseline  [024f8bd8]
SELECT
          MetricName AS metricName,
          MetricType AS metricType,
          ServiceName AS serviceName,
          any(MetricDescription) AS metricDescription,
          any(MetricUnit) AS metricUnit,
          sum(DataPointCount) AS dataPointCount,
          min(FirstSeen) AS firstSeen,
          max(LastSeen) AS lastSeen,
          any(IsMonotonic) AS isMonotonic
        FROM metric_catalog
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= toStartOfInterval(toDateTime('2026-01-01 10:30:00'), INTERVAL 3600 SECOND)
          AND Hour <= '2026-01-03 14:15:00'
        GROUP BY metricName, metricType, serviceName
        ORDER BY lastSeen DESC, metricName ASC, metricType ASC, serviceName ASC
        LIMIT 100
        OFFSET 0
        FORMAT JSON

-- pipe:list_traces:contains-match:baseline  [15600e4e]
SELECT
          TraceId AS traceId,
          Timestamp AS startTime,
          Timestamp AS endTime,
          intDiv(Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [ServiceName] AS services,
          SpanName AS rootSpanName,
          SpanKind AS rootSpanKind,
          StatusCode AS rootSpanStatusCode,
          SpanAttributes['http.method'] AS rootHttpMethod,
          SpanAttributes['http.route'] AS rootHttpRoute,
          SpanAttributes['http.status_code'] AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(ServiceName, 'ap') > 0
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode != 'Error'
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(ServiceName, 'ap') > 0
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode != 'Error'
        ORDER BY ts DESC
        LIMIT 100))
        ORDER BY startTime DESC
        LIMIT 100
        FORMAT JSON

-- pipe:list_traces:contains-match:bloom  [15600e4e]
SELECT
          TraceId AS traceId,
          Timestamp AS startTime,
          Timestamp AS endTime,
          intDiv(Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [ServiceName] AS services,
          SpanName AS rootSpanName,
          SpanKind AS rootSpanKind,
          StatusCode AS rootSpanStatusCode,
          SpanAttributes['http.method'] AS rootHttpMethod,
          SpanAttributes['http.route'] AS rootHttpRoute,
          SpanAttributes['http.status_code'] AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(ServiceName, 'ap') > 0
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode != 'Error'
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(ServiceName, 'ap') > 0
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode != 'Error'
        ORDER BY ts DESC
        LIMIT 100))
        ORDER BY startTime DESC
        LIMIT 100
        FORMAT JSON

-- pipe:list_traces:contains-match:text  [15600e4e]
SELECT
          TraceId AS traceId,
          Timestamp AS startTime,
          Timestamp AS endTime,
          intDiv(Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [ServiceName] AS services,
          SpanName AS rootSpanName,
          SpanKind AS rootSpanKind,
          StatusCode AS rootSpanStatusCode,
          SpanAttributes['http.method'] AS rootHttpMethod,
          SpanAttributes['http.route'] AS rootHttpRoute,
          SpanAttributes['http.status_code'] AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(ServiceName, 'ap') > 0
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode != 'Error'
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(ServiceName, 'ap') > 0
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode != 'Error'
        ORDER BY ts DESC
        LIMIT 100))
        ORDER BY startTime DESC
        LIMIT 100
        FORMAT JSON

-- pipe:list_traces:default:baseline  [845d8dde]
SELECT
          TraceId AS traceId,
          Timestamp AS startTime,
          Timestamp AS endTime,
          intDiv(Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [ServiceName] AS services,
          SpanName AS rootSpanName,
          SpanKind AS rootSpanKind,
          StatusCode AS rootSpanStatusCode,
          SpanAttributes['http.method'] AS rootHttpMethod,
          SpanAttributes['http.route'] AS rootHttpRoute,
          SpanAttributes['http.status_code'] AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode != 'Error'
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode != 'Error'
        ORDER BY ts DESC
        LIMIT 100))
        ORDER BY startTime DESC
        LIMIT 100
        FORMAT JSON

-- pipe:list_traces:default:bloom  [845d8dde]
SELECT
          TraceId AS traceId,
          Timestamp AS startTime,
          Timestamp AS endTime,
          intDiv(Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [ServiceName] AS services,
          SpanName AS rootSpanName,
          SpanKind AS rootSpanKind,
          StatusCode AS rootSpanStatusCode,
          SpanAttributes['http.method'] AS rootHttpMethod,
          SpanAttributes['http.route'] AS rootHttpRoute,
          SpanAttributes['http.status_code'] AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode != 'Error'
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode != 'Error'
        ORDER BY ts DESC
        LIMIT 100))
        ORDER BY startTime DESC
        LIMIT 100
        FORMAT JSON

-- pipe:list_traces:default:text  [845d8dde]
SELECT
          TraceId AS traceId,
          Timestamp AS startTime,
          Timestamp AS endTime,
          intDiv(Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [ServiceName] AS services,
          SpanName AS rootSpanName,
          SpanKind AS rootSpanKind,
          StatusCode AS rootSpanStatusCode,
          SpanAttributes['http.method'] AS rootHttpMethod,
          SpanAttributes['http.route'] AS rootHttpRoute,
          SpanAttributes['http.status_code'] AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode != 'Error'
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode != 'Error'
        ORDER BY ts DESC
        LIMIT 100))
        ORDER BY startTime DESC
        LIMIT 100
        FORMAT JSON

-- pipe:list_traces:filtered:baseline  [5702a482]
SELECT
          TraceId AS traceId,
          Timestamp AS startTime,
          Timestamp AS endTime,
          intDiv(Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [ServiceName] AS services,
          SpanName AS rootSpanName,
          SpanKind AS rootSpanKind,
          StatusCode AS rootSpanStatusCode,
          SpanAttributes['http.method'] AS rootHttpMethod,
          SpanAttributes['http.route'] AS rootHttpRoute,
          SpanAttributes['http.status_code'] AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND (SpanName = 'GET /v1/x' OR if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) = 'GET /v1/x')
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode = 'Error'
          AND Duration >= 5000000
          AND Duration <= 5000000000
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET'
          AND ResourceAttributes['service.namespace'] = 'core'
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND (SpanName = 'GET /v1/x' OR if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) = 'GET /v1/x')
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode = 'Error'
          AND Duration >= 5000000
          AND Duration <= 5000000000
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET'
          AND ResourceAttributes['service.namespace'] = 'core'
        ORDER BY ts DESC
        LIMIT 25))
        ORDER BY startTime DESC
        LIMIT 25
        FORMAT JSON

-- pipe:list_traces:filtered:bloom  [14239a36]
SELECT
          TraceId AS traceId,
          Timestamp AS startTime,
          Timestamp AS endTime,
          intDiv(Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [ServiceName] AS services,
          SpanName AS rootSpanName,
          SpanKind AS rootSpanKind,
          StatusCode AS rootSpanStatusCode,
          SpanAttributes['http.method'] AS rootHttpMethod,
          SpanAttributes['http.route'] AS rootHttpRoute,
          SpanAttributes['http.status_code'] AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND (SpanName = 'GET /v1/x' OR if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) = 'GET /v1/x')
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode = 'Error'
          AND Duration >= 5000000
          AND Duration <= 5000000000
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND (((has(mapKeys(SpanAttributes), 'http.method') OR has(mapKeys(SpanAttributes), 'http.request.method')) AND has(mapValues(SpanAttributes), 'GET')) AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET')
          AND ((has(mapKeys(ResourceAttributes), 'service.namespace') AND has(mapValues(ResourceAttributes), 'core')) AND ResourceAttributes['service.namespace'] = 'core')
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND (SpanName = 'GET /v1/x' OR if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) = 'GET /v1/x')
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode = 'Error'
          AND Duration >= 5000000
          AND Duration <= 5000000000
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND (((has(mapKeys(SpanAttributes), 'http.method') OR has(mapKeys(SpanAttributes), 'http.request.method')) AND has(mapValues(SpanAttributes), 'GET')) AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET')
          AND ((has(mapKeys(ResourceAttributes), 'service.namespace') AND has(mapValues(ResourceAttributes), 'core')) AND ResourceAttributes['service.namespace'] = 'core')
        ORDER BY ts DESC
        LIMIT 25))
        ORDER BY startTime DESC
        LIMIT 25
        FORMAT JSON

-- pipe:list_traces:filtered:text  [2303278a]
SELECT
          TraceId AS traceId,
          Timestamp AS startTime,
          Timestamp AS endTime,
          intDiv(Duration, 1000) AS durationMicros,
          toUInt64(1) AS spanCount,
          [ServiceName] AS services,
          SpanName AS rootSpanName,
          SpanKind AS rootSpanKind,
          StatusCode AS rootSpanStatusCode,
          SpanAttributes['http.method'] AS rootHttpMethod,
          SpanAttributes['http.route'] AS rootHttpRoute,
          SpanAttributes['http.status_code'] AS rootHttpStatusCode,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])) AS rootSpanAttributes,
          if(StatusCode = 'Error', 1, 0) AS hasError
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND (SpanName = 'GET /v1/x' OR if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) = 'GET /v1/x')
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode = 'Error'
          AND Duration >= 5000000
          AND Duration <= 5000000000
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND ((has(SpanAttributeItems, concat('http.method', char(31), 'GET')) OR has(SpanAttributeItems, concat('http.request.method', char(31), 'GET'))) AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET')
          AND (has(ResourceAttributeItems, concat('service.namespace', char(31), 'core')) AND ResourceAttributes['service.namespace'] = 'core')
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND (SpanName = 'GET /v1/x' OR if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) = 'GET /v1/x')
          AND (SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')
          AND StatusCode = 'Error'
          AND Duration >= 5000000
          AND Duration <= 5000000000
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND ((has(SpanAttributeItems, concat('http.method', char(31), 'GET')) OR has(SpanAttributeItems, concat('http.request.method', char(31), 'GET'))) AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET')
          AND (has(ResourceAttributeItems, concat('service.namespace', char(31), 'core')) AND ResourceAttributes['service.namespace'] = 'core')
        ORDER BY ts DESC
        LIMIT 25))
        ORDER BY startTime DESC
        LIMIT 25
        FORMAT JSON

-- pipe:logs_count:default:baseline  [96214c48]
SELECT
          sum(total) AS total
        FROM (
SELECT
          count() AS total
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
UNION ALL
SELECT
          sum(Count) AS total
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
) AS counts
        FORMAT JSON

-- pipe:logs_count:default:bloom  [96214c48]
SELECT
          sum(total) AS total
        FROM (
SELECT
          count() AS total
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
UNION ALL
SELECT
          sum(Count) AS total
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
) AS counts
        FORMAT JSON

-- pipe:logs_count:default:text  [96214c48]
SELECT
          sum(total) AS total
        FROM (
SELECT
          count() AS total
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
UNION ALL
SELECT
          sum(Count) AS total
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
) AS counts
        FORMAT JSON

-- pipe:logs_count:searched:baseline  [6c5b910d]
SELECT
          count() AS total
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Body ILIKE '%timeout%'
        FORMAT JSON

-- pipe:logs_count:searched:bloom  [6c5b910d]
SELECT
          count() AS total
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Body ILIKE '%timeout%'
        FORMAT JSON

-- pipe:logs_count:searched:text  [6c5b910d]
SELECT
          count() AS total
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND Body ILIKE '%timeout%'
        FORMAT JSON

-- pipe:logs_facets:default:baseline  [14a32e81]
SELECT * FROM (
SELECT
          SeverityText AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(Count) AS count,
          'severity' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
        GROUP BY severityText
UNION ALL
SELECT
          '' AS severityText,
          ServiceName AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(Count) AS count,
          'service' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
        GROUP BY serviceName
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          DeploymentEnv AS deploymentEnv,
          '' AS namespace,
          sum(Count) AS count,
          'deploymentEnv' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND DeploymentEnv != ''
        GROUP BY deploymentEnv
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          ServiceNamespace AS namespace,
          sum(Count) AS count,
          'namespace' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND ServiceNamespace != ''
        GROUP BY namespace
)
ORDER BY count DESC
LIMIT 500
FORMAT JSON

-- pipe:logs_facets:default:bloom  [14a32e81]
SELECT * FROM (
SELECT
          SeverityText AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(Count) AS count,
          'severity' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
        GROUP BY severityText
UNION ALL
SELECT
          '' AS severityText,
          ServiceName AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(Count) AS count,
          'service' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
        GROUP BY serviceName
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          DeploymentEnv AS deploymentEnv,
          '' AS namespace,
          sum(Count) AS count,
          'deploymentEnv' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND DeploymentEnv != ''
        GROUP BY deploymentEnv
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          ServiceNamespace AS namespace,
          sum(Count) AS count,
          'namespace' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND ServiceNamespace != ''
        GROUP BY namespace
)
ORDER BY count DESC
LIMIT 500
FORMAT JSON

-- pipe:logs_facets:default:text  [14a32e81]
SELECT * FROM (
SELECT
          SeverityText AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(Count) AS count,
          'severity' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
        GROUP BY severityText
UNION ALL
SELECT
          '' AS severityText,
          ServiceName AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(Count) AS count,
          'service' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
        GROUP BY serviceName
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          DeploymentEnv AS deploymentEnv,
          '' AS namespace,
          sum(Count) AS count,
          'deploymentEnv' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND DeploymentEnv != ''
        GROUP BY deploymentEnv
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          ServiceNamespace AS namespace,
          sum(Count) AS count,
          'namespace' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND ServiceNamespace != ''
        GROUP BY namespace
)
ORDER BY count DESC
LIMIT 500
FORMAT JSON

-- pipe:metric_attribute_keys:default:baseline  [f2e10453]
SELECT
          AttributeKey AS attributeKey,
          sum(UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'metric'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:metric_attribute_keys:metric-scoped:baseline  [67ceada2]
SELECT
          arrayJoin(mapKeys(Attributes)) AS attributeKey,
          count() AS usageCount
        FROM metrics_histogram
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName = 'http.server.duration'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:metric_attribute_values:default:baseline  [522791bf]
SELECT
          AttributeValue AS attributeValue,
          sum(UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'metric'
          AND AttributeKey = 'http.route'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:metric_attribute_values:metric-scoped:baseline  [7110579a]
SELECT
          Attributes['http.route'] AS attributeValue,
          count() AS usageCount
        FROM metrics_histogram
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName = 'http.server.duration'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND Attributes['http.route'] != ''
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:metrics_summary:default:baseline  [d5f7c1e5]
SELECT
          MetricType AS metricType,
          uniq(MetricName) AS metricCount,
          sum(DataPointCount) AS dataPointCount
        FROM metric_catalog
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= toStartOfInterval(toDateTime('2026-01-01 10:30:00'), INTERVAL 3600 SECOND)
          AND Hour <= '2026-01-03 14:15:00'
        GROUP BY metricType
        FORMAT JSON

-- pipe:resource_attribute_keys:default:baseline  [f2e10453]
SELECT
          AttributeKey AS attributeKey,
          sum(UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'resource'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:resource_attribute_keys:default:bloom  [f2e10453]
SELECT
          AttributeKey AS attributeKey,
          sum(UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'resource'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:resource_attribute_keys:default:text  [f2e10453]
SELECT
          AttributeKey AS attributeKey,
          sum(UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'resource'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:resource_attribute_values:default:baseline  [522791bf]
SELECT
          AttributeValue AS attributeValue,
          sum(UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'resource'
          AND AttributeKey = 'service.namespace'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:resource_attribute_values:default:bloom  [522791bf]
SELECT
          AttributeValue AS attributeValue,
          sum(UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'resource'
          AND AttributeKey = 'service.namespace'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:resource_attribute_values:default:text  [522791bf]
SELECT
          AttributeValue AS attributeValue,
          sum(UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'resource'
          AND AttributeKey = 'service.namespace'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:service_apdex_time_series:custom-threshold:baseline  [b27c4edd]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket,
          count() AS totalCount,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 250)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 250 AND Duration / 1000000 < 1000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 250)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 250 AND Duration / 1000000 < 1000))) * 0.5 / count(), 4), 0) AS apdexScore
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- pipe:service_apdex_time_series:default:baseline  [2ecafa98]
SELECT
          toStartOfInterval(bBucket, INTERVAL 60 SECOND) AS bucket,
          sum(bSpanCount) AS totalCount,
          sum(bApdexSatisfiedCount) AS satisfiedCount,
          sum(bApdexToleratingCount) AS toleratingCount,
          if(sum(bSpanCount) > 0, round(sum(bApdexSatisfiedCount) / sum(bSpanCount) + sum(bApdexToleratingCount) * 0.5 / sum(bSpanCount), 4), 0) AS apdexScore
        FROM (
SELECT
          toStartOfMinute(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Minute AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_minutely
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY bucket
        ORDER BY bucket ASC
        FORMAT JSON

-- pipe:service_dependencies:default:baseline  [89695720]
SELECT
          sourceService AS sourceService,
          targetService AS targetService,
          sum(bucketCallCount) AS callCount,
          sum(bucketErrorCount) AS errorCount,
          sum(bucketDurationSumMs) / nullIf(sum(bucketCallCount), 0) AS avgDurationMs,
          max(bucketMaxDurationMs) AS maxDurationMs,
          sum(bucketEstimatedSpanCount) AS estimatedSpanCount
        FROM (
SELECT
          SourceService AS sourceService,
          TargetService AS targetService,
          sum(CallCount) AS bucketCallCount,
          sum(ErrorCount) AS bucketErrorCount,
          sum(DurationSumMs) AS bucketDurationSumMs,
          max(MaxDurationMs) AS bucketMaxDurationMs,
          sum(if(SampleRateSum > 0, SampleRateSum, toFloat64(CallCount))) AS bucketEstimatedSpanCount
        FROM service_map_edges_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND DeploymentEnv = 'production'
        GROUP BY sourceService, targetService
UNION ALL
SELECT
          p.ServiceName AS sourceService,
          c.ServiceName AS targetService,
          count() AS bucketCallCount,
          countIf(c.StatusCode = 'Error') AS bucketErrorCount,
          sum(c.Duration / 1000000) AS bucketDurationSumMs,
          max(c.Duration / 1000000) AS bucketMaxDurationMs,
          sum(multiIf(match(c.TraceState, 'th:[0-9a-f]+'), 1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001), 1.0)) AS bucketEstimatedSpanCount
        FROM (SELECT
          OrgId AS OrgId,
          Timestamp AS Timestamp,
          TraceId AS TraceId,
          SpanId AS SpanId,
          ServiceName AS ServiceName,
          DeploymentEnv AS DeploymentEnv
        FROM service_map_spans
        WHERE SpanKind IN ('Client', 'Producer')
          AND Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp < toDateTime('2026-01-03 14:15:00')
          AND OrgId = 'org_sql_catalog'
          AND DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))) AS p
        INNER JOIN (SELECT
          TraceId AS TraceId,
          ParentSpanId AS ParentSpanId,
          ServiceName AS ServiceName,
          Duration AS Duration,
          StatusCode AS StatusCode,
          TraceState AS TraceState
        FROM service_map_children
        WHERE Timestamp >= toDateTime('2026-01-01 10:30:00')
          AND Timestamp < toDateTime('2026-01-03 14:15:00')
          AND OrgId = 'org_sql_catalog'
          AND DeploymentEnv = 'production'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))) AS c ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)
        WHERE p.ServiceName != c.ServiceName
        GROUP BY sourceService, targetService
) AS edges
        GROUP BY sourceService, targetService
        ORDER BY callCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:service_overview_compare:default:baseline  [e5fa9dec]
SELECT 'current' AS period, * FROM (
SELECT
          cServiceName AS serviceName,
          cEnvironment AS environment,
          argMax(cServiceNamespace, cEstimatedSpanCount) AS serviceNamespace,
          sum(cSpanCount) AS throughput,
          sum(cErrorCount) AS errorCount,
          sum(cEstimatedErrorCount) AS estimatedErrorCount,
          sum(cSpanCount) AS spanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(cEstimatedSpanCount) AS estimatedSpanCount,
          min(cFirstSeen) AS firstSeen,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(cCommitSha, cSpanCount, cErrorCount, toString(cFirstSeen)))), 1, 20) AS commits
        FROM (SELECT
          bServiceName AS cServiceName,
          bServiceNamespace AS cServiceNamespace,
          bEnvironment AS cEnvironment,
          bCommitSha AS cCommitSha,
          sum(bSpanCount) AS cSpanCount,
          sum(bErrorCount) AS cErrorCount,
          sum(bEstimatedErrorCount) AS cEstimatedErrorCount,
          sum(bEstimatedSpanCount) AS cEstimatedSpanCount,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(bDurationQuantiles) AS cDurationQuantiles,
          min(bFirstSeen) AS cFirstSeen
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY cServiceName, cServiceNamespace, cEnvironment, cCommitSha) AS service_commit_rows
        GROUP BY serviceName, environment
        ORDER BY throughput DESC
        LIMIT 500
)
UNION ALL
SELECT 'previous' AS period, * FROM (
SELECT
          cServiceName AS serviceName,
          cEnvironment AS environment,
          argMax(cServiceNamespace, cEstimatedSpanCount) AS serviceNamespace,
          sum(cSpanCount) AS throughput,
          sum(cErrorCount) AS errorCount,
          sum(cEstimatedErrorCount) AS estimatedErrorCount,
          sum(cSpanCount) AS spanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(cEstimatedSpanCount) AS estimatedSpanCount,
          min(cFirstSeen) AS firstSeen,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(cCommitSha, cSpanCount, cErrorCount, toString(cFirstSeen)))), 1, 20) AS commits
        FROM (SELECT
          bServiceName AS cServiceName,
          bServiceNamespace AS cServiceNamespace,
          bEnvironment AS cEnvironment,
          bCommitSha AS cCommitSha,
          sum(bSpanCount) AS cSpanCount,
          sum(bErrorCount) AS cErrorCount,
          sum(bEstimatedErrorCount) AS cEstimatedErrorCount,
          sum(bEstimatedSpanCount) AS cEstimatedSpanCount,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(bDurationQuantiles) AS cDurationQuantiles,
          min(bFirstSeen) AS cFirstSeen
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2025-12-30 10:30:00'
          AND Timestamp <= '2026-01-01 14:15:00'
          AND (Timestamp < if(toDateTime('2025-12-30 10:30:00') = toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-01 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2025-12-30 10:30:00') = toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-01 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY cServiceName, cServiceNamespace, cEnvironment, cCommitSha) AS service_commit_rows
        GROUP BY serviceName, environment
        ORDER BY throughput DESC
        LIMIT 500
)
FORMAT JSON

-- pipe:service_overview_compare:namespace-scoped:baseline  [bda7caf4]
SELECT 'current' AS period, * FROM (
SELECT
          cServiceName AS serviceName,
          cEnvironment AS environment,
          argMax(cServiceNamespace, cEstimatedSpanCount) AS serviceNamespace,
          sum(cSpanCount) AS throughput,
          sum(cErrorCount) AS errorCount,
          sum(cEstimatedErrorCount) AS estimatedErrorCount,
          sum(cSpanCount) AS spanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(cEstimatedSpanCount) AS estimatedSpanCount,
          min(cFirstSeen) AS firstSeen,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(cCommitSha, cSpanCount, cErrorCount, toString(cFirstSeen)))), 1, 20) AS commits
        FROM (SELECT
          bServiceName AS cServiceName,
          bServiceNamespace AS cServiceNamespace,
          bEnvironment AS cEnvironment,
          bCommitSha AS cCommitSha,
          sum(bSpanCount) AS cSpanCount,
          sum(bErrorCount) AS cErrorCount,
          sum(bEstimatedErrorCount) AS cEstimatedErrorCount,
          sum(bEstimatedSpanCount) AS cEstimatedSpanCount,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(bDurationQuantiles) AS cDurationQuantiles,
          min(bFirstSeen) AS cFirstSeen
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND DeploymentEnv IN ('production')
          AND ServiceNamespace IN ('commerce')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND DeploymentEnv IN ('production')
          AND ServiceNamespace IN ('commerce')
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY cServiceName, cServiceNamespace, cEnvironment, cCommitSha) AS service_commit_rows
        GROUP BY serviceName, environment
        ORDER BY throughput DESC
        LIMIT 500
)
UNION ALL
SELECT 'previous' AS period, * FROM (
SELECT
          cServiceName AS serviceName,
          cEnvironment AS environment,
          argMax(cServiceNamespace, cEstimatedSpanCount) AS serviceNamespace,
          sum(cSpanCount) AS throughput,
          sum(cErrorCount) AS errorCount,
          sum(cEstimatedErrorCount) AS estimatedErrorCount,
          sum(cSpanCount) AS spanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(cEstimatedSpanCount) AS estimatedSpanCount,
          min(cFirstSeen) AS firstSeen,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(cCommitSha, cSpanCount, cErrorCount, toString(cFirstSeen)))), 1, 20) AS commits
        FROM (SELECT
          bServiceName AS cServiceName,
          bServiceNamespace AS cServiceNamespace,
          bEnvironment AS cEnvironment,
          bCommitSha AS cCommitSha,
          sum(bSpanCount) AS cSpanCount,
          sum(bErrorCount) AS cErrorCount,
          sum(bEstimatedErrorCount) AS cEstimatedErrorCount,
          sum(bEstimatedSpanCount) AS cEstimatedSpanCount,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(bDurationQuantiles) AS cDurationQuantiles,
          min(bFirstSeen) AS cFirstSeen
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2025-12-30 10:30:00'
          AND Timestamp <= '2026-01-01 14:15:00'
          AND DeploymentEnv IN ('production')
          AND ServiceNamespace IN ('commerce')
          AND (Timestamp < if(toDateTime('2025-12-30 10:30:00') = toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-01 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND DeploymentEnv IN ('production')
          AND ServiceNamespace IN ('commerce')
          AND Hour >= if(toDateTime('2025-12-30 10:30:00') = toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')), toStartOfHour(toDateTime('2025-12-30 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-01 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY cServiceName, cServiceNamespace, cEnvironment, cCommitSha) AS service_commit_rows
        GROUP BY serviceName, environment
        ORDER BY throughput DESC
        LIMIT 500
)
FORMAT JSON

-- pipe:service_overview:default:baseline  [90dbc028]
SELECT
          cServiceName AS serviceName,
          cEnvironment AS environment,
          argMax(cServiceNamespace, cEstimatedSpanCount) AS serviceNamespace,
          sum(cSpanCount) AS throughput,
          sum(cErrorCount) AS errorCount,
          sum(cEstimatedErrorCount) AS estimatedErrorCount,
          sum(cSpanCount) AS spanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(cEstimatedSpanCount) AS estimatedSpanCount,
          min(cFirstSeen) AS firstSeen,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(cCommitSha, cSpanCount, cErrorCount, toString(cFirstSeen)))), 1, 20) AS commits
        FROM (SELECT
          bServiceName AS cServiceName,
          bServiceNamespace AS cServiceNamespace,
          bEnvironment AS cEnvironment,
          bCommitSha AS cCommitSha,
          sum(bSpanCount) AS cSpanCount,
          sum(bErrorCount) AS cErrorCount,
          sum(bEstimatedErrorCount) AS cEstimatedErrorCount,
          sum(bEstimatedSpanCount) AS cEstimatedSpanCount,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(bDurationQuantiles) AS cDurationQuantiles,
          min(bFirstSeen) AS cFirstSeen
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY cServiceName, cServiceNamespace, cEnvironment, cCommitSha) AS service_commit_rows
        GROUP BY serviceName, environment
        ORDER BY throughput DESC
        LIMIT 500
        FORMAT JSON

-- pipe:service_overview:filtered:baseline  [b3ddd260]
SELECT
          cServiceName AS serviceName,
          cEnvironment AS environment,
          argMax(cServiceNamespace, cEstimatedSpanCount) AS serviceNamespace,
          sum(cSpanCount) AS throughput,
          sum(cErrorCount) AS errorCount,
          sum(cEstimatedErrorCount) AS estimatedErrorCount,
          sum(cSpanCount) AS spanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(cEstimatedSpanCount) AS estimatedSpanCount,
          min(cFirstSeen) AS firstSeen,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(cCommitSha, cSpanCount, cErrorCount, toString(cFirstSeen)))), 1, 20) AS commits
        FROM (SELECT
          bServiceName AS cServiceName,
          bServiceNamespace AS cServiceNamespace,
          bEnvironment AS cEnvironment,
          bCommitSha AS cCommitSha,
          sum(bSpanCount) AS cSpanCount,
          sum(bErrorCount) AS cErrorCount,
          sum(bEstimatedErrorCount) AS cEstimatedErrorCount,
          sum(bEstimatedSpanCount) AS cEstimatedSpanCount,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(bDurationQuantiles) AS cDurationQuantiles,
          min(bFirstSeen) AS cFirstSeen
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND DeploymentEnv IN ('production', 'staging')
          AND CommitSha IN ('abc123', 'def456')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND DeploymentEnv IN ('production', 'staging')
          AND CommitSha IN ('abc123', 'def456')
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY cServiceName, cServiceNamespace, cEnvironment, cCommitSha) AS service_commit_rows
        GROUP BY serviceName, environment
        ORDER BY throughput DESC
        LIMIT 500
        FORMAT JSON

-- pipe:service_overview:namespace-scoped:baseline  [549602bc]
SELECT
          cServiceName AS serviceName,
          cEnvironment AS environment,
          argMax(cServiceNamespace, cEstimatedSpanCount) AS serviceNamespace,
          sum(cSpanCount) AS throughput,
          sum(cErrorCount) AS errorCount,
          sum(cEstimatedErrorCount) AS estimatedErrorCount,
          sum(cSpanCount) AS spanCount,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 1) / 1000000 AS p50LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 2) / 1000000 AS p95LatencyMs,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(cDurationQuantiles), 3) / 1000000 AS p99LatencyMs,
          sum(cEstimatedSpanCount) AS estimatedSpanCount,
          min(cFirstSeen) AS firstSeen,
          arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(cCommitSha, cSpanCount, cErrorCount, toString(cFirstSeen)))), 1, 20) AS commits
        FROM (SELECT
          bServiceName AS cServiceName,
          bServiceNamespace AS cServiceNamespace,
          bEnvironment AS cEnvironment,
          bCommitSha AS cCommitSha,
          sum(bSpanCount) AS cSpanCount,
          sum(bErrorCount) AS cErrorCount,
          sum(bEstimatedErrorCount) AS cEstimatedErrorCount,
          sum(bEstimatedSpanCount) AS cEstimatedSpanCount,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(bDurationQuantiles) AS cDurationQuantiles,
          min(bFirstSeen) AS cFirstSeen
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND DeploymentEnv IN ('production')
          AND ServiceNamespace IN ('commerce', 'edge')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND DeploymentEnv IN ('production')
          AND ServiceNamespace IN ('commerce', 'edge')
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        GROUP BY cServiceName, cServiceNamespace, cEnvironment, cCommitSha) AS service_commit_rows
        GROUP BY serviceName, environment
        ORDER BY throughput DESC
        LIMIT 500
        FORMAT JSON

-- pipe:service_releases_timeline:default:baseline  [d8c35e6b]
SELECT
          toStartOfInterval(bBucket, INTERVAL 300 SECOND) AS bucket,
          bCommitSha AS commitSha,
          sum(bSpanCount) AS count,
          sum(bErrorCount) AS errorCount
        FROM (
SELECT
          toStartOfMinute(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Minute AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_minutely
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE bCommitSha != ''
        GROUP BY bucket, commitSha
        ORDER BY bucket ASC
        LIMIT 1000
        FORMAT JSON

-- pipe:services_facets:default:baseline  [d6b6158c]
SELECT
          bEnvironment AS name,
          sum(bSpanCount) AS count,
          'environment' AS facetType
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE bEnvironment != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          bServiceNamespace AS name,
          sum(bSpanCount) AS count,
          'namespace' AS facetType
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE bServiceNamespace != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          bCommitSha AS name,
          sum(bSpanCount) AS count,
          'commit_sha' AS facetType
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE bCommitSha != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          bServiceName AS name,
          sum(bSpanCount) AS count,
          'service' AS facetType
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE bServiceName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- pipe:slow_traces:default:baseline  [6d14854f]
SELECT
          TraceId AS traceId,
          SpanName AS spanName,
          ServiceName AS serviceName,
          Duration / 1000000 AS durationMs,
          StatusCode AS statusCode,
          toString(Timestamp) AS timestamp
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
        ORDER BY durationMs DESC
        LIMIT 10
        FORMAT JSON

-- pipe:span_attribute_keys:default:baseline  [f2e10453]
SELECT
          AttributeKey AS attributeKey,
          sum(UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'span'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:span_attribute_keys:default:bloom  [f2e10453]
SELECT
          AttributeKey AS attributeKey,
          sum(UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'span'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:span_attribute_keys:default:text  [f2e10453]
SELECT
          AttributeKey AS attributeKey,
          sum(UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'span'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- pipe:span_attribute_values:default:baseline  [522791bf]
SELECT
          AttributeValue AS attributeValue,
          sum(UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'span'
          AND AttributeKey = 'http.method'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:span_attribute_values:default:bloom  [522791bf]
SELECT
          AttributeValue AS attributeValue,
          sum(UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'span'
          AND AttributeKey = 'http.method'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:span_attribute_values:default:text  [522791bf]
SELECT
          AttributeValue AS attributeValue,
          sum(UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'span'
          AND AttributeKey = 'http.method'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- pipe:span_hierarchy:unwindowed:baseline  [29ddf75d]
SELECT
          TraceId AS traceId,
          SpanId AS spanId,
          ParentSpanId AS parentSpanId,
          if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) AS spanName,
          ServiceName AS serviceName,
          SpanKind AS spanKind,
          Duration / 1000000 AS durationMs,
          Timestamp AS startTime,
          StatusCode AS statusCode,
          StatusMessage AS statusMessage,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'url.full', SpanAttributes['url.full'], 'http.url', SpanAttributes['http.url'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'url.path', SpanAttributes['url.path'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'cache.system', SpanAttributes['cache.system'], 'cache.result', SpanAttributes['cache.result'], 'cache.name', SpanAttributes['cache.name'], 'cache.operation', SpanAttributes['cache.operation'], 'cache.lookup_performed', SpanAttributes['cache.lookup_performed'], 'db.system.name', SpanAttributes['db.system.name'], 'db.system', SpanAttributes['db.system'], 'cloud.platform', SpanAttributes['cloud.platform'], 'cloudflare.colo', SpanAttributes['cloudflare.colo'], 'faas.invoked_region', SpanAttributes['faas.invoked_region'], 'cloudflare.outcome', SpanAttributes['cloudflare.outcome'])) AS spanAttributes,
          toJSONString(map('deployment.environment', ResourceAttributes['deployment.environment'], 'vcs.ref.head.revision', ResourceAttributes['vcs.ref.head.revision'])) AS resourceAttributes,
          'related' AS relationship
        FROM trace_detail_spans
        WHERE TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND OrgId = 'org_sql_catalog'
        ORDER BY startTime ASC
        LIMIT 5000
        FORMAT JSON

-- pipe:span_hierarchy:windowed:baseline  [58d61ffb]
SELECT
          TraceId AS traceId,
          SpanId AS spanId,
          ParentSpanId AS parentSpanId,
          if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) AS spanName,
          ServiceName AS serviceName,
          SpanKind AS spanKind,
          Duration / 1000000 AS durationMs,
          Timestamp AS startTime,
          StatusCode AS statusCode,
          StatusMessage AS statusMessage,
          toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'url.full', SpanAttributes['url.full'], 'http.url', SpanAttributes['http.url'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'url.path', SpanAttributes['url.path'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'cache.system', SpanAttributes['cache.system'], 'cache.result', SpanAttributes['cache.result'], 'cache.name', SpanAttributes['cache.name'], 'cache.operation', SpanAttributes['cache.operation'], 'cache.lookup_performed', SpanAttributes['cache.lookup_performed'], 'db.system.name', SpanAttributes['db.system.name'], 'db.system', SpanAttributes['db.system'], 'cloud.platform', SpanAttributes['cloud.platform'], 'cloudflare.colo', SpanAttributes['cloudflare.colo'], 'faas.invoked_region', SpanAttributes['faas.invoked_region'], 'cloudflare.outcome', SpanAttributes['cloudflare.outcome'])) AS spanAttributes,
          toJSONString(map('deployment.environment', ResourceAttributes['deployment.environment'], 'vcs.ref.head.revision', ResourceAttributes['vcs.ref.head.revision'])) AS resourceAttributes,
          if(SpanId = '00f067aa0ba902b7', 'target', 'related') AS relationship
        FROM trace_detail_spans
        WHERE TraceId = '0af7651916cd43dd8448eb211c80319c'
          AND OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        ORDER BY startTime ASC
        LIMIT 5000
        FORMAT JSON

-- pipe:span_search:default:baseline  [bfce1ab3]
SELECT
          TraceId AS traceId,
          SpanId AS spanId,
          SpanName AS spanName,
          ServiceName AS serviceName,
          Duration / 1000000 AS durationMs,
          StatusCode AS statusCode,
          StatusMessage AS statusMessage,
          SpanAttributes AS spanAttributes,
          ResourceAttributes AS resourceAttributes,
          toString(Timestamp) AS timestamp
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND StatusCode != 'Error'
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND StatusCode != 'Error'
        ORDER BY ts DESC
        LIMIT 20))
        ORDER BY timestamp DESC
        LIMIT 20
        FORMAT JSON

-- pipe:span_search:default:bloom  [bfce1ab3]
SELECT
          TraceId AS traceId,
          SpanId AS spanId,
          SpanName AS spanName,
          ServiceName AS serviceName,
          Duration / 1000000 AS durationMs,
          StatusCode AS statusCode,
          StatusMessage AS statusMessage,
          SpanAttributes AS spanAttributes,
          ResourceAttributes AS resourceAttributes,
          toString(Timestamp) AS timestamp
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND StatusCode != 'Error'
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND StatusCode != 'Error'
        ORDER BY ts DESC
        LIMIT 20))
        ORDER BY timestamp DESC
        LIMIT 20
        FORMAT JSON

-- pipe:span_search:default:text  [bfce1ab3]
SELECT
          TraceId AS traceId,
          SpanId AS spanId,
          SpanName AS spanName,
          ServiceName AS serviceName,
          Duration / 1000000 AS durationMs,
          StatusCode AS statusCode,
          StatusMessage AS statusMessage,
          SpanAttributes AS spanAttributes,
          ResourceAttributes AS resourceAttributes,
          toString(Timestamp) AS timestamp
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND StatusCode != 'Error'
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND StatusCode != 'Error'
        ORDER BY ts DESC
        LIMIT 20))
        ORDER BY timestamp DESC
        LIMIT 20
        FORMAT JSON

-- pipe:top_operations:default:baseline  [af24600b]
SELECT
          SpanName AS name,
          quantile(0.95)(Duration) / 1000000 AS value
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY value DESC
        LIMIT 20
        FORMAT JSON

-- pipe:traces_duration_stats:default:baseline  [cc9afeb5]
SELECT
          min(Duration) / 1000000 AS minDurationMs,
          max(Duration) / 1000000 AS maxDurationMs,
          quantile(0.5)(Duration) / 1000000 AS p50DurationMs,
          quantile(0.95)(Duration) / 1000000 AS p95DurationMs
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        FORMAT JSON

-- pipe:traces_facets:attribute-filtered:baseline  [952a9803]
SELECT
          ServiceName AS name,
          count() AS count,
          'service' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          SpanName AS name,
          count() AS count,
          'spanName' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND SpanName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpMethod AS name,
          count() AS count,
          'httpMethod' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND HttpMethod != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpStatusCode AS name,
          count() AS count,
          'httpStatus' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND HttpStatusCode != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          DeploymentEnv AS name,
          count() AS count,
          'deploymentEnv' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          ServiceNamespace AS name,
          count() AS count,
          'serviceNamespace' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND ServiceNamespace != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          count() AS count,
          'errorCount' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND HasError = 1
FORMAT JSON

-- pipe:traces_facets:attribute-filtered:bloom  [952a9803]
SELECT
          ServiceName AS name,
          count() AS count,
          'service' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          SpanName AS name,
          count() AS count,
          'spanName' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND SpanName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpMethod AS name,
          count() AS count,
          'httpMethod' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND HttpMethod != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpStatusCode AS name,
          count() AS count,
          'httpStatus' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND HttpStatusCode != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          DeploymentEnv AS name,
          count() AS count,
          'deploymentEnv' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          ServiceNamespace AS name,
          count() AS count,
          'serviceNamespace' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND ServiceNamespace != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          count() AS count,
          'errorCount' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND HasError = 1
FORMAT JSON

-- pipe:traces_facets:attribute-filtered:text  [952a9803]
SELECT
          ServiceName AS name,
          count() AS count,
          'service' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          SpanName AS name,
          count() AS count,
          'spanName' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND SpanName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpMethod AS name,
          count() AS count,
          'httpMethod' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND HttpMethod != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpStatusCode AS name,
          count() AS count,
          'httpStatus' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND HttpStatusCode != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          DeploymentEnv AS name,
          count() AS count,
          'deploymentEnv' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          ServiceNamespace AS name,
          count() AS count,
          'serviceNamespace' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND ServiceNamespace != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          count() AS count,
          'errorCount' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId
          AND t_attr.OrgId = 'org_sql_catalog'
          AND t_attr.Timestamp >= '2026-01-01 10:30:00'
          AND t_attr.Timestamp <= '2026-01-03 14:15:00'
          AND positionCaseInsensitive(t_attr.SpanAttributes['http.method'], 'GE') > 0)
          AND EXISTS (SELECT
          1 AS _
        FROM traces AS t_res
        WHERE t_res.TraceId = TraceId
          AND t_res.OrgId = 'org_sql_catalog'
          AND t_res.Timestamp >= '2026-01-01 10:30:00'
          AND t_res.Timestamp <= '2026-01-03 14:15:00'
          AND t_res.ResourceAttributes['host.name'] = 'web')
          AND HasError = 1
FORMAT JSON

-- pipe:traces_facets:default:baseline  [3a9bffe8]
SELECT
          ServiceName AS name,
          count() AS count,
          'service' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          SpanName AS name,
          count() AS count,
          'spanName' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND SpanName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpMethod AS name,
          count() AS count,
          'httpMethod' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND HttpMethod != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpStatusCode AS name,
          count() AS count,
          'httpStatus' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND HttpStatusCode != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          DeploymentEnv AS name,
          count() AS count,
          'deploymentEnv' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          ServiceNamespace AS name,
          count() AS count,
          'serviceNamespace' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceNamespace != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          count() AS count,
          'errorCount' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND HasError = 1
FORMAT JSON

-- pipe:traces_facets:default:bloom  [3a9bffe8]
SELECT
          ServiceName AS name,
          count() AS count,
          'service' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          SpanName AS name,
          count() AS count,
          'spanName' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND SpanName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpMethod AS name,
          count() AS count,
          'httpMethod' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND HttpMethod != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpStatusCode AS name,
          count() AS count,
          'httpStatus' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND HttpStatusCode != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          DeploymentEnv AS name,
          count() AS count,
          'deploymentEnv' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          ServiceNamespace AS name,
          count() AS count,
          'serviceNamespace' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceNamespace != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          count() AS count,
          'errorCount' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND HasError = 1
FORMAT JSON

-- pipe:traces_facets:default:text  [3a9bffe8]
SELECT
          ServiceName AS name,
          count() AS count,
          'service' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          SpanName AS name,
          count() AS count,
          'spanName' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND SpanName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpMethod AS name,
          count() AS count,
          'httpMethod' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND HttpMethod != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpStatusCode AS name,
          count() AS count,
          'httpStatus' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND HttpStatusCode != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          DeploymentEnv AS name,
          count() AS count,
          'deploymentEnv' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          ServiceNamespace AS name,
          count() AS count,
          'serviceNamespace' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceNamespace != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          count() AS count,
          'errorCount' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND HasError = 1
FORMAT JSON

-- spec:attribute-keys-logs:baseline  [f2e10453]
SELECT
          AttributeKey AS attributeKey,
          sum(UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'log'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- spec:attribute-keys-metrics-scoped:baseline  [83346ccb]
SELECT
          arrayJoin(mapKeys(Attributes)) AS attributeKey,
          count() AS usageCount
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName = 'http.server.requests'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- spec:attribute-keys-metrics:baseline  [f2e10453]
SELECT
          AttributeKey AS attributeKey,
          sum(UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'metric'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- spec:attribute-keys-resource:baseline  [f2e10453]
SELECT
          AttributeKey AS attributeKey,
          sum(UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'resource'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- spec:attribute-keys-span:baseline  [f2e10453]
SELECT
          AttributeKey AS attributeKey,
          sum(UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'span'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- spec:attribute-keys-span:bloom  [f2e10453]
SELECT
          AttributeKey AS attributeKey,
          sum(UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'span'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- spec:attribute-keys-span:text  [f2e10453]
SELECT
          AttributeKey AS attributeKey,
          sum(UsageCount) AS usageCount
        FROM attribute_keys_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'span'
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT 200
        FORMAT JSON

-- spec:attribute-values-log:baseline  [522791bf]
SELECT
          AttributeValue AS attributeValue,
          sum(UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'log'
          AND AttributeKey = 'log.level'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- spec:attribute-values-metrics-scoped:baseline  [47cae3b9]
SELECT
          Attributes['http.route'] AS attributeValue,
          count() AS usageCount
        FROM metrics_sum
        WHERE OrgId = 'org_sql_catalog'
          AND MetricName = 'http.server.requests'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND Attributes['http.route'] != ''
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- spec:attribute-values-metrics:baseline  [522791bf]
SELECT
          AttributeValue AS attributeValue,
          sum(UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'metric'
          AND AttributeKey = 'http.route'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- spec:attribute-values-span:baseline  [522791bf]
SELECT
          AttributeValue AS attributeValue,
          sum(UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'span'
          AND AttributeKey = 'http.method'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- spec:attribute-values-span:bloom  [522791bf]
SELECT
          AttributeValue AS attributeValue,
          sum(UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'span'
          AND AttributeKey = 'http.method'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- spec:attribute-values-span:text  [522791bf]
SELECT
          AttributeValue AS attributeValue,
          sum(UsageCount) AS usageCount
        FROM attribute_values_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND AttributeScope = 'span'
          AND AttributeKey = 'http.method'
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT 50
        FORMAT JSON

-- spec:errors-facets:baseline  [fe66f114]
SELECT
          ServiceName AS name,
          uniq(FingerprintHash) AS count,
          'service' AS facetType
        FROM error_events_by_time
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          DeploymentEnv AS name,
          uniq(FingerprintHash) AS count,
          'environment' AS facetType
        FROM error_events_by_time
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 100
UNION ALL
SELECT
          ErrorLabel AS name,
          uniq(FingerprintHash) AS count,
          'error_type' AS facetType
        FROM error_events_by_time
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          ServiceVersion AS name,
          uniq(FingerprintHash) AS count,
          'version' AS facetType
        FROM error_events_by_time
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceVersion != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- spec:logs-breakdown:baseline  [17d3173d]
SELECT
          name AS name,
          sum(count) AS count
        FROM (
SELECT
          SeverityText AS name,
          count() AS count
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND ServiceName = 'api'
        GROUP BY name
UNION ALL
SELECT
          SeverityText AS name,
          sum(Count) AS count
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND ServiceName = 'api'
        GROUP BY name
) AS breakdown
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- spec:logs-count:baseline  [8e66dc08]
SELECT
          sum(total) AS total
        FROM (
SELECT
          count() AS total
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND ServiceName = 'api'
UNION ALL
SELECT
          sum(Count) AS total
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND ServiceName = 'api'
) AS counts
        FORMAT JSON

-- spec:logs-count:bloom  [8e66dc08]
SELECT
          sum(total) AS total
        FROM (
SELECT
          count() AS total
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND ServiceName = 'api'
UNION ALL
SELECT
          sum(Count) AS total
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND ServiceName = 'api'
) AS counts
        FORMAT JSON

-- spec:logs-count:text  [8e66dc08]
SELECT
          sum(total) AS total
        FROM (
SELECT
          count() AS total
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-01 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (TimestampTime < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR TimestampTime >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
          AND ServiceName = 'api'
UNION ALL
SELECT
          sum(Count) AS total
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND ServiceName = 'api'
) AS counts
        FORMAT JSON

-- spec:logs-facets-single-dimension:baseline  [51dbd2d0]
SELECT * FROM (
SELECT
          SeverityText AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(Count) AS count,
          'severity' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
        GROUP BY severityText
)
ORDER BY count DESC
LIMIT 500
FORMAT JSON

-- spec:logs-facets:baseline  [1b88491f]
SELECT * FROM (
SELECT
          SeverityText AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(Count) AS count,
          'severity' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
        GROUP BY severityText
UNION ALL
SELECT
          '' AS severityText,
          ServiceName AS serviceName,
          '' AS deploymentEnv,
          '' AS namespace,
          sum(Count) AS count,
          'service' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
        GROUP BY serviceName
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          DeploymentEnv AS deploymentEnv,
          '' AS namespace,
          sum(Count) AS count,
          'deploymentEnv' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv != ''
        GROUP BY deploymentEnv
UNION ALL
SELECT
          '' AS severityText,
          '' AS serviceName,
          '' AS deploymentEnv,
          ServiceNamespace AS namespace,
          sum(Count) AS count,
          'namespace' AS facetType
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND ServiceNamespace != ''
        GROUP BY namespace
)
ORDER BY count DESC
LIMIT 500
FORMAT JSON

-- spec:logs-timeseries-grouped:baseline  [f594ac7f]
WITH __series_base AS (
SELECT
          toStartOfInterval(Timestamp, INTERVAL 60 SECOND) AS bucket,
          coalesce(nullIf(toString(SeverityText), ''), 'all') AS groupName,
          count() AS count
        FROM logs
        WHERE OrgId = 'org_sql_catalog'
          AND TimestampTime >= '2026-01-03 10:30:00'
          AND TimestampTime <= '2026-01-03 14:15:00'
          AND Timestamp >= '2026-01-03 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
)
SELECT
          bucket AS bucket,
          groupName AS groupName,
          count AS count
        FROM __series_base
        WHERE groupName IN (SELECT
          groupName AS groupName
        FROM (SELECT
          groupName AS groupName,
          max(count) AS rank
        FROM __series_base
        GROUP BY groupName
        ORDER BY rank DESC
        LIMIT 5) AS ranked)
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:logs-timeseries:baseline  [ea443f9a]
SELECT
          toStartOfInterval(Hour, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(Count) AS count
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND ServiceName = 'api'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:logs-timeseries:bloom  [ea443f9a]
SELECT
          toStartOfInterval(Hour, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(Count) AS count
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND ServiceName = 'api'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:logs-timeseries:text  [ea443f9a]
SELECT
          toStartOfInterval(Hour, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(Count) AS count
        FROM logs_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= '2026-01-01 10:30:00'
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND ServiceName = 'api'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:metrics-breakdown:baseline  [35b2dc2d]
SELECT
          ServiceName AS name,
          if(sum(Count) > 0, sum(Sum) / sum(Count), 0) AS avgValue,
          sum(Sum) AS sumValue,
          sum(Count) AS count
        FROM metrics_histogram
        WHERE MetricName = 'http.server.request.duration'
          AND OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- spec:metrics-sparklines:baseline  [377afd48]
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 3600 SECOND) AS bucket,
          MetricName AS metricName,
          avg(Value) AS avgValue,
          sum(Value) AS sumValue,
          count() AS dataPointCount
        FROM metrics_sum
        WHERE MetricName IN ('http.server.requests', 'rpc.server.duration')
          AND OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
        GROUP BY bucket, metricName
        ORDER BY bucket ASC
        FORMAT JSON

-- spec:metrics-timeseries-grouped-by-attribute:baseline  [7f18f69a]
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 300 SECOND) AS bucket,
          ServiceName AS serviceName,
          Attributes['http.route'] AS attributeValue,
          Attributes['http.route'] AS groupName,
          if(sum(Count) > 0, sum(Sum) / sum(Count), 0) AS avgValue,
          ifNull(min(Min), 0) AS minValue,
          ifNull(max(Max), 0) AS maxValue,
          sum(Sum) AS sumValue,
          sum(Count) AS dataPointCount
        FROM metrics_histogram
        WHERE MetricName = 'http.server.request.duration'
          AND OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
        GROUP BY bucket, serviceName, attributeValue
        ORDER BY bucket ASC
        FORMAT JSON

-- spec:metrics-timeseries-grouped-by-resource:baseline  [c0ea8282]
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 300 SECOND) AS bucket,
          ServiceName AS serviceName,
          ResourceAttributes['host.name'] AS attributeValue,
          ResourceAttributes['host.name'] AS groupName,
          if(sum(Count) > 0, sum(Sum) / sum(Count), 0) AS avgValue,
          ifNull(min(Min), 0) AS minValue,
          ifNull(max(Max), 0) AS maxValue,
          sum(Sum) AS sumValue,
          sum(Count) AS dataPointCount
        FROM metrics_histogram
        WHERE MetricName = 'http.server.request.duration'
          AND OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
        GROUP BY bucket, serviceName, attributeValue
        ORDER BY bucket ASC
        FORMAT JSON

-- spec:metrics-timeseries-rate:baseline  [bc6c3438]
WITH with_deltas AS (
SELECT
          TimeUnix AS TimeUnix,
          ServiceName AS ServiceName,
          Attributes AS Attributes,
          '' AS resourceAttributeValue,
          Value AS Value,
          Value - lagInFrame(Value, 1, Value) OVER (PARTITION BY ServiceName, MetricName, cityHash64(mapKeys(Attributes), mapValues(Attributes)), cityHash64(mapKeys(ResourceAttributes), mapValues(ResourceAttributes)), StartTimeUnix ORDER BY TimeUnix ASC ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS delta,
          toFloat64(toUnixTimestamp64Nano(TimeUnix) - toUnixTimestamp64Nano(lagInFrame(TimeUnix, 1, TimeUnix) OVER (PARTITION BY ServiceName, MetricName, cityHash64(mapKeys(Attributes), mapValues(Attributes)), cityHash64(mapKeys(ResourceAttributes), mapValues(ResourceAttributes)), StartTimeUnix ORDER BY TimeUnix ASC ROWS BETWEEN 1 PRECEDING AND CURRENT ROW))) / 1000000000 AS time_delta
        FROM metrics_sum
        WHERE MetricName = 'http.server.requests'
          AND OrgId = 'org_sql_catalog'
          AND IsMonotonic = 1
          AND TimeUnix >= '2026-01-01 10:30:00' - INTERVAL 3600 SECOND
          AND TimeUnix <= '2026-01-03 14:15:00'
)
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 3600 SECOND) AS bucket,
          ServiceName AS serviceName,
          '' AS attributeValue,
          ServiceName AS groupName,
          sumIf(delta / time_delta, (delta >= 0 AND time_delta > 0)) AS rateValue,
          sumIf(delta, delta >= 0) AS increaseValue,
          count() AS dataPointCount
        FROM with_deltas
        WHERE TimeUnix >= '2026-01-01 10:30:00'
        GROUP BY bucket, serviceName
        ORDER BY bucket ASC
        FORMAT JSON

-- spec:metrics-timeseries:baseline  [8a2c3b82]
SELECT
          toStartOfInterval(TimeUnix, INTERVAL 3600 SECOND) AS bucket,
          ServiceName AS serviceName,
          '' AS attributeValue,
          ServiceName AS groupName,
          if(sum(Count) > 0, sum(Sum) / sum(Count), 0) AS avgValue,
          ifNull(min(Min), 0) AS minValue,
          ifNull(max(Max), 0) AS maxValue,
          sum(Sum) AS sumValue,
          sum(Count) AS dataPointCount
        FROM metrics_histogram
        WHERE MetricName = 'http.server.request.duration'
          AND OrgId = 'org_sql_catalog'
          AND TimeUnix >= '2026-01-01 10:30:00'
          AND TimeUnix <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
        GROUP BY bucket, serviceName
        ORDER BY bucket ASC
        FORMAT JSON

-- spec:services-facets:baseline  [d6b6158c]
SELECT
          bEnvironment AS name,
          sum(bSpanCount) AS count,
          'environment' AS facetType
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE bEnvironment != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          bServiceNamespace AS name,
          sum(bSpanCount) AS count,
          'namespace' AS facetType
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE bServiceNamespace != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          bCommitSha AS name,
          sum(bSpanCount) AS count,
          'commit_sha' AS facetType
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE bCommitSha != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          bServiceName AS name,
          sum(bSpanCount) AS count,
          'service' AS facetType
        FROM (
SELECT
          toStartOfHour(Timestamp) AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          count() AS bSpanCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          min(Timestamp) AS bFirstSeen,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bApdexSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bApdexToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
UNION ALL
SELECT
          Hour AS bBucket,
          ServiceName AS bServiceName,
          ServiceNamespace AS bServiceNamespace,
          DeploymentEnv AS bEnvironment,
          CommitSha AS bCommitSha,
          sum(SpanCount) AS bSpanCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(EstimatedErrorCount) AS bEstimatedErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          min(FirstSeen) AS bFirstSeen,
          sum(ApdexSatisfiedCount) AS bApdexSatisfiedCount,
          sum(ApdexToleratingCount) AS bApdexToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bBucket, bServiceName, bServiceNamespace, bEnvironment, bCommitSha
) AS service_windows
        WHERE bServiceName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
FORMAT JSON

-- spec:traces-breakdown-by-attribute:baseline  [192e93fe]
SELECT
          SpanAttributes['http.route'] AS name,
          sum(SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- spec:traces-breakdown-by-attribute:bloom  [192e93fe]
SELECT
          SpanAttributes['http.route'] AS name,
          sum(SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- spec:traces-breakdown-by-attribute:text  [192e93fe]
SELECT
          SpanAttributes['http.route'] AS name,
          sum(SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- spec:traces-breakdown:baseline  [948c682e]
SELECT
          ServiceName AS name,
          sum(SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY name
        ORDER BY count DESC
        LIMIT 10
        FORMAT JSON

-- spec:traces-facets-single-dimension:baseline  [a277cb3c]
SELECT
          SpanName AS name,
          count() AS count,
          'spanName' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND SpanName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
FORMAT JSON

-- spec:traces-facets:baseline  [eabfe99e]
SELECT
          ServiceName AS name,
          count() AS count,
          'service' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          SpanName AS name,
          count() AS count,
          'spanName' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND SpanName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpMethod AS name,
          count() AS count,
          'httpMethod' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND HttpMethod != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpStatusCode AS name,
          count() AS count,
          'httpStatus' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND HttpStatusCode != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          DeploymentEnv AS name,
          count() AS count,
          'deploymentEnv' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          ServiceNamespace AS name,
          count() AS count,
          'serviceNamespace' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND ServiceNamespace != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          count() AS count,
          'errorCount' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND HasError = 1
FORMAT JSON

-- spec:traces-facets:bloom  [eabfe99e]
SELECT
          ServiceName AS name,
          count() AS count,
          'service' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          SpanName AS name,
          count() AS count,
          'spanName' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND SpanName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpMethod AS name,
          count() AS count,
          'httpMethod' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND HttpMethod != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpStatusCode AS name,
          count() AS count,
          'httpStatus' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND HttpStatusCode != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          DeploymentEnv AS name,
          count() AS count,
          'deploymentEnv' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          ServiceNamespace AS name,
          count() AS count,
          'serviceNamespace' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND ServiceNamespace != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          count() AS count,
          'errorCount' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND HasError = 1
FORMAT JSON

-- spec:traces-facets:text  [eabfe99e]
SELECT
          ServiceName AS name,
          count() AS count,
          'service' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
UNION ALL
SELECT
          SpanName AS name,
          count() AS count,
          'spanName' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND SpanName != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpMethod AS name,
          count() AS count,
          'httpMethod' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND HttpMethod != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          HttpStatusCode AS name,
          count() AS count,
          'httpStatus' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND HttpStatusCode != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          DeploymentEnv AS name,
          count() AS count,
          'deploymentEnv' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND DeploymentEnv != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          ServiceNamespace AS name,
          count() AS count,
          'serviceNamespace' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND ServiceNamespace != ''
        GROUP BY name
        ORDER BY count DESC
        LIMIT 20
UNION ALL
SELECT
          'error' AS name,
          count() AS count,
          'errorCount' AS facetType
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
          AND HasError = 1
FORMAT JSON

-- spec:traces-list-grouped-attr-fallback:baseline  [6142bef1]
SELECT
          TraceId AS traceId,
          argMin(Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp)) AS startTime,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) - min(toUnixTimestamp64Nano(Timestamp)), 1000) AS durationMicros,
          intDiv(argMin(Duration, (if(ParentSpanId = '', 0, 1), Timestamp)), 1000) AS rootDurationMicros,
          count() AS spanCount,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(ServiceName)), argMin(ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services,
          argMin(SpanName, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanName,
          argMin(SpanKind, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanKind,
          argMin(StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanStatusCode,
          argMin(SpanAttributes['http.method'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpMethod,
          argMin(SpanAttributes['http.route'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpRoute,
          argMin(SpanAttributes['http.status_code'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpStatusCode,
          argMin(toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanAttributes,
          if(argMin(StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) = 'Error', 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= subtractHours(toDateTime('2026-01-01 10:30:00'), 1)
          AND Timestamp <= addHours(toDateTime('2026-01-03 14:15:00'), 1)
          AND TraceId IN (SELECT traceId FROM (SELECT
          TraceId AS traceId,
          Timestamp AS ts,
          Duration AS d
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND SpanAttributes['user.id'] = 'u1'
          AND ParentSpanId = ''
        ORDER BY ts DESC, traceId DESC
        LIMIT 50))
        GROUP BY traceId
        ORDER BY startTime DESC, traceId DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list-grouped-attr-fallback:bloom  [a9a27f2b]
SELECT
          TraceId AS traceId,
          argMin(Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp)) AS startTime,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) - min(toUnixTimestamp64Nano(Timestamp)), 1000) AS durationMicros,
          intDiv(argMin(Duration, (if(ParentSpanId = '', 0, 1), Timestamp)), 1000) AS rootDurationMicros,
          count() AS spanCount,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(ServiceName)), argMin(ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services,
          argMin(SpanName, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanName,
          argMin(SpanKind, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanKind,
          argMin(StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanStatusCode,
          argMin(SpanAttributes['http.method'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpMethod,
          argMin(SpanAttributes['http.route'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpRoute,
          argMin(SpanAttributes['http.status_code'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpStatusCode,
          argMin(toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanAttributes,
          if(argMin(StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) = 'Error', 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= subtractHours(toDateTime('2026-01-01 10:30:00'), 1)
          AND Timestamp <= addHours(toDateTime('2026-01-03 14:15:00'), 1)
          AND TraceId IN (SELECT traceId FROM (SELECT
          TraceId AS traceId,
          Timestamp AS ts,
          Duration AS d
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND ((has(mapKeys(SpanAttributes), 'user.id') AND has(mapValues(SpanAttributes), 'u1')) AND SpanAttributes['user.id'] = 'u1')
          AND ParentSpanId = ''
        ORDER BY ts DESC, traceId DESC
        LIMIT 50))
        GROUP BY traceId
        ORDER BY startTime DESC, traceId DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list-grouped-attr-fallback:text  [22bd2047]
SELECT
          TraceId AS traceId,
          argMin(Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp)) AS startTime,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) - min(toUnixTimestamp64Nano(Timestamp)), 1000) AS durationMicros,
          intDiv(argMin(Duration, (if(ParentSpanId = '', 0, 1), Timestamp)), 1000) AS rootDurationMicros,
          count() AS spanCount,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(ServiceName)), argMin(ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services,
          argMin(SpanName, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanName,
          argMin(SpanKind, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanKind,
          argMin(StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanStatusCode,
          argMin(SpanAttributes['http.method'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpMethod,
          argMin(SpanAttributes['http.route'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpRoute,
          argMin(SpanAttributes['http.status_code'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpStatusCode,
          argMin(toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanAttributes,
          if(argMin(StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) = 'Error', 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= subtractHours(toDateTime('2026-01-01 10:30:00'), 1)
          AND Timestamp <= addHours(toDateTime('2026-01-03 14:15:00'), 1)
          AND TraceId IN (SELECT traceId FROM (SELECT
          TraceId AS traceId,
          Timestamp AS ts,
          Duration AS d
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND (has(SpanAttributeItems, concat('user.id', char(31), 'u1')) AND SpanAttributes['user.id'] = 'u1')
          AND ParentSpanId = ''
        ORDER BY ts DESC, traceId DESC
        LIMIT 50))
        GROUP BY traceId
        ORDER BY startTime DESC, traceId DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list-grouped-duration-sort:baseline  [3b6bcadc]
SELECT
          TraceId AS traceId,
          argMin(Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp)) AS startTime,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) - min(toUnixTimestamp64Nano(Timestamp)), 1000) AS durationMicros,
          intDiv(argMin(Duration, (if(ParentSpanId = '', 0, 1), Timestamp)), 1000) AS rootDurationMicros,
          count() AS spanCount,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(ServiceName)), argMin(ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services,
          argMin(SpanName, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanName,
          argMin(SpanKind, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanKind,
          argMin(StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanStatusCode,
          argMin(SpanAttributes['http.method'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpMethod,
          argMin(SpanAttributes['http.route'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpRoute,
          argMin(SpanAttributes['http.status_code'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpStatusCode,
          argMin(toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanAttributes,
          if(argMin(StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) = 'Error', 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= subtractHours(toDateTime('2026-01-01 10:30:00'), 1)
          AND Timestamp <= addHours(toDateTime('2026-01-03 14:15:00'), 1)
          AND TraceId IN (SELECT traceId FROM (SELECT
          TraceId AS traceId,
          Timestamp AS ts,
          Duration AS d
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
        ORDER BY d DESC, ts DESC, traceId DESC
        LIMIT 50
        OFFSET 100))
        GROUP BY traceId
        ORDER BY rootDurationMicros DESC, startTime DESC, traceId DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list-grouped:baseline  [da486ffd]
SELECT
          TraceId AS traceId,
          argMin(Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp)) AS startTime,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) - min(toUnixTimestamp64Nano(Timestamp)), 1000) AS durationMicros,
          intDiv(argMin(Duration, (if(ParentSpanId = '', 0, 1), Timestamp)), 1000) AS rootDurationMicros,
          count() AS spanCount,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(ServiceName)), argMin(ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services,
          argMin(SpanName, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanName,
          argMin(SpanKind, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanKind,
          argMin(StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanStatusCode,
          argMin(SpanAttributes['http.method'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpMethod,
          argMin(SpanAttributes['http.route'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpRoute,
          argMin(SpanAttributes['http.status_code'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpStatusCode,
          argMin(toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanAttributes,
          if(argMin(StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) = 'Error', 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= subtractHours(toDateTime('2026-01-01 10:30:00'), 1)
          AND Timestamp <= addHours(toDateTime('2026-01-03 14:15:00'), 1)
          AND TraceId IN (SELECT traceId FROM (SELECT
          TraceId AS traceId,
          Timestamp AS ts,
          Duration AS d
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
        ORDER BY ts DESC, traceId DESC
        LIMIT 50))
        GROUP BY traceId
        ORDER BY startTime DESC, traceId DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list-grouped:bloom  [da486ffd]
SELECT
          TraceId AS traceId,
          argMin(Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp)) AS startTime,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) - min(toUnixTimestamp64Nano(Timestamp)), 1000) AS durationMicros,
          intDiv(argMin(Duration, (if(ParentSpanId = '', 0, 1), Timestamp)), 1000) AS rootDurationMicros,
          count() AS spanCount,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(ServiceName)), argMin(ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services,
          argMin(SpanName, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanName,
          argMin(SpanKind, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanKind,
          argMin(StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanStatusCode,
          argMin(SpanAttributes['http.method'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpMethod,
          argMin(SpanAttributes['http.route'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpRoute,
          argMin(SpanAttributes['http.status_code'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpStatusCode,
          argMin(toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanAttributes,
          if(argMin(StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) = 'Error', 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= subtractHours(toDateTime('2026-01-01 10:30:00'), 1)
          AND Timestamp <= addHours(toDateTime('2026-01-03 14:15:00'), 1)
          AND TraceId IN (SELECT traceId FROM (SELECT
          TraceId AS traceId,
          Timestamp AS ts,
          Duration AS d
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
        ORDER BY ts DESC, traceId DESC
        LIMIT 50))
        GROUP BY traceId
        ORDER BY startTime DESC, traceId DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list-grouped:text  [da486ffd]
SELECT
          TraceId AS traceId,
          argMin(Timestamp, (if(ParentSpanId = '', 0, 1), Timestamp)) AS startTime,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) - min(toUnixTimestamp64Nano(Timestamp)), 1000) AS durationMicros,
          intDiv(argMin(Duration, (if(ParentSpanId = '', 0, 1), Timestamp)), 1000) AS rootDurationMicros,
          count() AS spanCount,
          arrayDistinct(arrayPushFront(arraySort(groupUniqArray(ServiceName)), argMin(ServiceName, (if(ParentSpanId = '', 0, 1), Timestamp)))) AS services,
          argMin(SpanName, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanName,
          argMin(SpanKind, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanKind,
          argMin(StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanStatusCode,
          argMin(SpanAttributes['http.method'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpMethod,
          argMin(SpanAttributes['http.route'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpRoute,
          argMin(SpanAttributes['http.status_code'], (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootHttpStatusCode,
          argMin(toJSONString(map('http.method', SpanAttributes['http.method'], 'http.request.method', SpanAttributes['http.request.method'], 'http.route', SpanAttributes['http.route'], 'http.target', SpanAttributes['http.target'], 'http.status_code', SpanAttributes['http.status_code'], 'http.response.status_code', SpanAttributes['http.response.status_code'], 'http.url', SpanAttributes['http.url'], 'url.full', SpanAttributes['url.full'], 'url.path', SpanAttributes['url.path'], 'server.address', SpanAttributes['server.address'], 'net.peer.name', SpanAttributes['net.peer.name'], 'screen.name', SpanAttributes['screen.name'])), (if(ParentSpanId = '', 0, 1), Timestamp)) AS rootSpanAttributes,
          if(argMin(StatusCode, (if(ParentSpanId = '', 0, 1), Timestamp)) = 'Error', 1, 0) AS hasError
        FROM trace_detail_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= subtractHours(toDateTime('2026-01-01 10:30:00'), 1)
          AND Timestamp <= addHours(toDateTime('2026-01-03 14:15:00'), 1)
          AND TraceId IN (SELECT traceId FROM (SELECT
          TraceId AS traceId,
          Timestamp AS ts,
          Duration AS d
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
        ORDER BY ts DESC, traceId DESC
        LIMIT 50))
        GROUP BY traceId
        ORDER BY startTime DESC, traceId DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list:baseline  [3ec2a2e9]
SELECT
          TraceId AS traceId,
          Timestamp AS timestamp,
          SpanId AS spanId,
          ParentSpanId AS parentSpanId,
          ServiceName AS serviceName,
          SpanName AS spanName,
          Duration / 1000000 AS durationMs,
          StatusCode AS statusCode,
          SpanKind AS spanKind,
          if(StatusCode = 'Error', 1, 0) AS hasError,
          SpanAttributes AS spanAttributes,
          ResourceAttributes AS resourceAttributes
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list:bloom  [3ec2a2e9]
SELECT
          TraceId AS traceId,
          Timestamp AS timestamp,
          SpanId AS spanId,
          ParentSpanId AS parentSpanId,
          ServiceName AS serviceName,
          SpanName AS spanName,
          Duration / 1000000 AS durationMs,
          StatusCode AS statusCode,
          SpanKind AS spanKind,
          if(StatusCode = 'Error', 1, 0) AS hasError,
          SpanAttributes AS spanAttributes,
          ResourceAttributes AS resourceAttributes
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-list:text  [3ec2a2e9]
SELECT
          TraceId AS traceId,
          Timestamp AS timestamp,
          SpanId AS spanId,
          ParentSpanId AS parentSpanId,
          ServiceName AS serviceName,
          SpanName AS spanName,
          Duration / 1000000 AS durationMs,
          StatusCode AS statusCode,
          SpanKind AS spanKind,
          if(StatusCode = 'Error', 1, 0) AS hasError,
          SpanAttributes AS spanAttributes,
          ResourceAttributes AS resourceAttributes
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND Timestamp >= (SELECT min(ts) FROM (SELECT
          Timestamp AS ts
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
        ORDER BY ts DESC
        LIMIT 50))
        ORDER BY timestamp DESC
        LIMIT 50
        FORMAT JSON

-- spec:traces-stats:baseline  [e90761b3]
SELECT
          min(Duration) / 1000000 AS minDurationMs,
          max(Duration) / 1000000 AS maxDurationMs,
          quantile(0.5)(Duration) / 1000000 AS p50DurationMs,
          quantile(0.95)(Duration) / 1000000 AS p95DurationMs
        FROM trace_list_mv
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv = 'production'
        FORMAT JSON

-- spec:traces-timeseries-aggregates-mv:baseline  [cad07ec0]
SELECT
          bucket AS bucket,
          groupName AS groupName,
          sum(bWeightedCount) AS count,
          sum(bSpanCount) AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(SampleRate) AS bWeightedCount,
          toFloat64(count()) AS bSpanCount,
          sum(toFloat64(Duration) * SampleRate) AS bWeightedDurationSum,
          sumIf(SampleRate, StatusCode = 'Error') AS bWeightedErrorCount,
          '' AS bDurationQuantiles
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Timestamp >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(Hour, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(WeightedCount) AS bWeightedCount,
          sum(WeightedCount) AS bSpanCount,
          sum(WeightedDurationSum) AS bWeightedDurationSum,
          sum(WeightedErrorCount) AS bWeightedErrorCount,
          '' AS bDurationQuantiles
        FROM traces_aggregates_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
          AND ServiceName = 'api'
          AND DeploymentEnv IN ('production')
        GROUP BY bucket, groupName
) AS traces_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-all-metrics-grouped:baseline  [bb89a9b1]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket,
          coalesce(nullIf(toString(ServiceName), ''), 'all') AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(SampleRate) AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-daily-buckets:baseline  [2ebc4087]
SELECT
          bucket AS bucket,
          groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(bCount) AS spanCount,
          if(sum(bCount) > 0, sum(bDurationSum) / sum(bCount) / 1000000, 0) AS avgDuration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99Duration,
          if(sum(bCount) > 0, sum(bErrorCount) / sum(bCount), 0) AS errorRate,
          sum(bSatisfiedCount) AS satisfiedCount,
          sum(bToleratingCount) AS toleratingCount,
          if(sum(bCount) > 0, round(sum(bSatisfiedCount) / sum(bCount) + sum(bToleratingCount) * 0.5 / sum(bCount), 4), 0) AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(Timestamp, INTERVAL 86400 SECOND) AS bucket,
          'all' AS groupName,
          count() AS bCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2025-11-01 00:00:00'
          AND Timestamp <= '2025-11-25 00:00:00'
          AND (Timestamp < if(toDateTime('2025-11-01 00:00:00') = toStartOfMinute(toDateTime('2025-11-01 00:00:00')), toStartOfMinute(toDateTime('2025-11-01 00:00:00')), toStartOfMinute(toDateTime('2025-11-01 00:00:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2025-11-25 00:00:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(Minute, INTERVAL 86400 SECOND) AS bucket,
          'all' AS groupName,
          sum(SpanCount) AS bCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_minutely
        WHERE OrgId = 'org_sql_catalog'
          AND Minute >= if(toDateTime('2025-11-01 00:00:00') = toStartOfMinute(toDateTime('2025-11-01 00:00:00')), toStartOfMinute(toDateTime('2025-11-01 00:00:00')), toStartOfMinute(toDateTime('2025-11-01 00:00:00')) + INTERVAL 1 MINUTE)
          AND Minute < toStartOfMinute(toDateTime('2025-11-25 00:00:00'))
          AND (Minute < if(toDateTime('2025-11-01 00:00:00') = toStartOfHour(toDateTime('2025-11-01 00:00:00')), toStartOfHour(toDateTime('2025-11-01 00:00:00')), toStartOfHour(toDateTime('2025-11-01 00:00:00')) + INTERVAL 1 HOUR) OR Minute >= toStartOfHour(toDateTime('2025-11-25 00:00:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(Hour, INTERVAL 86400 SECOND) AS bucket,
          'all' AS groupName,
          sum(SpanCount) AS bCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2025-11-01 00:00:00') = toStartOfHour(toDateTime('2025-11-01 00:00:00')), toStartOfHour(toDateTime('2025-11-01 00:00:00')), toStartOfHour(toDateTime('2025-11-01 00:00:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2025-11-25 00:00:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-grouped-all-tiers:baseline  [5045e3b6]
SELECT
          bucket AS bucket,
          groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(bCount) AS spanCount,
          if(sum(bCount) > 0, sum(bDurationSum) / sum(bCount) / 1000000, 0) AS avgDuration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99Duration,
          if(sum(bCount) > 0, sum(bErrorCount) / sum(bCount), 0) AS errorRate,
          sum(bSatisfiedCount) AS satisfiedCount,
          sum(bToleratingCount) AS toleratingCount,
          if(sum(bCount) > 0, round(sum(bSatisfiedCount) / sum(bCount) + sum(bToleratingCount) * 0.5 / sum(bCount), 4), 0) AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket,
          coalesce(nullIf(toString(ServiceName), ''), 'all') AS groupName,
          count() AS bCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(Minute, INTERVAL 3600 SECOND) AS bucket,
          coalesce(nullIf(toString(ServiceName), ''), 'all') AS groupName,
          sum(SpanCount) AS bCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_minutely
        WHERE OrgId = 'org_sql_catalog'
          AND Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
          AND (Minute < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Minute >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(Hour, INTERVAL 3600 SECOND) AS bucket,
          coalesce(nullIf(toString(ServiceName), ''), 'all') AS groupName,
          sum(SpanCount) AS bCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-grouped-series-cap:baseline  [a922eaa3]
WITH __series_base AS (
SELECT
          bucket AS bucket,
          groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(bCount) AS spanCount,
          if(sum(bCount) > 0, sum(bDurationSum) / sum(bCount) / 1000000, 0) AS avgDuration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99Duration,
          if(sum(bCount) > 0, sum(bErrorCount) / sum(bCount), 0) AS errorRate,
          sum(bSatisfiedCount) AS satisfiedCount,
          sum(bToleratingCount) AS toleratingCount,
          if(sum(bCount) > 0, round(sum(bSatisfiedCount) / sum(bCount) + sum(bToleratingCount) * 0.5 / sum(bCount), 4), 0) AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(ServiceName), ''), 'all') AS groupName,
          count() AS bCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-03 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND (Timestamp < if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(Minute, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(ServiceName), ''), 'all') AS groupName,
          sum(SpanCount) AS bCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_minutely
        WHERE OrgId = 'org_sql_catalog'
          AND Minute >= if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE)
          AND Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
)
SELECT
          bucket AS bucket,
          groupName AS groupName,
          count AS count,
          spanCount AS spanCount,
          avgDuration AS avgDuration,
          p50Duration AS p50Duration,
          p95Duration AS p95Duration,
          p99Duration AS p99Duration,
          errorRate AS errorRate,
          satisfiedCount AS satisfiedCount,
          toleratingCount AS toleratingCount,
          apdexScore AS apdexScore,
          estimatedSpanCount AS estimatedSpanCount
        FROM __series_base
        WHERE groupName IN (SELECT
          groupName AS groupName
        FROM (SELECT
          groupName AS groupName,
          max(count) AS rank
        FROM __series_base
        GROUP BY groupName
        ORDER BY rank DESC
        LIMIT 10) AS ranked)
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-minutely-grouped:baseline  [0ec9c1af]
SELECT
          bucket AS bucket,
          groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(bCount) AS spanCount,
          if(sum(bCount) > 0, sum(bDurationSum) / sum(bCount) / 1000000, 0) AS avgDuration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99Duration,
          if(sum(bCount) > 0, sum(bErrorCount) / sum(bCount), 0) AS errorRate,
          sum(bSatisfiedCount) AS satisfiedCount,
          sum(bToleratingCount) AS toleratingCount,
          if(sum(bCount) > 0, round(sum(bSatisfiedCount) / sum(bCount) + sum(bToleratingCount) * 0.5 / sum(bCount), 4), 0) AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(ServiceName), ''), 'all') AS groupName,
          count() AS bCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-03 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv IN ('production')
          AND (Timestamp < if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(Minute, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(ServiceName), ''), 'all') AS groupName,
          sum(SpanCount) AS bCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_minutely
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND DeploymentEnv IN ('production')
          AND Minute >= if(toDateTime('2026-01-03 10:30:00') = toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')), toStartOfMinute(toDateTime('2026-01-03 10:30:00')) + INTERVAL 1 MINUTE)
          AND Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual-rejected-status-code:baseline  [4541b40c]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket,
          coalesce(nullIf(toString(StatusCode), ''), 'all') AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 500)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 500 AND Duration / 1000000 < 2000))) * 0.5 / count(), 4), 0) AS apdexScore,
          sum(SampleRate) AS estimatedSpanCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-annual:baseline  [503dc5ba]
SELECT
          bucket AS bucket,
          groupName AS groupName,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count,
          sum(bCount) AS spanCount,
          if(sum(bCount) > 0, sum(bDurationSum) / sum(bCount) / 1000000, 0) AS avgDuration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000 AS p50Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000 AS p95Duration,
          arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000 AS p99Duration,
          if(sum(bCount) > 0, sum(bErrorCount) / sum(bCount), 0) AS errorRate,
          sum(bSatisfiedCount) AS satisfiedCount,
          sum(bToleratingCount) AS toleratingCount,
          if(sum(bCount) > 0, round(sum(bSatisfiedCount) / sum(bCount) + sum(bToleratingCount) * 0.5 / sum(bCount), 4), 0) AS apdexScore,
          if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount
        FROM (
SELECT
          toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          count() AS bCount,
          sum(SampleRate) AS bEstimatedSpanCount,
          countIf(StatusCode = 'Error') AS bErrorCount,
          sum(toFloat64(Duration)) AS bDurationSum,
          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS bDurationQuantiles,
          countIf((StatusCode != 'Error' AND Duration < 500000000)) AS bSatisfiedCount,
          countIf(((StatusCode != 'Error' AND Duration >= 500000000) AND Duration < 2000000000)) AS bToleratingCount
        FROM service_overview_spans
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND DeploymentEnv IN ('production')
          AND (Timestamp < if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE) OR Timestamp >= toStartOfMinute(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(Minute, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(SpanCount) AS bCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_minutely
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND DeploymentEnv IN ('production')
          AND Minute >= if(toDateTime('2026-01-01 10:30:00') = toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')), toStartOfMinute(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 MINUTE)
          AND Minute < toStartOfMinute(toDateTime('2026-01-03 14:15:00'))
          AND (Minute < if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR) OR Minute >= toStartOfHour(toDateTime('2026-01-03 14:15:00')))
        GROUP BY bucket, groupName
UNION ALL
SELECT
          toStartOfInterval(Hour, INTERVAL 3600 SECOND) AS bucket,
          'all' AS groupName,
          sum(SpanCount) AS bCount,
          sum(EstimatedSpanCount) AS bEstimatedSpanCount,
          sum(ErrorCount) AS bErrorCount,
          sum(DurationSum) AS bDurationSum,
          quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles) AS bDurationQuantiles,
          sum(ApdexSatisfiedCount) AS bSatisfiedCount,
          sum(ApdexToleratingCount) AS bToleratingCount
        FROM service_overview_hourly
        WHERE OrgId = 'org_sql_catalog'
          AND ServiceName = 'api'
          AND DeploymentEnv IN ('production')
          AND Hour >= if(toDateTime('2026-01-01 10:30:00') = toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')), toStartOfHour(toDateTime('2026-01-01 10:30:00')) + INTERVAL 1 HOUR)
          AND Hour < toStartOfHour(toDateTime('2026-01-03 14:15:00'))
        GROUP BY bucket, groupName
) AS service_metric_windows
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-apdex:baseline  [40ead943]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 300 SECOND) AS bucket,
          'all' AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          0 AS errorRate,
          countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 250)) AS satisfiedCount,
          countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 250 AND Duration / 1000000 < 1000))) AS toleratingCount,
          if(count() > 0, round(countIf((NOT (StatusCode = 'Error') AND Duration / 1000000 < 250)) / count() + countIf((NOT (StatusCode = 'Error') AND (Duration / 1000000 >= 250 AND Duration / 1000000 < 1000))) * 0.5 / count(), 4), 0) AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-attribute-filtered:baseline  [60608c7f]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 300 SECOND) AS bucket,
          'all' AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET'
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-attribute-filtered:bloom  [fa85ef4d]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 300 SECOND) AS bucket,
          'all' AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND (((has(mapKeys(SpanAttributes), 'http.method') OR has(mapKeys(SpanAttributes), 'http.request.method')) AND has(mapValues(SpanAttributes), 'GET')) AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-attribute-filtered:text  [08a8ac59]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 300 SECOND) AS bucket,
          'all' AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
          AND ((has(SpanAttributeItems, concat('http.method', char(31), 'GET')) OR has(SpanAttributeItems, concat('http.request.method', char(31), 'GET'))) AND if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-raw:baseline  [702c5f01]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 60 SECOND) AS bucket,
          'all' AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-03 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-raw:bloom  [702c5f01]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 60 SECOND) AS bucket,
          'all' AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-03 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-raw:text  [702c5f01]
SELECT
          toStartOfInterval(Timestamp, INTERVAL 60 SECOND) AS bucket,
          'all' AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-03 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON

-- spec:traces-timeseries-series-cap:baseline  [3d39b07d]
WITH __series_base AS (
SELECT
          toStartOfInterval(Timestamp, INTERVAL 300 SECOND) AS bucket,
          coalesce(nullIf(toString(SpanName), ''), 'all') AS groupName,
          sum(SampleRate) AS count,
          count() AS spanCount,
          0 AS avgDuration,
          0 AS p50Duration,
          0 AS p95Duration,
          0 AS p99Duration,
          0 AS errorRate,
          0 AS satisfiedCount,
          0 AS toleratingCount,
          0 AS apdexScore,
          0 AS estimatedSpanCount
        FROM traces
        WHERE OrgId = 'org_sql_catalog'
          AND Timestamp >= '2026-01-01 10:30:00'
          AND Timestamp <= '2026-01-03 14:15:00'
          AND ServiceName = 'api'
          AND coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
)
SELECT
          bucket AS bucket,
          groupName AS groupName,
          count AS count,
          spanCount AS spanCount,
          avgDuration AS avgDuration,
          p50Duration AS p50Duration,
          p95Duration AS p95Duration,
          p99Duration AS p99Duration,
          errorRate AS errorRate,
          satisfiedCount AS satisfiedCount,
          toleratingCount AS toleratingCount,
          apdexScore AS apdexScore,
          estimatedSpanCount AS estimatedSpanCount
        FROM __series_base
        WHERE groupName IN (SELECT
          groupName AS groupName
        FROM (SELECT
          groupName AS groupName,
          max(count) AS rank
        FROM __series_base
        GROUP BY groupName
        ORDER BY rank DESC
        LIMIT 10) AS ranked)
        ORDER BY bucket ASC, groupName ASC
        FORMAT JSON