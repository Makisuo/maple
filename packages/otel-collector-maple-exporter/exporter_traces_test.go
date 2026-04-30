package mapleexporter

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.uber.org/zap/zaptest"
)

// fixedTimeNanos is a deterministic Unix-nano timestamp used by every fixture
// that needs a span/log start time so golden output is stable.
// 2024-01-15 10:30:00.123456789 UTC.
const fixedTimeNanos = uint64(1_705_314_600_123_456_789)

// fixedDurationNanos is a 250ms span duration.
const fixedDurationNanos = uint64(250_000_000)

// captureServer spins up an httptest.Server, runs the exporter against it,
// and returns the rows the exporter POSTed (already gunzipped + split).
type captureServer struct {
	rows  [][]byte
	mu    sync.Mutex
	srv   *httptest.Server
	table string
}

func newCaptureServer(t *testing.T) *captureServer {
	t.Helper()
	cs := &captureServer{}
	cs.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		zr, err := gzip.NewReader(r.Body)
		if err != nil {
			t.Errorf("gzip reader: %v", err)
			w.WriteHeader(500)
			return
		}
		body, _ := io.ReadAll(zr)
		_ = zr.Close()
		cs.mu.Lock()
		for _, line := range bytes.Split(body, []byte("\n")) {
			if len(line) == 0 {
				continue
			}
			cs.rows = append(cs.rows, append([]byte(nil), line...))
		}
		cs.mu.Unlock()
		w.WriteHeader(200)
	}))
	t.Cleanup(cs.srv.Close)
	return cs
}

