package mapleexporter

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.uber.org/zap/zaptest"
)

// metricsCapture stores rows keyed by table name (extracted from the INSERT
// query) so we can assert each metric type independently.
type metricsCapture struct {
	mu      sync.Mutex
	byTable map[string][][]byte
	srv     *httptest.Server
}

func newMetricsCaptureServer(t *testing.T) *metricsCapture {
	t.Helper()
	mc := &metricsCapture{byTable: map[string][][]byte{}}
	mc.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Extract the target table from the `query=INSERT INTO `t` FORMAT JSONEachRow`.
		q, _ := url.QueryUnescape(r.URL.Query().Get("query"))
		var table string
		if i := strings.Index(q, "`"); i >= 0 {
			rest := q[i+1:]
			if j := strings.Index(rest, "`"); j >= 0 {
				table = rest[:j]
			}
		}

		zr, err := gzip.NewReader(r.Body)
		if err != nil {
			t.Errorf("gzip: %v", err)
			w.WriteHeader(500)
			return
		}
		body, _ := io.ReadAll(zr)
		_ = zr.Close()

		mc.mu.Lock()
		for _, line := range bytes.Split(body, []byte("\n")) {
			if len(line) > 0 {
				mc.byTable[table] = append(mc.byTable[table], append([]byte(nil), line...))
			}
		}
		mc.mu.Unlock()
		w.WriteHeader(200)
	}))
	t.Cleanup(mc.srv.Close)
	return mc
}

