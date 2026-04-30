package mapleexporter

import (
	"context"
	"testing"

	"go.opentelemetry.io/collector/component/componenttest"
	"go.opentelemetry.io/collector/config/configopaque"
	"go.opentelemetry.io/collector/exporter/exportertest"
)

func TestFactory_Type(t *testing.T) {
	f := NewFactory()
	if f.Type() != componentType {
		t.Fatalf("type %q != %q", f.Type(), componentType)
	}
}

func TestFactory_DefaultConfig(t *testing.T) {
	cfg := NewFactory().CreateDefaultConfig().(*Config)
	if cfg.Database != "default" {
		t.Errorf("Database = %q, want default", cfg.Database)
	}
	if cfg.TimeoutConfig.Timeout == 0 {
		t.Errorf("Timeout must default to non-zero")
	}
	// In current exporterhelper, "queue enabled" is expressed by the Optional
	// wrapper carrying a value. Default config gets a Default-wrapped queue.
	if !cfg.QueueBatch.HasValue() {
		t.Errorf("QueueBatch should be present by default")
	}
}

func TestConfig_Validate(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*Config)
		wantErr bool
	}{
		{
			name:    "default_missing_endpoint_and_org",
			mutate:  func(c *Config) {},
			wantErr: true,
		},
		{
			name: "valid_minimal",
			mutate: func(c *Config) {
				c.Endpoint = "https://ch.superwall.dev"
				c.OrgID = "org_x"
			},
			wantErr: false,
		},
		{
			name: "missing_org",
			mutate: func(c *Config) {
				c.Endpoint = "https://ch.superwall.dev"
			},
			wantErr: true,
		},
		{
			name: "invalid_url",
			mutate: func(c *Config) {
				c.Endpoint = "://not a url"
				c.OrgID = "org_x"
			},
			wantErr: true,
		},
		{
			name: "wrong_scheme",
			mutate: func(c *Config) {
				c.Endpoint = "ftp://example.com"
				c.OrgID = "org_x"
			},
			wantErr: true,
		},
		{
			name: "zero_timeout",
			mutate: func(c *Config) {
				c.Endpoint = "https://ch.superwall.dev"
				c.OrgID = "org_x"
				c.TimeoutConfig.Timeout = 0
			},
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := NewFactory().CreateDefaultConfig().(*Config)
			tc.mutate(cfg)
			err := cfg.Validate()
			if (err != nil) != tc.wantErr {
				t.Fatalf("Validate err = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}

func TestConfig_WithDefaults(t *testing.T) {
	c := &Config{}
	out := c.withDefaults()
	if out.Database != "default" {
		t.Errorf("Database default")
	}
	if out.TracesTableName != "traces" {
		t.Errorf("TracesTableName default")
	}
	if out.LogsTableName != "logs" {
		t.Errorf("LogsTableName default")
	}
	if out.MetricsSumTableName != "metrics_sum" {
		t.Errorf("MetricsSumTableName default")
	}
	if out.MetricsGaugeTableName != "metrics_gauge" {
		t.Errorf("MetricsGaugeTableName default")
	}
	if out.MetricsHistogramTableName != "metrics_histogram" {
		t.Errorf("MetricsHistogramTableName default")
	}
	if out.MetricsExponentialHistogramTableName != "metrics_exponential_histogram" {
		t.Errorf("MetricsExponentialHistogramTableName default")
	}
}

func TestConfig_WithDefaults_RespectsOverrides(t *testing.T) {
	c := &Config{
		Database:        "maple_prod",
		TracesTableName: "custom_traces",
	}
	out := c.withDefaults()
	if out.Database != "maple_prod" {
		t.Errorf("Database override lost")
	}
	if out.TracesTableName != "custom_traces" {
		t.Errorf("TracesTableName override lost")
	}
	// And the un-set fields still get defaults.
	if out.LogsTableName != "logs" {
		t.Errorf("LogsTableName should fall through to default")
	}
}

func TestFactory_CreatesAllExporters(t *testing.T) {
	// Smoke-test that the factory can construct each exporter with a valid
	// config. We don't start them — just want to confirm the wiring compiles
	// and there are no panics in defaults.
	f := NewFactory()
	cfg := f.CreateDefaultConfig().(*Config)
	cfg.Endpoint = "https://ch.example.com"
	cfg.OrgID = "org_x"
	cfg.Username = "u"
	cfg.Password = configopaque.String("p")

	ctx := context.Background()
	set := exportertest.NewNopSettings(componentType)

	if _, err := f.CreateTraces(ctx, set, cfg); err != nil {
		t.Errorf("CreateTraces: %v", err)
	}
	if _, err := f.CreateLogs(ctx, set, cfg); err != nil {
		t.Errorf("CreateLogs: %v", err)
	}
	if _, err := f.CreateMetrics(ctx, set, cfg); err != nil {
		t.Errorf("CreateMetrics: %v", err)
	}
	_ = componenttest.NewNopHost
}