// newTracesExporterUnderTest builds a tracesExporter wired to the given
// capture server. The exporter is started so its CH client is initialized.
func newTracesExporterUnderTest(t *testing.T, srvURL string, cfg *Config) *tracesExporter {
	t.Helper()
	if cfg == nil {
		cfg = &Config{
			Endpoint: srvURL,
			Database: "default",
			Username: "u",
			Password: "p",
			OrgID:    "org_default",
		}
	} else if cfg.Endpoint == "" {
		cfg.Endpoint = srvURL
	}
	cfg.TimeoutConfig = defaultTimeoutConfig()
	cfg = cfg.withDefaults()

	tx, err := newTracesExporter(zaptest.NewLogger(t), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.start(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	return tx
}

// makeFullSpan builds a deterministic span exercising every column the
// exporter writes — events, links, span attributes, scope info — so the
// golden file pins the full encoder path.
func makeFullSpan() ptrace.Traces {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.SetSchemaUrl("https://opentelemetry.io/schemas/1.20.0")

	resAttrs := rs.Resource().Attributes()
	resAttrs.PutStr("service.name", "checkout-api")
	resAttrs.PutStr("deployment.environment", "production")
	resAttrs.PutStr("maple_org_id", "org_3AuiNCIuD1XCbbzcjkzE3s5HoQj")
	resAttrs.PutStr("k8s.cluster.name", "prd-sw-default")

	ss := rs.ScopeSpans().AppendEmpty()
	ss.SetSchemaUrl("https://opentelemetry.io/schemas/1.20.0")
	scope := ss.Scope()
	scope.SetName("checkout-api/tracer")
	scope.SetVersion("1.4.2")
	scope.Attributes().PutStr("library", "stdlib")

	span := ss.Spans().AppendEmpty()
	span.SetName("POST /v1/checkout")
	span.SetKind(ptrace.SpanKindServer)
	span.SetTraceID(pcommon.TraceID([16]byte{
		0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
		0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
	}))
	span.SetSpanID(pcommon.SpanID([8]byte{0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}))
	span.SetParentSpanID(pcommon.SpanID([8]byte{0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10}))
	span.TraceState().FromRaw("th:8")
	span.SetStartTimestamp(pcommon.Timestamp(fixedTimeNanos))
	span.SetEndTimestamp(pcommon.Timestamp(fixedTimeNanos + fixedDurationNanos))
	span.Status().SetCode(ptrace.StatusCodeOk)
	span.Status().SetMessage("")

	spanAttrs := span.Attributes()
	spanAttrs.PutStr("http.method", "POST")
	spanAttrs.PutStr("http.route", "/v1/checkout")
	spanAttrs.PutInt("http.status_code", 200)
	spanAttrs.PutStr("user.id", "user_42")

	// One event (often the exception event). Only event attributes are
	// captured, so we keep the shape simple.
	ev := span.Events().AppendEmpty()
	ev.SetName("cache.miss")
	ev.SetTimestamp(pcommon.Timestamp(fixedTimeNanos + 50_000_000))
	ev.Attributes().PutStr("cache.key", "cart:user_42")

	// One link to a parent trace.
	link := span.Links().AppendEmpty()
	link.SetTraceID(pcommon.TraceID([16]byte{
		0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88,
		0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x00,
	}))
	link.SetSpanID(pcommon.SpanID([8]byte{0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88}))
	link.TraceState().FromRaw("")
	link.Attributes().PutStr("link.kind", "follows-from")

	return td
}

func TestTracesExporter_FullSpan_Golden(t *testing.T) {
	cs := newCaptureServer(t)
	tx := newTracesExporterUnderTest(t, cs.srv.URL, &Config{OrgID: "org_default"})

	if err := tx.pushTraces(context.Background(), makeFullSpan()); err != nil {
		t.Fatalf("pushTraces: %v", err)
	}

	if len(cs.rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(cs.rows))
	}
	assertGoldenJSONEachRow(t, "traces_full_span", cs.rows)
}

func TestTracesExporter_OrgIDDefaultModeConfigWins(t *testing.T) {
	// Default mode: config OrgID wins even when the resource carries a
	// maple_org_id attribute. This is the new opinionated behavior so
	// single-tenant deployments don't need an upstream processor.
	cs := newCaptureServer(t)
	tx := newTracesExporterUnderTest(t, cs.srv.URL, &Config{OrgID: "org_config"})

	if err := tx.pushTraces(context.Background(), makeFullSpan()); err != nil {
		t.Fatal(err)
	}

	row := string(cs.rows[0])
	wantOrg := `"OrgId":"org_config"`
	if !contains(row, wantOrg) {
		t.Errorf("row missing %q\n%s", wantOrg, row)
	}
}

func TestTracesExporter_OrgIDOptInModeResourceWins(t *testing.T) {
	// Opt-in multi-tenant mode: when OrgIDFromResourceAttribute is set, the
	// resource attribute wins over the config fallback.
	cs := newCaptureServer(t)
	tx := newTracesExporterUnderTest(t, cs.srv.URL, &Config{
		OrgID:                      "org_static_fallback",
		OrgIDFromResourceAttribute: "maple_org_id",
	})

	if err := tx.pushTraces(context.Background(), makeFullSpan()); err != nil {
		t.Fatal(err)
	}

	row := string(cs.rows[0])
	wantOrg := `"OrgId":"org_3AuiNCIuD1XCbbzcjkzE3s5HoQj"`
	if !contains(row, wantOrg) {
		t.Errorf("row missing %q\n%s", wantOrg, row)
	}
}

func TestTracesExporter_OrgIDFromConfigFallback(t *testing.T) {
	// Opt-in mode: when the resource is missing the configured attribute,
	// the static config OrgID is used.
	cs := newCaptureServer(t)
	tx := newTracesExporterUnderTest(t, cs.srv.URL, &Config{
		OrgID:                      "org_static_fallback",
		OrgIDFromResourceAttribute: "maple_org_id",
	})

	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "x")
	span := rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty()
	span.SetName("noop")
	span.SetTraceID(pcommon.TraceID([16]byte{1}))
	span.SetSpanID(pcommon.SpanID([8]byte{2}))
	span.SetStartTimestamp(pcommon.Timestamp(fixedTimeNanos))
	span.SetEndTimestamp(pcommon.Timestamp(fixedTimeNanos + 1000))

	if err := tx.pushTraces(context.Background(), td); err != nil {
		t.Fatal(err)
	}
	row := string(cs.rows[0])
	if !contains(row, `"OrgId":"org_static_fallback"`) {
		t.Errorf("row missing fallback OrgId:\n%s", row)
	}
}

