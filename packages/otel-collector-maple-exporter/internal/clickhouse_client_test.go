package internal

import (
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// captureRequest is a single recorded HTTP request from the test server.
type captureRequest struct {
	method  string
	path    string
	query   string
	headers http.Header
	body    string
}

// newTestServer returns an httptest.Server that records every request and
// returns the configured status code + body. Useful for asserting both the
// shape of what the client sends and how it handles error responses.
func newTestServer(t *testing.T, status int, respBody string) (*httptest.Server, *[]captureRequest, *sync.Mutex) {
	t.Helper()
	captured := []captureRequest{}
	mu := &sync.Mutex{}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Decompress gzip body so test assertions read plaintext.
		var bodyBytes []byte
		if r.Header.Get("Content-Encoding") == "gzip" {
			zr, err := gzip.NewReader(r.Body)
			if err != nil {
				t.Errorf("failed to gunzip: %v", err)
			} else {
				bodyBytes, _ = io.ReadAll(zr)
				_ = zr.Close()
			}
		} else {
			bodyBytes, _ = io.ReadAll(r.Body)
		}

		mu.Lock()
		captured = append(captured, captureRequest{
			method:  r.Method,
			path:    r.URL.Path,
			query:   r.URL.RawQuery,
			headers: r.Header.Clone(),
			body:    string(bodyBytes),
		})
		mu.Unlock()

		w.WriteHeader(status)
		_, _ = w.Write([]byte(respBody))
	}))

	t.Cleanup(srv.Close)
	return srv, &captured, mu
}

func TestInsertJSONEachRow_Success(t *testing.T) {
	srv, captured, mu := newTestServer(t, 200, "")

	c, err := NewClient(ClientOptions{
		Endpoint: srv.URL,
		User:     "maple",
		Password: "secret",
		Database: "default",
		Timeout:  5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	rows := [][]byte{
		[]byte(`{"OrgId":"org_a","Body":"hello"}`),
		[]byte(`{"OrgId":"org_a","Body":"world"}`),
	}

	if err := c.InsertJSONEachRow(context.Background(), "logs", rows); err != nil {
		t.Fatalf("InsertJSONEachRow: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(*captured) != 1 {
		t.Fatalf("got %d requests, want 1", len(*captured))
	}
	req := (*captured)[0]

	if req.method != http.MethodPost {
		t.Errorf("method = %q, want POST", req.method)
	}

	// Query must contain the table-quoted INSERT and the database param.
	if !strings.Contains(req.query, "INSERT+INTO+%60logs%60+FORMAT+JSONEachRow") {
		t.Errorf("query missing INSERT statement: %q", req.query)
	}
	if !strings.Contains(req.query, "database=default") {
		t.Errorf("query missing database: %q", req.query)
	}
	if !strings.Contains(req.query, "date_time_input_format=best_effort") {
		t.Errorf("query missing date_time_input_format: %q", req.query)
	}

	// Auth headers
	if req.headers.Get("X-ClickHouse-User") != "maple" {
		t.Errorf("X-ClickHouse-User = %q, want maple", req.headers.Get("X-ClickHouse-User"))
	}
	if req.headers.Get("X-ClickHouse-Key") != "secret" {
		t.Errorf("X-ClickHouse-Key = %q, want secret", req.headers.Get("X-ClickHouse-Key"))
	}
	if req.headers.Get("Content-Encoding") != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip", req.headers.Get("Content-Encoding"))
	}

	// Body must be both rows joined with \n, no trailing newline.
	expected := `{"OrgId":"org_a","Body":"hello"}` + "\n" + `{"OrgId":"org_a","Body":"world"}`
	if req.body != expected {
		t.Errorf("body mismatch:\n got: %q\nwant: %q", req.body, expected)
	}
}

func TestInsertJSONEachRow_Empty(t *testing.T) {
	// Empty input should be a no-op — no HTTP request issued.
	srv, captured, mu := newTestServer(t, 500, "should not be called")

	c, _ := NewClient(ClientOptions{Endpoint: srv.URL, Timeout: time.Second})

	if err := c.InsertJSONEachRow(context.Background(), "logs", nil); err != nil {
		t.Fatalf("err: %v", err)
	}
	if err := c.InsertJSONEachRow(context.Background(), "logs", [][]byte{}); err != nil {
		t.Fatalf("err: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(*captured) != 0 {
		t.Fatalf("expected 0 requests, got %d", len(*captured))
	}
}

func TestInsertJSONEachRow_ServerError(t *testing.T) {
	srv, _, _ := newTestServer(t, 500, "Code: 60. DB::Exception: Table 'default.logs' does not exist")

	c, _ := NewClient(ClientOptions{Endpoint: srv.URL, User: "u", Password: "p", Database: "default", Timeout: time.Second})

	err := c.InsertJSONEachRow(context.Background(), "logs", [][]byte{[]byte(`{}`)})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "clickhouse 500") {
		t.Errorf("error missing status: %v", err)
	}
	if !strings.Contains(err.Error(), "Table 'default.logs' does not exist") {
		t.Errorf("error missing CH body: %v", err)
	}
}

func TestInsertJSONEachRow_NoCredentials(t *testing.T) {
	// When username is empty, no auth headers should be sent — supports
	// CHs configured for IP-allowlist auth.
	srv, captured, mu := newTestServer(t, 200, "")
	c, _ := NewClient(ClientOptions{Endpoint: srv.URL, Timeout: time.Second})

	if err := c.InsertJSONEachRow(context.Background(), "t", [][]byte{[]byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	req := (*captured)[0]
	if got := req.headers.Get("X-ClickHouse-User"); got != "" {
		t.Errorf("X-ClickHouse-User leaked: %q", got)
	}
	if got := req.headers.Get("X-ClickHouse-Key"); got != "" {
		t.Errorf("X-ClickHouse-Key leaked: %q", got)
	}
}

func TestInsertJSONEachRow_TableNameQuoting(t *testing.T) {
	// Backticks in table name must be doubled to avoid SQL injection via the
	// configured table-name override.
	srv, captured, mu := newTestServer(t, 200, "")
	c, _ := NewClient(ClientOptions{Endpoint: srv.URL, Timeout: time.Second})

	if err := c.InsertJSONEachRow(context.Background(), "weird`table", [][]byte{[]byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	// %60 = backtick. Doubled would render `weird``table` → URL-encoded as %60weird%60%60table%60.
	if !strings.Contains((*captured)[0].query, "%60weird%60%60table%60") {
		t.Errorf("table not properly quoted: %q", (*captured)[0].query)
	}
}

func TestNewClient_ValidatesEndpoint(t *testing.T) {
	if _, err := NewClient(ClientOptions{}); err == nil {
		t.Fatal("expected error on empty endpoint")
	}
}
