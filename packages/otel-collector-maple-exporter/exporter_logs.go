package mapleexporter

import (
	"context"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.uber.org/zap"

	"github.com/superwall/maple/packages/otel-collector-maple-exporter/internal"
)

type logsExporter struct {
	cfg    *Config
	logger *zap.Logger
	client *internal.Client
}

func newLogsExporter(logger *zap.Logger, cfg *Config) (*logsExporter, error) {
	return &logsExporter{cfg: cfg, logger: logger}, nil
}

func (l *logsExporter) start(_ context.Context, _ component.Host) error {
	c, err := internal.NewClient(internal.ClientOptions{
		Endpoint: l.cfg.Endpoint,
		User:     l.cfg.Username,
		Password: string(l.cfg.Password),
		Database: l.cfg.Database,
		Timeout:  l.cfg.TimeoutConfig.Timeout,
	})
	if err != nil {
		return err
	}
	l.client = c
	return nil
}

func (l *logsExporter) shutdown(_ context.Context) error { return nil }

// pushLogs walks pdata.Logs and INSERTs one row per log record into the
// `logs` table. Maple's `logs_aggregates_hourly_mv` and the log_attribute /
// service_usage_logs MVs derive everything else from base inserts.
//
// `Timestamp` (DateTime64(9)) and `TimestampTime` (DateTime, second
// precision, used by partition + sort key) are written from the log record's
// Timestamp(). When that is zero we fall back to ObservedTimestamp() so logs
// with only an arrival time still partition cleanly.
func (l *logsExporter) pushLogs(ctx context.Context, ld plog.Logs) error {
	rows := make([][]byte, 0, ld.LogRecordCount())

	rl := ld.ResourceLogs()
	for i := 0; i < rl.Len(); i++ {
		r := rl.At(i)
		resource := r.Resource()
		resourceAttrs := internal.AttrMap(resource.Attributes())
		resourceSchemaURL := r.SchemaUrl()
		serviceName := internal.ServiceName(resource.Attributes())
		orgID := internal.ResolveOrgID(resource.Attributes(), l.cfg.OrgID)

		sl := r.ScopeLogs()
		for j := 0; j < sl.Len(); j++ {
			scope := sl.At(j).Scope()
			scopeAttrs := internal.AttrMap(scope.Attributes())
			scopeName := scope.Name()
			scopeVersion := scope.Version()
			scopeSchemaURL := sl.At(j).SchemaUrl()

			records := sl.At(j).LogRecords()
			for k := 0; k < records.Len(); k++ {
				lr := records.At(k)
				ts := uint64(lr.Timestamp())
				if ts == 0 {
					ts = uint64(lr.ObservedTimestamp())
				}

				tid := lr.TraceID()
				sid := lr.SpanID()

				severityText := lr.SeverityText()
				if severityText == "" {
					severityText = internal.SeverityNumberToText(int32(lr.SeverityNumber()))
				}

				row := map[string]any{
					"OrgId":              orgID,
					"Timestamp":          internal.FormatTimestampNano(ts),
					"TimestampTime":      internal.FormatDateTime(ts),
					"TraceId":            internal.BytesHex(tid[:]),
					"SpanId":             internal.BytesHex(sid[:]),
					"TraceFlags":         uint32(lr.Flags()),
					"SeverityText":       severityText,
					"SeverityNumber":     uint32(lr.SeverityNumber()),
					"ServiceName":        serviceName,
					"Body":               lr.Body().AsString(),
					"ResourceSchemaUrl":  resourceSchemaURL,
					"ResourceAttributes": resourceAttrs,
					"ScopeSchemaUrl":     scopeSchemaURL,
					"ScopeName":          scopeName,
					"ScopeVersion":       scopeVersion,
					"ScopeAttributes":    scopeAttrs,
					"LogAttributes":      internal.AttrMap(lr.Attributes()),
				}

				b, err := internal.MarshalRow(l.cfg.LogsTableName, row)
				if err != nil {
					return err
				}
				rows = append(rows, b)
			}
		}
	}

	if len(rows) == 0 {
		return nil
	}
	return l.client.InsertJSONEachRow(ctx, l.cfg.LogsTableName, rows)
}
