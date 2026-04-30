package mapleexporter

import (
	"context"
	"fmt"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.uber.org/zap"

	"github.com/superwall/maple/packages/otel-collector-maple-exporter/internal"
)

type metricsExporter struct {
	cfg    *Config
	logger *zap.Logger
	client *internal.Client
}

func newMetricsExporter(logger *zap.Logger, cfg *Config) (*metricsExporter, error) {
	return &metricsExporter{cfg: cfg, logger: logger}, nil
}

func (m *metricsExporter) start(_ context.Context, _ component.Host) error {
	c, err := internal.NewClient(internal.ClientOptions{
		Endpoint: m.cfg.Endpoint,
		User:     m.cfg.Username,
		Password: string(m.cfg.Password),
		Database: m.cfg.Database,
		Timeout:  m.cfg.TimeoutConfig.Timeout,
	})
	if err != nil {
		return err
	}
	m.client = c
	return nil
}

func (m *metricsExporter) shutdown(_ context.Context) error { return nil }

// pushMetrics fans pdata.Metrics into four buckets — sum / gauge / histogram /
// exponential_histogram — each written to its dedicated Maple table.
//
// One inbound `pmetric.Metrics` message can mix metric types; we accumulate
// per-table row buffers and emit one INSERT per non-empty bucket.
func (m *metricsExporter) pushMetrics(ctx context.Context, md pmetric.Metrics) error {
	var (
		sumRows                  [][]byte
		gaugeRows                [][]byte
		histogramRows            [][]byte
		exponentialHistogramRows [][]byte
	)

	rm := md.ResourceMetrics()
	for i := 0; i < rm.Len(); i++ {
		r := rm.At(i)
		resource := r.Resource()
		resourceAttrs := internal.AttrMap(resource.Attributes())
		resourceSchemaURL := r.SchemaUrl()
		serviceName := internal.ServiceName(resource.Attributes())
		orgID := internal.ResolveOrgID(resource.Attributes(), m.cfg.OrgID)

		sm := r.ScopeMetrics()
		for j := 0; j < sm.Len(); j++ {
			scope := sm.At(j).Scope()
			scopeAttrs := internal.AttrMap(scope.Attributes())
			scopeName := scope.Name()
			scopeVersion := scope.Version()
			scopeSchemaURL := sm.At(j).SchemaUrl()

			metrics := sm.At(j).Metrics()
			for k := 0; k < metrics.Len(); k++ {
				metric := metrics.At(k)
				name := metric.Name()
				desc := metric.Description()
				unit := metric.Unit()

				common := commonMetricFields{
					orgID:              orgID,
					resourceAttrs:      resourceAttrs,
					resourceSchemaURL:  resourceSchemaURL,
					scopeAttrs:         scopeAttrs,
					scopeName:          scopeName,
					scopeVersion:       scopeVersion,
					scopeSchemaURL:     scopeSchemaURL,
					serviceName:        serviceName,
					metricName:         name,
					metricDescription:  desc,
					metricUnit:         unit,
				}

				switch metric.Type() {
				case pmetric.MetricTypeSum:
					sum := metric.Sum()
					aggTemp := int32(sum.AggregationTemporality())
					isMonotonic := sum.IsMonotonic()
					dps := sum.DataPoints()
					for d := 0; d < dps.Len(); d++ {
						dp := dps.At(d)
						row := encodeSumRow(common, dp, aggTemp, isMonotonic)
						b, err := internal.MarshalRow(m.cfg.MetricsSumTableName, row)
						if err != nil {
							return err
						}
						sumRows = append(sumRows, b)
					}
				case pmetric.MetricTypeGauge:
					dps := metric.Gauge().DataPoints()
					for d := 0; d < dps.Len(); d++ {
						dp := dps.At(d)
						row := encodeGaugeRow(common, dp)
						b, err := internal.MarshalRow(m.cfg.MetricsGaugeTableName, row)
						if err != nil {
							return err
						}
						gaugeRows = append(gaugeRows, b)
					}
				case pmetric.MetricTypeHistogram:
					hist := metric.Histogram()
					aggTemp := int32(hist.AggregationTemporality())
					dps := hist.DataPoints()
					for d := 0; d < dps.Len(); d++ {
						dp := dps.At(d)
						row := encodeHistogramRow(common, dp, aggTemp)
						b, err := internal.MarshalRow(m.cfg.MetricsHistogramTableName, row)
						if err != nil {
							return err
						}
						histogramRows = append(histogramRows, b)
					}
				case pmetric.MetricTypeExponentialHistogram:
					eh := metric.ExponentialHistogram()
					aggTemp := int32(eh.AggregationTemporality())
					dps := eh.DataPoints()
					for d := 0; d < dps.Len(); d++ {
						dp := dps.At(d)
						row := encodeExponentialHistogramRow(common, dp, aggTemp)
						b, err := internal.MarshalRow(m.cfg.MetricsExponentialHistogramTableName, row)
						if err != nil {
							return err
						}
						exponentialHistogramRows = append(exponentialHistogramRows, b)
					}
				case pmetric.MetricTypeSummary:
					// Maple has no Summary table — silently drop with a warn
					// so misconfigured clients don't fail the whole batch.
					m.logger.Debug("dropping summary metric (no Maple table)", zap.String("metric", name))
				default:
					m.logger.Warn("unknown metric type", zap.String("metric", name), zap.Stringer("type", metric.Type()))
				}
			}
		}
	}

	if err := m.flush(ctx, m.cfg.MetricsSumTableName, sumRows); err != nil {
		return err
	}
	if err := m.flush(ctx, m.cfg.MetricsGaugeTableName, gaugeRows); err != nil {
		return err
	}
	if err := m.flush(ctx, m.cfg.MetricsHistogramTableName, histogramRows); err != nil {
		return err
	}
	if err := m.flush(ctx, m.cfg.MetricsExponentialHistogramTableName, exponentialHistogramRows); err != nil {
		return err
	}
	return nil
}