func newMetricsExporterUnderTest(t *testing.T, srvURL string, cfg *Config) *metricsExporter {
	t.Helper()
	if cfg == nil {
		cfg = &Config{Endpoint: srvURL, OrgID: "org_default"}
	} else if cfg.Endpoint == "" {
		cfg.Endpoint = srvURL
	}
	cfg.TimeoutConfig = defaultTimeoutConfig()
	cfg = cfg.withDefaults()

	mx, err := newMetricsExporter(zaptest.NewLogger(t), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := mx.start(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	return mx
}

// commonResourceScope wires up a deterministic resource + scope for metric
// fixtures so test rows always have identical headers and only the metric
// payload changes.
func commonResourceScope(rm pmetric.ResourceMetrics) pmetric.ScopeMetrics {
	rm.SetSchemaUrl("https://opentelemetry.io/schemas/1.20.0")
	rm.Resource().Attributes().PutStr("service.name", "checkout-api")
	rm.Resource().Attributes().PutStr("maple_org_id", "org_3AuiNCIuD1XCbbzcjkzE3s5HoQj")

	sm := rm.ScopeMetrics().AppendEmpty()
	sm.SetSchemaUrl("https://opentelemetry.io/schemas/1.20.0")
	sm.Scope().SetName("checkout-api/meter")
	sm.Scope().SetVersion("1.4.2")
	sm.Scope().Attributes().PutStr("module", "billing")
	return sm
}

func TestMetricsExporter_Sum_Golden(t *testing.T) {
	mc := newMetricsCaptureServer(t)
	mx := newMetricsExporterUnderTest(t, mc.srv.URL, &Config{OrgID: "org_default"})

	md := pmetric.NewMetrics()
	sm := commonResourceScope(md.ResourceMetrics().AppendEmpty())

	metric := sm.Metrics().AppendEmpty()
	metric.SetName("http.server.request.count")
	metric.SetDescription("Number of HTTP requests")
	metric.SetUnit("1")
	sum := metric.SetEmptySum()
	sum.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	sum.SetIsMonotonic(true)

	dp := sum.DataPoints().AppendEmpty()
	dp.SetStartTimestamp(pcommon.Timestamp(fixedTimeNanos))
	dp.SetTimestamp(pcommon.Timestamp(fixedTimeNanos + 60_000_000_000))
	dp.SetIntValue(1234)
	dp.SetFlags(pmetric.DefaultDataPointFlags)
	dp.Attributes().PutStr("http.route", "/checkout")
	dp.Attributes().PutStr("http.method", "POST")

	if err := mx.pushMetrics(context.Background(), md); err != nil {
		t.Fatal(err)
	}
	mc.mu.Lock()
	defer mc.mu.Unlock()
	rows := mc.byTable["metrics_sum"]
	if len(rows) != 1 {
		t.Fatalf("metrics_sum: got %d rows", len(rows))
	}
	assertGoldenJSONEachRow(t, "metrics_sum", rows)
}

func TestMetricsExporter_Gauge_Golden(t *testing.T) {
	mc := newMetricsCaptureServer(t)
	mx := newMetricsExporterUnderTest(t, mc.srv.URL, &Config{OrgID: "org_default"})

	md := pmetric.NewMetrics()
	sm := commonResourceScope(md.ResourceMetrics().AppendEmpty())

	metric := sm.Metrics().AppendEmpty()
	metric.SetName("system.memory.usage")
	metric.SetDescription("Bytes of memory in use")
	metric.SetUnit("By")
	gauge := metric.SetEmptyGauge()

	dp := gauge.DataPoints().AppendEmpty()
	dp.SetStartTimestamp(pcommon.Timestamp(fixedTimeNanos))
	dp.SetTimestamp(pcommon.Timestamp(fixedTimeNanos))
	dp.SetDoubleValue(1024.5)
	dp.SetFlags(pmetric.DefaultDataPointFlags)
	dp.Attributes().PutStr("state", "used")

	if err := mx.pushMetrics(context.Background(), md); err != nil {
		t.Fatal(err)
	}
	mc.mu.Lock()
	defer mc.mu.Unlock()
	assertGoldenJSONEachRow(t, "metrics_gauge", mc.byTable["metrics_gauge"])
}

func TestMetricsExporter_Histogram_Golden(t *testing.T) {
	mc := newMetricsCaptureServer(t)
	mx := newMetricsExporterUnderTest(t, mc.srv.URL, &Config{OrgID: "org_default"})

	md := pmetric.NewMetrics()
	sm := commonResourceScope(md.ResourceMetrics().AppendEmpty())

	metric := sm.Metrics().AppendEmpty()
	metric.SetName("http.server.request.duration")
	metric.SetDescription("Latency in seconds")
	metric.SetUnit("s")
	hist := metric.SetEmptyHistogram()
	hist.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)

	dp := hist.DataPoints().AppendEmpty()
	dp.SetStartTimestamp(pcommon.Timestamp(fixedTimeNanos))
	dp.SetTimestamp(pcommon.Timestamp(fixedTimeNanos))
	dp.SetCount(100)
	dp.SetSum(12.5)
	dp.BucketCounts().FromRaw([]uint64{10, 20, 30, 40})
	dp.ExplicitBounds().FromRaw([]float64{0.005, 0.01, 0.05})
	dp.SetMin(0.001)
	dp.SetMax(2.5)
	dp.SetFlags(pmetric.DefaultDataPointFlags)
	dp.Attributes().PutStr("http.route", "/checkout")

	if err := mx.pushMetrics(context.Background(), md); err != nil {
		t.Fatal(err)
	}
	mc.mu.Lock()
	defer mc.mu.Unlock()
	assertGoldenJSONEachRow(t, "metrics_histogram", mc.byTable["metrics_histogram"])
}

func TestMetricsExporter_Histogram_NullMinMax(t *testing.T) {
	// When Min/Max are not set, the row must contain JSON null for those
	// fields — Maple's column is `Nullable(Float64)`.
	mc := newMetricsCaptureServer(t)
	mx := newMetricsExporterUnderTest(t, mc.srv.URL, &Config{OrgID: "o"})

	md := pmetric.NewMetrics()
	sm := commonResourceScope(md.ResourceMetrics().AppendEmpty())
	metric := sm.Metrics().AppendEmpty()
	metric.SetName("h")
	hist := metric.SetEmptyHistogram()
	dp := hist.DataPoints().AppendEmpty()
	dp.SetTimestamp(pcommon.Timestamp(fixedTimeNanos))
	dp.SetCount(0)
	// Min and Max NOT set.

	if err := mx.pushMetrics(context.Background(), md); err != nil {
		t.Fatal(err)
	}
	mc.mu.Lock()
	defer mc.mu.Unlock()
	row := string(mc.byTable["metrics_histogram"][0])
	// Inspect the JSON for explicit nulls.
	var parsed map[string]any
	if err := json.Unmarshal([]byte(row), &parsed); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if v, ok := parsed["Min"]; !ok || v != nil {
		t.Errorf("Min should be null, got %v", v)
	}
	if v, ok := parsed["Max"]; !ok || v != nil {
		t.Errorf("Max should be null, got %v", v)
	}
}

func TestMetricsExporter_ExponentialHistogram_Golden(t *testing.T) {
	mc := newMetricsCaptureServer(t)
	mx := newMetricsExporterUnderTest(t, mc.srv.URL, &Config{OrgID: "org_default"})

	md := pmetric.NewMetrics()
	sm := commonResourceScope(md.ResourceMetrics().AppendEmpty())

	metric := sm.Metrics().AppendEmpty()
	metric.SetName("rpc.request.duration")
	metric.SetDescription("RPC latency")
	metric.SetUnit("ms")
	eh := metric.SetEmptyExponentialHistogram()
	eh.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)

	dp := eh.DataPoints().AppendEmpty()
	dp.SetStartTimestamp(pcommon.Timestamp(fixedTimeNanos))
	dp.SetTimestamp(pcommon.Timestamp(fixedTimeNanos))
	dp.SetCount(50)
	dp.SetSum(123.45)
	dp.SetScale(2)
	dp.SetZeroCount(3)
	dp.Positive().SetOffset(-1)
	dp.Positive().BucketCounts().FromRaw([]uint64{1, 2, 3, 4})
	dp.Negative().SetOffset(0)
	dp.Negative().BucketCounts().FromRaw([]uint64{})
	dp.SetMin(0.001)
	dp.SetMax(50.0)
	dp.SetFlags(pmetric.DefaultDataPointFlags)
	dp.Attributes().PutStr("rpc.system", "grpc")

	if err := mx.pushMetrics(context.Background(), md); err != nil {
		t.Fatal(err)
	}
	mc.mu.Lock()
	defer mc.mu.Unlock()
	assertGoldenJSONEachRow(t, "metrics_exponential_histogram", mc.byTable["metrics_exponential_histogram"])
}

