ALTER TABLE `alert_rules` ADD COLUMN `query_spec_json` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE `alert_rules` ADD COLUMN `reducer` text NOT NULL DEFAULT 'identity';
--> statement-breakpoint
ALTER TABLE `alert_rules` ADD COLUMN `sample_count_strategy` text NOT NULL DEFAULT 'trace_count';
--> statement-breakpoint
ALTER TABLE `alert_rules` ADD COLUMN `no_data_behavior` text NOT NULL DEFAULT 'skip';
--> statement-breakpoint

UPDATE `alert_rules`
SET
  `query_spec_json` = CASE
    WHEN `signal_type` = 'metric' AND `service_name` IS NOT NULL THEN json_object(
      'kind', 'timeseries',
      'source', 'metrics',
      'metric', `metric_aggregation`,
      'groupBy', json_array('none'),
      'bucketSeconds', CASE WHEN `window_minutes` * 60 > 60 THEN `window_minutes` * 60 ELSE 60 END,
      'filters', json_object(
        'metricName', `metric_name`,
        'metricType', `metric_type`,
        'serviceName', `service_name`
      )
    )
    WHEN `signal_type` = 'metric' THEN json_object(
      'kind', 'timeseries',
      'source', 'metrics',
      'metric', `metric_aggregation`,
      'groupBy', json_array('none'),
      'bucketSeconds', CASE WHEN `window_minutes` * 60 > 60 THEN `window_minutes` * 60 ELSE 60 END,
      'filters', json_object(
        'metricName', `metric_name`,
        'metricType', `metric_type`
      )
    )
    WHEN `signal_type` = 'apdex' AND `service_name` IS NOT NULL THEN json_object(
      'kind', 'timeseries',
      'source', 'traces',
      'metric', 'apdex',
      'apdexThresholdMs', coalesce(`apdex_threshold_ms`, 500),
      'groupBy', json_array('none'),
      'bucketSeconds', CASE WHEN `window_minutes` * 60 > 60 THEN `window_minutes` * 60 ELSE 60 END,
      'filters', json_object(
        'serviceName', `service_name`,
        'rootSpansOnly', json('true')
      )
    )
    WHEN `signal_type` = 'apdex' THEN json_object(
      'kind', 'timeseries',
      'source', 'traces',
      'metric', 'apdex',
      'apdexThresholdMs', coalesce(`apdex_threshold_ms`, 500),
      'groupBy', json_array('none'),
      'bucketSeconds', CASE WHEN `window_minutes` * 60 > 60 THEN `window_minutes` * 60 ELSE 60 END,
      'filters', json_object(
        'rootSpansOnly', json('true')
      )
    )
    WHEN `service_name` IS NOT NULL THEN json_object(
      'kind', 'timeseries',
      'source', 'traces',
      'metric', CASE
        WHEN `signal_type` = 'error_rate' THEN 'error_rate'
        WHEN `signal_type` = 'throughput' THEN 'count'
        WHEN `signal_type` = 'p95_latency' THEN 'p95_duration'
        WHEN `signal_type` = 'p99_latency' THEN 'p99_duration'
      END,
      'groupBy', json_array('none'),
      'bucketSeconds', CASE WHEN `window_minutes` * 60 > 60 THEN `window_minutes` * 60 ELSE 60 END,
      'filters', json_object(
        'serviceName', `service_name`
      )
    )
    ELSE json_object(
      'kind', 'timeseries',
      'source', 'traces',
      'metric', CASE
        WHEN `signal_type` = 'error_rate' THEN 'error_rate'
        WHEN `signal_type` = 'throughput' THEN 'count'
        WHEN `signal_type` = 'p95_latency' THEN 'p95_duration'
        WHEN `signal_type` = 'p99_latency' THEN 'p99_duration'
      END,
      'groupBy', json_array('none'),
      'bucketSeconds', CASE WHEN `window_minutes` * 60 > 60 THEN `window_minutes` * 60 ELSE 60 END
    )
  END,
  `reducer` = 'identity',
  `sample_count_strategy` = CASE
    WHEN `signal_type` = 'metric' THEN 'metric_data_points'
    ELSE 'trace_count'
  END,
  `no_data_behavior` = CASE
    WHEN `signal_type` = 'throughput' AND `comparator` IN ('lt', 'lte') THEN 'zero'
    ELSE 'skip'
  END;
