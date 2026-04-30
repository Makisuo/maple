package mapleexporter

import (
	"errors"
	"fmt"
	"net/url"
	"time"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/config/configopaque"
	"go.opentelemetry.io/collector/config/configoptional"
	"go.opentelemetry.io/collector/config/configretry"
	"go.opentelemetry.io/collector/exporter/exporterhelper"
)

// Config defines the Maple exporter configuration.
//
// The exporter writes OpenTelemetry traces, logs, and metrics into Maple's
// bespoke ClickHouse schema (`traces`, `logs`, `metrics_sum`, `metrics_gauge`,
// `metrics_histogram`, `metrics_exponential_histogram`). Maple's UI/API reads
// the same tables directly. Materialized views inside ClickHouse fan
// per-base-table inserts out into the derived aggregate / detail tables.
type Config struct {
	exporterhelper.TimeoutConfig `mapstructure:",squash"`
	configretry.BackOffConfig    `mapstructure:"retry_on_failure"`
	QueueBatch                   configoptional.Optional[exporterhelper.QueueBatchConfig] `mapstructure:"sending_queue"`

	// Endpoint is the ClickHouse HTTP base URL — no trailing slash, no path.
	// Example: "http://clickhouse-clickhouse.clickhouse.svc.cluster.local:8123"
	// or "https://ch.superwall.dev".
	Endpoint string `mapstructure:"endpoint"`

	// Database is the ClickHouse database holding Maple's schema. Defaults to
	// "default".
	Database string `mapstructure:"database"`

	// Username for HTTP basic auth on the ClickHouse HTTP interface.
	Username string `mapstructure:"username"`

	// Password for HTTP basic auth.
	Password configopaque.String `mapstructure:"password"`

	// OrgID is the Maple organization id stamped onto every row's `OrgId`
	// column. By default this value wins unconditionally — no upstream
	// processor required.
	OrgID string `mapstructure:"org_id"`

	// OrgIDFromResourceAttribute, when set, makes the exporter read the
	// org id off this resource attribute on each record instead of using
	// the static `OrgID`. Used for multi-tenant fan-out where a single
	// collector serves several Maple orgs. If the attribute is missing or
	// empty on a given record, the static `OrgID` is used as a fallback.
	//
	// Most deployments leave this empty. Set to e.g. `"maple_org_id"` if
	// you have an upstream processor stamping per-record org ids.
	OrgIDFromResourceAttribute string `mapstructure:"org_id_from_resource_attribute"`

	// Table name overrides. Defaults match Maple's migration output.
	TracesTableName                      string `mapstructure:"traces_table_name"`
	LogsTableName                        string `mapstructure:"logs_table_name"`
	MetricsSumTableName                  string `mapstructure:"metrics_sum_table_name"`
	MetricsGaugeTableName                string `mapstructure:"metrics_gauge_table_name"`
	MetricsHistogramTableName            string `mapstructure:"metrics_histogram_table_name"`
	MetricsExponentialHistogramTableName string `mapstructure:"metrics_exponential_histogram_table_name"`
}

var _ component.Config = (*Config)(nil)

// Validate checks the configuration for errors.
func (c *Config) Validate() error {
	if c.Endpoint == "" {
		return errors.New("endpoint must be set")
	}
	u, err := url.Parse(c.Endpoint)
	if err != nil {
		return fmt.Errorf("endpoint is not a valid URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("endpoint must be http or https, got %q", u.Scheme)
	}
	if c.OrgID == "" {
		return errors.New("org_id must be set (matches Maple's `maple_org_id` resource attribute)")
	}
	if c.TimeoutConfig.Timeout <= 0 {
		return errors.New("timeout must be positive")
	}
	return nil
}

// withDefaults returns a copy with zero-valued table names populated to
// Maple's expected defaults.
func (c *Config) withDefaults() *Config {
	cp := *c
	if cp.Database == "" {
		cp.Database = "default"
	}
	if cp.TracesTableName == "" {
		cp.TracesTableName = "traces"
	}
	if cp.LogsTableName == "" {
		cp.LogsTableName = "logs"
	}
	if cp.MetricsSumTableName == "" {
		cp.MetricsSumTableName = "metrics_sum"
	}
	if cp.MetricsGaugeTableName == "" {
		cp.MetricsGaugeTableName = "metrics_gauge"
	}
	if cp.MetricsHistogramTableName == "" {
		cp.MetricsHistogramTableName = "metrics_histogram"
	}
	if cp.MetricsExponentialHistogramTableName == "" {
		cp.MetricsExponentialHistogramTableName = "metrics_exponential_histogram"
	}
	return &cp
}

func defaultTimeoutConfig() exporterhelper.TimeoutConfig {
	return exporterhelper.TimeoutConfig{Timeout: 30 * time.Second}
}