func (m *metricsExporter) flush(ctx context.Context, table string, rows [][]byte) error {
	if len(rows) == 0 {
		return nil
	}
	if err := m.client.InsertJSONEachRow(ctx, table, rows); err != nil {
		return fmt.Errorf("insert %s: %w", table, err)
	}
	return nil
}

type commonMetricFields struct {
	orgID, resourceSchemaURL, scopeName, scopeVersion, scopeSchemaURL string
	resourceAttrs, scopeAttrs                                         map[string]string
	serviceName, metricName, metricDescription, metricUnit            string
}

func (c commonMetricFields) baseRow(attrs map[string]string, startTime, time uint64) map[string]any {
	return map[string]any{
		"OrgId":              c.orgID,
		"ResourceAttributes": c.resourceAttrs,
		"ResourceSchemaUrl":  c.resourceSchemaURL,
		"ScopeName":          c.scopeName,
		"ScopeVersion":       c.scopeVersion,
		"ScopeAttributes":    c.scopeAttrs,
		"ScopeSchemaUrl":     c.scopeSchemaURL,
		"ServiceName":        c.serviceName,
		"MetricName":         c.metricName,
		"MetricDescription":  c.metricDescription,
		"MetricUnit":         c.metricUnit,
		"Attributes":         attrs,
		"StartTimeUnix":      internal.FormatTimestampNano(startTime),
		"TimeUnix":           internal.FormatTimestampNano(time),
	}
}

func encodeSumRow(c commonMetricFields, dp pmetric.NumberDataPoint, aggTemp int32, isMonotonic bool) map[string]any {
	row := c.baseRow(internal.AttrMap(dp.Attributes()), uint64(dp.StartTimestamp()), uint64(dp.Timestamp()))
	row["Value"] = numberValue(dp)
	row["Flags"] = uint32(dp.Flags())
	traceIDs, spanIDs, timestamps, values, filteredAttrs := encodeExemplars(dp.Exemplars())
	row["ExemplarsTraceId"] = traceIDs
	row["ExemplarsSpanId"] = spanIDs
	row["ExemplarsTimestamp"] = timestamps
	row["ExemplarsValue"] = values
	row["ExemplarsFilteredAttributes"] = filteredAttrs
	row["AggregationTemporality"] = aggTemp
	row["IsMonotonic"] = isMonotonic
	return row
}

func encodeGaugeRow(c commonMetricFields, dp pmetric.NumberDataPoint) map[string]any {
	row := c.baseRow(internal.AttrMap(dp.Attributes()), uint64(dp.StartTimestamp()), uint64(dp.Timestamp()))
	row["Value"] = numberValue(dp)
	row["Flags"] = uint32(dp.Flags())
	traceIDs, spanIDs, timestamps, values, filteredAttrs := encodeExemplars(dp.Exemplars())
	row["ExemplarsTraceId"] = traceIDs
	row["ExemplarsSpanId"] = spanIDs
	row["ExemplarsTimestamp"] = timestamps
	row["ExemplarsValue"] = values
	row["ExemplarsFilteredAttributes"] = filteredAttrs
	return row
}

