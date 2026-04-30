package mapleexporter

import (
	"context"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.uber.org/zap"

	"github.com/superwall/maple/packages/otel-collector-maple-exporter/internal"
)

type tracesExporter struct {
	cfg    *Config
	logger *zap.Logger
	client *internal.Client
}

func newTracesExporter(logger *zap.Logger, cfg *Config) (*tracesExporter, error) {
	return &tracesExporter{cfg: cfg, logger: logger}, nil
}

func (t *tracesExporter) start(_ context.Context, _ component.Host) error {
	c, err := internal.NewClient(internal.ClientOptions{
		Endpoint: t.cfg.Endpoint,
		User:     t.cfg.Username,
		Password: string(t.cfg.Password),
		Database: t.cfg.Database,
		Timeout:  t.cfg.TimeoutConfig.Timeout,
	})
	if err != nil {
		return err
	}
	t.client = c
	return nil
}

func (t *tracesExporter) shutdown(_ context.Context) error { return nil }

// pushTraces walks the pdata.Traces tree and INSERTs one JSON row per span
// into Maple's `traces` table. Materialized views inside ClickHouse fan
// these out into:
//   - error_events / error_spans          (StatusCode = 'Error')
//   - service_overview_spans              (entry-point spans)
//   - service_map_spans / _children       (parent/child span linkage)
//   - service_map_edges_hourly            (Client + peer.service)
//   - trace_list_mv / trace_detail_spans  (UI list/detail views)
//   - traces_aggregates_hourly            (latency p50/p95/p99)
//   - service_usage_traces_mv             (per-service trace counts)
//   - trace_resource/span attribute_keys / values_mv (search facets)
//
// We only need to insert into `traces`. The MVs handle the rest.
func (t *tracesExporter) pushTraces(ctx context.Context, td ptrace.Traces) error {
	rows := make([][]byte, 0, td.SpanCount())

	rs := td.ResourceSpans()
	for i := 0; i < rs.Len(); i++ {
		r := rs.At(i)
		resource := r.Resource()
		resourceAttrs := internal.AttrMap(resource.Attributes())
		resourceSchemaURL := r.SchemaUrl()
		serviceName := internal.ServiceName(resource.Attributes())
		orgID := internal.ResolveOrgID(resource.Attributes(), t.cfg.OrgID)

		ss := r.ScopeSpans()
		for j := 0; j < ss.Len(); j++ {
			scope := ss.At(j).Scope()
			scopeAttrs := internal.AttrMap(scope.Attributes())
			scopeName := scope.Name()
			scopeVersion := scope.Version()
			scopeSchemaURL := ss.At(j).SchemaUrl()

			spans := ss.At(j).Spans()
			for k := 0; k < spans.Len(); k++ {
				span := spans.At(k)
				row := encodeTraceRow(
					orgID,
					serviceName,
					resourceAttrs,
					resourceSchemaURL,
					scopeAttrs,
					scopeName,
					scopeVersion,
					scopeSchemaURL,
					span,
				)
				b, err := internal.MarshalRow(t.cfg.TracesTableName, row)
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
	return t.client.InsertJSONEachRow(ctx, t.cfg.TracesTableName, rows)
}

// encodeTraceRow shapes one span into Maple's `traces` table layout. Fields
// that have ClickHouse DEFAULT expressions (`SampleRate`, `IsEntryPoint`)
// are intentionally omitted so CH computes them server-side from the
// `TraceState` and `SpanKind`/`ParentSpanId` columns we provide.
func encodeTraceRow(
	orgID, serviceName string,
	resourceAttrs map[string]string,
	resourceSchemaURL string,
	scopeAttrs map[string]string,
	scopeName, scopeVersion, scopeSchemaURL string,
	span ptrace.Span,
) map[string]any {
	durationNs := uint64(0)
	end := span.EndTimestamp().AsTime()
	start := span.StartTimestamp().AsTime()
	if !end.IsZero() && !start.IsZero() && end.After(start) {
		durationNs = uint64(end.Sub(start).Nanoseconds())
	}

	events := span.Events()
	eventsTimestamp := make([]string, events.Len())
	eventsName := make([]string, events.Len())
	eventsAttributes := make([]map[string]string, events.Len())
	for i := 0; i < events.Len(); i++ {
		ev := events.At(i)
		eventsTimestamp[i] = internal.FormatTimestampNano(uint64(ev.Timestamp()))
		eventsName[i] = ev.Name()
		eventsAttributes[i] = internal.AttrMap(ev.Attributes())
	}

	links := span.Links()
	linksTraceID := make([]string, links.Len())
	linksSpanID := make([]string, links.Len())
	linksTraceState := make([]string, links.Len())
	linksAttributes := make([]map[string]string, links.Len())
	for i := 0; i < links.Len(); i++ {
		l := links.At(i)
		tid := l.TraceID()
		sid := l.SpanID()
		linksTraceID[i] = internal.BytesHex(tid[:])
		linksSpanID[i] = internal.BytesHex(sid[:])
		linksTraceState[i] = l.TraceState().AsRaw()
		linksAttributes[i] = internal.AttrMap(l.Attributes())
	}

	tid := span.TraceID()
	sid := span.SpanID()
	psid := span.ParentSpanID()

	// BytesHex returns "" for all-zero input, which is what Maple's
	// `trace_list_mv` MV filter (`WHERE ParentSpanId = ''`) expects for
	// root spans.
	return map[string]any{
		"OrgId":             orgID,
		"Timestamp":         internal.FormatTimestampNano(uint64(span.StartTimestamp())),
		"TraceId":           internal.BytesHex(tid[:]),
		"SpanId":            internal.BytesHex(sid[:]),
		"ParentSpanId":      internal.BytesHex(psid[:]),
		"TraceState":        span.TraceState().AsRaw(),
		"SpanName":          span.Name(),
		"SpanKind":          internal.SpanKindString(int32(span.Kind())),
		"ServiceName":       serviceName,
		"ResourceSchemaUrl": resourceSchemaURL,
		"ResourceAttributes": resourceAttrs,
		"ScopeSchemaUrl":    scopeSchemaURL,
		"ScopeName":         scopeName,
		"ScopeVersion":      scopeVersion,
		"ScopeAttributes":   scopeAttrs,
		"Duration":          durationNs,
		"StatusCode":        internal.StatusCodeString(int32(span.Status().Code())),
		"StatusMessage":     span.Status().Message(),
		"SpanAttributes":    internal.AttrMap(span.Attributes()),
		"EventsTimestamp":   eventsTimestamp,
		"EventsName":        eventsName,
		"EventsAttributes":  eventsAttributes,
		"LinksTraceId":      linksTraceID,
		"LinksSpanId":       linksSpanID,
		"LinksTraceState":   linksTraceState,
		"LinksAttributes":   linksAttributes,
	}
}

// silence unused import warning during incremental build
var _ pcommon.Map
