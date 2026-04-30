// Package mapleexporter exports OTLP traces, logs, and metrics into Maple's
// bespoke ClickHouse schema. It is meant to be built into a custom
// otel-collector binary via OpenTelemetry Collector Builder (`ocb`) — see
// deploy/k8s-infra/builder-config.yaml.
//
// Why a custom exporter instead of using the contrib `clickhouse` exporter?
// The contrib exporter writes a fixed `otel_traces` / `otel_logs` /
// `otel_metrics_*` schema. Maple's UI and API read from `traces` / `logs` /
// `metrics_*` with bespoke columns (e.g. `OrgId`, `TimestampTime`, materialized
// views fanning out into derived tables). This exporter writes that schema
// directly, end-to-end, without a translation layer.
package mapleexporter

import (
	"context"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/config/configoptional"
	"go.opentelemetry.io/collector/config/configretry"
	"go.opentelemetry.io/collector/exporter"
	"go.opentelemetry.io/collector/exporter/exporterhelper"
)

// componentType is the canonical identifier this exporter registers as in
// otel-collector configs (`exporters: { maple: { ... } }`).
var componentType = component.MustNewType("maple")

// NewFactory creates a factory for the maple exporter.
func NewFactory() exporter.Factory {
	return exporter.NewFactory(
		componentType,
		createDefaultConfig,
		exporter.WithTraces(createTracesExporter, component.StabilityLevelAlpha),
		exporter.WithLogs(createLogsExporter, component.StabilityLevelAlpha),
		exporter.WithMetrics(createMetricsExporter, component.StabilityLevelAlpha),
	)
}

func createDefaultConfig() component.Config {
	return &Config{
		TimeoutConfig: defaultTimeoutConfig(),
		BackOffConfig: configretry.NewDefaultBackOffConfig(),
		QueueBatch:    configoptional.Some(exporterhelper.NewDefaultQueueConfig()),
		Database:      "default",
	}
}

func createTracesExporter(
	ctx context.Context,
	set exporter.Settings,
	cfg component.Config,
) (exporter.Traces, error) {
	c := cfg.(*Config).withDefaults()
	tx, err := newTracesExporter(set.Logger, c)
	if err != nil {
		return nil, err
	}
	return exporterhelper.NewTraces(
		ctx,
		set,
		cfg,
		tx.pushTraces,
		exporterhelper.WithStart(tx.start),
		exporterhelper.WithShutdown(tx.shutdown),
		exporterhelper.WithTimeout(c.TimeoutConfig),
		exporterhelper.WithRetry(c.BackOffConfig),
		exporterhelper.WithQueue(c.QueueBatch),
	)
}

func createLogsExporter(
	ctx context.Context,
	set exporter.Settings,
	cfg component.Config,
) (exporter.Logs, error) {
	c := cfg.(*Config).withDefaults()
	lx, err := newLogsExporter(set.Logger, c)
	if err != nil {
		return nil, err
	}
	return exporterhelper.NewLogs(
		ctx,
		set,
		cfg,
		lx.pushLogs,
		exporterhelper.WithStart(lx.start),
		exporterhelper.WithShutdown(lx.shutdown),
		exporterhelper.WithTimeout(c.TimeoutConfig),
		exporterhelper.WithRetry(c.BackOffConfig),
		exporterhelper.WithQueue(c.QueueBatch),
	)
}

func createMetricsExporter(
	ctx context.Context,
	set exporter.Settings,
	cfg component.Config,
) (exporter.Metrics, error) {
	c := cfg.(*Config).withDefaults()
	mx, err := newMetricsExporter(set.Logger, c)
	if err != nil {
		return nil, err
	}
	return exporterhelper.NewMetrics(
		ctx,
		set,
		cfg,
		mx.pushMetrics,
		exporterhelper.WithStart(mx.start),
		exporterhelper.WithShutdown(mx.shutdown),
		exporterhelper.WithTimeout(c.TimeoutConfig),
		exporterhelper.WithRetry(c.BackOffConfig),
		exporterhelper.WithQueue(c.QueueBatch),
	)
}