func encodeHistogramRow(c commonMetricFields, dp pmetric.HistogramDataPoint, aggTemp int32) map[string]any {
	row := c.baseRow(internal.AttrMap(dp.Attributes()), uint64(dp.StartTimestamp()), uint64(dp.Timestamp()))
	row["Count"] = dp.Count()
	row["Sum"] = dp.Sum()
	row["BucketCounts"] = sliceFromUint64(dp.BucketCounts())
	row["ExplicitBounds"] = sliceFromFloat64(dp.ExplicitBounds())
	traceIDs, spanIDs, timestamps, values, filteredAttrs := encodeExemplars(dp.Exemplars())
	row["ExemplarsTraceId"] = traceIDs
	row["ExemplarsSpanId"] = spanIDs
	row["ExemplarsTimestamp"] = timestamps
	row["ExemplarsValue"] = values
	row["ExemplarsFilteredAttributes"] = filteredAttrs
	row["Flags"] = uint32(dp.Flags())
	if dp.HasMin() {
		v := dp.Min()
		row["Min"] = &v
	} else {
		row["Min"] = nil
	}
	if dp.HasMax() {
		v := dp.Max()
		row["Max"] = &v
	} else {
		row["Max"] = nil
	}
	row["AggregationTemporality"] = aggTemp
	return row
}

func encodeExponentialHistogramRow(c commonMetricFields, dp pmetric.ExponentialHistogramDataPoint, aggTemp int32) map[string]any {
	row := c.baseRow(internal.AttrMap(dp.Attributes()), uint64(dp.StartTimestamp()), uint64(dp.Timestamp()))
	row["Count"] = dp.Count()
	row["Sum"] = dp.Sum()
	row["Scale"] = int32(dp.Scale())
	row["ZeroCount"] = dp.ZeroCount()
	row["PositiveOffset"] = int32(dp.Positive().Offset())
	row["PositiveBucketCounts"] = sliceFromUint64(dp.Positive().BucketCounts())
	row["NegativeOffset"] = int32(dp.Negative().Offset())
	row["NegativeBucketCounts"] = sliceFromUint64(dp.Negative().BucketCounts())
	traceIDs, spanIDs, timestamps, values, filteredAttrs := encodeExemplars(dp.Exemplars())
	row["ExemplarsTraceId"] = traceIDs
	row["ExemplarsSpanId"] = spanIDs
	row["ExemplarsTimestamp"] = timestamps
	row["ExemplarsValue"] = values
	row["ExemplarsFilteredAttributes"] = filteredAttrs
	row["Flags"] = uint32(dp.Flags())
	if dp.HasMin() {
		v := dp.Min()
		row["Min"] = &v
	} else {
		row["Min"] = nil
	}
	if dp.HasMax() {
		v := dp.Max()
		row["Max"] = &v
	} else {
		row["Max"] = nil
	}
	row["AggregationTemporality"] = aggTemp
	return row
}

func numberValue(dp pmetric.NumberDataPoint) float64 {
	switch dp.ValueType() {
	case pmetric.NumberDataPointValueTypeDouble:
		return dp.DoubleValue()
	case pmetric.NumberDataPointValueTypeInt:
		return float64(dp.IntValue())
	default:
		return 0
	}
}

func encodeExemplars(exs pmetric.ExemplarSlice) (
	traceIDs []string,
	spanIDs []string,
	timestamps []string,
	values []float64,
	filteredAttrs []map[string]string,
) {
	n := exs.Len()
	traceIDs = make([]string, n)
	spanIDs = make([]string, n)
	timestamps = make([]string, n)
	values = make([]float64, n)
	filteredAttrs = make([]map[string]string, n)
	for i := 0; i < n; i++ {
		e := exs.At(i)
		tid := e.TraceID()
		sid := e.SpanID()
		traceIDs[i] = internal.BytesHex(tid[:])
		spanIDs[i] = internal.BytesHex(sid[:])
		timestamps[i] = internal.FormatTimestampNano(uint64(e.Timestamp()))
		switch e.ValueType() {
		case pmetric.ExemplarValueTypeDouble:
			values[i] = e.DoubleValue()
		case pmetric.ExemplarValueTypeInt:
			values[i] = float64(e.IntValue())
		}
		filteredAttrs[i] = internal.AttrMap(e.FilteredAttributes())
	}
	return
}

func sliceFromUint64(s pcommon.UInt64Slice) []uint64 {
	out := make([]uint64, s.Len())
	for i := 0; i < s.Len(); i++ {
		out[i] = s.At(i)
	}
	return out
}

func sliceFromFloat64(s pcommon.Float64Slice) []float64 {
	out := make([]float64, s.Len())
	for i := 0; i < s.Len(); i++ {
		out[i] = s.At(i)
	}
	return out
}