func TestMetricsExporter_SummaryDropped(t *testing.T) {
	// Maple has no summary table; summaries must be silently skipped (logged
	// at debug) without breaking the rest of the batch.
	mc := newMetricsCaptureServer(t)
	mx := newMetricsExporterUnderTest(t, mc.srv.URL, &Config{OrgID: "o"})

	md := pmetric.NewMetrics()
	sm := commonResourceScope(md.ResourceMetrics().AppendEmpty())
	summary := sm.Metrics().AppendEmpty()
	summary.SetName("legacy.summary")
	summary.SetEmptySummary().DataPoints().AppendEmpty().SetTimestamp(pcommon.Timestamp(fixedTimeNanos))
	gauge := sm.Metrics().AppendEmpty()
	gauge.SetName("g")
	gauge.SetEmptyGauge().DataPoints().AppendEmpty().SetTimestamp(pcommon.Timestamp(fixedTimeNanos))

	if err := mx.pushMetrics(context.Background(), md); err != nil {
		t.Fatal(err)
	}
	mc.mu.Lock()
	defer mc.mu.Unlock()
	if len(mc.byTable["metrics_gauge"]) != 1 {
		t.Errorf("expected 1 gauge row")
	}
	for table := range mc.byTable {
		if strings.Contains(table, "summary") {
			t.Errorf("unexpected summary table: %s", table)
		}
	}
}

func TestMetricsExporter_MixedTypesInOneBatch(t *testing.T) {
	// All four types in one inbound message → one INSERT per type, only
	// non-empty buckets sent.
	mc := newMetricsCaptureServer(t)
	mx := newMetricsExporterUnderTest(t, mc.srv.URL, &Config{OrgID: "o"})

	md := pmetric.NewMetrics()
	sm := commonResourceScope(md.ResourceMetrics().AppendEmpty())

	addPoint := func(setup func(pmetric.Metric)) {
		m := sm.Metrics().AppendEmpty()
		setup(m)
	}
	addPoint(func(m pmetric.Metric) {
		m.SetName("s")
		dp := m.SetEmptySum().DataPoints().AppendEmpty()
		dp.SetIntValue(1)
		dp.SetTimestamp(pcommon.Timestamp(fixedTimeNanos))
	})
	addPoint(func(m pmetric.Metric) {
		m.SetName("g")
		dp := m.SetEmptyGauge().DataPoints().AppendEmpty()
		dp.SetDoubleValue(1)
		dp.SetTimestamp(pcommon.Timestamp(fixedTimeNanos))
	})
	addPoint(func(m pmetric.Metric) {
		m.SetName("h")
		m.SetEmptyHistogram().DataPoints().AppendEmpty().SetTimestamp(pcommon.Timestamp(fixedTimeNanos))
	})
	addPoint(func(m pmetric.Metric) {
		m.SetName("eh")
		m.SetEmptyExponentialHistogram().DataPoints().AppendEmpty().SetTimestamp(pcommon.Timestamp(fixedTimeNanos))
	})

	if err := mx.pushMetrics(context.Background(), md); err != nil {
		t.Fatal(err)
	}
	mc.mu.Lock()
	defer mc.mu.Unlock()
	for _, table := range []string{"metrics_sum", "metrics_gauge", "metrics_histogram", "metrics_exponential_histogram"} {
		if len(mc.byTable[table]) != 1 {
			t.Errorf("%s: got %d rows, want 1", table, len(mc.byTable[table]))
		}
	}
}

func TestMetricsExporter_Empty(t *testing.T) {
	mc := newMetricsCaptureServer(t)
	mx := newMetricsExporterUnderTest(t, mc.srv.URL, &Config{OrgID: "o"})

	if err := mx.pushMetrics(context.Background(), pmetric.NewMetrics()); err != nil {
		t.Fatal(err)
	}
	mc.mu.Lock()
	defer mc.mu.Unlock()
	if len(mc.byTable) != 0 {
		t.Errorf("expected no INSERTs, got %v", mc.byTable)
	}
}