func TestTracesExporter_StatusCodeMapping(t *testing.T) {
	cases := []struct {
		code     ptrace.StatusCode
		expected string
	}{
		{ptrace.StatusCodeUnset, "Unset"},
		{ptrace.StatusCodeOk, "Ok"},
		{ptrace.StatusCodeError, "Error"},
	}
	for _, tc := range cases {
		t.Run(tc.expected, func(t *testing.T) {
			cs := newCaptureServer(t)
			tx := newTracesExporterUnderTest(t, cs.srv.URL, &Config{OrgID: "o"})
			td := makeFullSpan()
			td.ResourceSpans().At(0).ScopeSpans().At(0).Spans().At(0).Status().SetCode(tc.code)
			if err := tx.pushTraces(context.Background(), td); err != nil {
				t.Fatal(err)
			}
			row := string(cs.rows[0])
			if !contains(row, `"StatusCode":"`+tc.expected+`"`) {
				t.Errorf("expected StatusCode=%s in:\n%s", tc.expected, row)
			}
		})
	}
}

func TestTracesExporter_DurationCalculation(t *testing.T) {
	// EndTimestamp - StartTimestamp = duration nanos. Spans without a valid
	// end (zero or earlier-than-start) should record 0 instead of underflowing.
	cs := newCaptureServer(t)
	tx := newTracesExporterUnderTest(t, cs.srv.URL, &Config{OrgID: "o"})

	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "s")
	for _, tc := range []struct {
		start, end uint64
		want       string
	}{
		{fixedTimeNanos, fixedTimeNanos + 1_500_000_000, `"Duration":1500000000`},
		{fixedTimeNanos, 0, `"Duration":0`},
		{fixedTimeNanos, fixedTimeNanos - 1, `"Duration":0`}, // end before start
	} {
		span := rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty()
		span.SetTraceID(pcommon.TraceID([16]byte{1}))
		span.SetSpanID(pcommon.SpanID([8]byte{2}))
		span.SetStartTimestamp(pcommon.Timestamp(tc.start))
		span.SetEndTimestamp(pcommon.Timestamp(tc.end))
	}

	if err := tx.pushTraces(context.Background(), td); err != nil {
		t.Fatal(err)
	}
	if len(cs.rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(cs.rows))
	}
}

func TestTracesExporter_EmptyTraces(t *testing.T) {
	// Empty input must not POST.
	cs := newCaptureServer(t)
	tx := newTracesExporterUnderTest(t, cs.srv.URL, &Config{OrgID: "o"})

	if err := tx.pushTraces(context.Background(), ptrace.NewTraces()); err != nil {
		t.Fatal(err)
	}
	if len(cs.rows) != 0 {
		t.Errorf("expected 0 rows, got %d", len(cs.rows))
	}
}

func TestTracesExporter_MultipleSpansBatched(t *testing.T) {
	cs := newCaptureServer(t)
	tx := newTracesExporterUnderTest(t, cs.srv.URL, &Config{OrgID: "o"})

	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "s")
	for i := 0; i < 3; i++ {
		span := rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty()
		span.SetName("op")
		span.SetTraceID(pcommon.TraceID([16]byte{byte(i)}))
		span.SetSpanID(pcommon.SpanID([8]byte{byte(i)}))
		span.SetStartTimestamp(pcommon.Timestamp(fixedTimeNanos))
		span.SetEndTimestamp(pcommon.Timestamp(fixedTimeNanos + 1000))
	}
	if err := tx.pushTraces(context.Background(), td); err != nil {
		t.Fatal(err)
	}
	if len(cs.rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(cs.rows))
	}
}

// helper since we don't want to import strings just for one substring check.
func contains(haystack, needle string) bool {
	return bytes.Contains([]byte(haystack), []byte(needle))
}

// ensure we always close out a request within a reasonable time (avoid
// hanging tests on goroutine leaks).
func init() { time.AfterFunc(60*time.Second, func() {}) }
