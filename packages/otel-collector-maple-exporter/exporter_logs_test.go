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

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.uber.org/zap/zaptest"
)

// reuse capture-server pattern from traces tests but for logs
func newLogsCaptureServer(t *testing.T) (*httptest.Server, *[][]byte, *sync.Mutex) {
	t.Helper()
	rows := [][]byte{}
	mu := &sync.Mutex{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		zr, err := gzip.NewReader(r.Body)
		if err != nil {
			t.Errorf("gzip: %v", err)
			w.WriteHeader(500)
			return
		}
		body, _ := io.ReadAll(zr)
		_ = zr.Close()
		mu.Lock()
		for _, line := range bytes.Split(body, []byte("\n")) {
			if len(line) > 0 {
				rows = append(rows, append([]byte(nil), line...))
			}
		}
		mu.Unlock()
		w.WriteHeader(200)
	}))
	t.Cleanup(srv.Close)
	return srv, &rows, mu
}

func newLogsExporterUnderTest(t *testing.T, srvURL string, cfg *Config) *logsExporter {
	t.Helper()
	if cfg == nil {
		cfg = &Config{Endpoint: srvURL, OrgID: "org_default"}
	} else if cfg.Endpoint == "" {
		cfg.Endpoint = srvURL
	}
	cfg.TimeoutConfig = defaultTimeoutConfig()
	cfg = cfg.withDefaults()

	lx, err := newLogsExporter(zaptest.NewLogger(t), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := lx.start(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	return lx
}

// makeFullLog builds a deterministic log fixture exercising every column.
func makeFullLog() plog.Logs {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.SetSchemaUrl("https://opentelemetry.io/schemas/1.20.0")

	resAttrs := rl.Resource().Attributes()
	resAttrs.PutStr("service.name", "checkout-api")
	resAttrs.PutStr("maple_org_id", "org_3AuiNCIuD1XCbbzcjkzE3s5HoQj")

	sl := rl.ScopeLogs().AppendEmpty()
	sl.SetSchemaUrl("https://opentelemetry.io/schemas/1.20.0")
	sl.Scope().SetName("checkout-api/logger")
	sl.Scope().SetVersion("1.4.2")
	sl.Scope().Attributes().PutStr("module", "billing")

	rec := sl.LogRecords().AppendEmpty()
	rec.SetTimestamp(pcommon.Timestamp(fixedTimeNanos))
	rec.SetObservedTimestamp(pcommon.Timestamp(fixedTimeNanos + 1_000))
	rec.SetTraceID(pcommon.TraceID([16]byte{
		0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
		0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
	}))
	rec.SetSpanID(pcommon.SpanID([8]byte{0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}))
	rec.SetSeverityNumber(plog.SeverityNumberError)
	rec.SetSeverityText("ERROR")
	rec.SetFlags(plog.LogRecordFlags(1))
	rec.Body().SetStr("payment processor returned 500")
	rec.Attributes().PutStr("payment.provider", "stripe")
	rec.Attributes().PutInt("retry.count", 3)

	return ld
}

func TestLogsExporter_FullLog_Golden(t *testing.T) {
	srv, rows, mu := newLogsCaptureServer(t)
	lx := newLogsExporterUnderTest(t, srv.URL, &Config{OrgID: "org_default"})

	if err := lx.pushLogs(context.Background(), makeFullLog()); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(*rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(*rows))
	}
	assertGoldenJSONEachRow(t, "logs_full_log", *rows)
}

func TestLogsExporter_TimestampFallbackToObserved(t *testing.T) {
	// When Timestamp is zero, fall back to ObservedTimestamp so logs always
	// land on a real partition (Maple's `TimestampTime DateTime` is part of
	// the partition key).
	srv, rows, mu := newLogsCaptureServer(t)
	lx := newLogsExporterUnderTest(t, srv.URL, &Config{OrgID: "o"})

	ld := plog.NewLogs()
	rec := ld.ResourceLogs().AppendEmpty().ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	rec.SetTimestamp(0)
	rec.SetObservedTimestamp(pcommon.Timestamp(fixedTimeNanos))
	rec.Body().SetStr("hi")

	if err := lx.pushLogs(context.Background(), ld); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	row := string((*rows)[0])
	if !contains(row, `"Timestamp":"2024-01-15 10:30:00.123456789"`) {
		t.Errorf("expected fallback Timestamp, got:\n%s", row)
	}
	if !contains(row, `"TimestampTime":"2024-01-15 10:30:00"`) {
		t.Errorf("expected fallback TimestampTime, got:\n%s", row)
	}
}

func TestLogsExporter_SeverityTextDerivedWhenMissing(t *testing.T) {
	// SeverityText is derived from SeverityNumber when the producer didn't
	// set it explicitly. Maple's `SeverityText LowCardinality(String)` would
	// otherwise be empty for many SDKs.
	srv, rows, mu := newLogsCaptureServer(t)
	lx := newLogsExporterUnderTest(t, srv.URL, &Config{OrgID: "o"})

	ld := plog.NewLogs()
	rec := ld.ResourceLogs().AppendEmpty().ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	rec.SetTimestamp(pcommon.Timestamp(fixedTimeNanos))
	rec.SetSeverityNumber(plog.SeverityNumberWarn) // 13
	// SeverityText intentionally NOT set
	rec.Body().SetStr("warning!")

	if err := lx.pushLogs(context.Background(), ld); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	row := string((*rows)[0])
	if !contains(row, `"SeverityText":"WARN"`) {
		t.Errorf("expected derived SeverityText=WARN, got:\n%s", row)
	}
}

func TestLogsExporter_EmptyLogs(t *testing.T) {
	srv, rows, mu := newLogsCaptureServer(t)
	lx := newLogsExporterUnderTest(t, srv.URL, &Config{OrgID: "o"})

	if err := lx.pushLogs(context.Background(), plog.NewLogs()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(*rows) != 0 {
		t.Errorf("expected 0 rows, got %d", len(*rows))
	}
}
