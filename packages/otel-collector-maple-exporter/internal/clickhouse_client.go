// Package internal contains the ClickHouse HTTP client and JSON-row encoders
// used by the Maple exporter. Kept internal so the public surface of the
// exporter is just `NewFactory()` + `Config`.
package internal

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client is a thin ClickHouse HTTP-interface client.
//
// It targets ClickHouse's `?query=...` POST entrypoint with the
// `JSONEachRow` input format — the line-delimited JSON wire format ClickHouse
// natively understands for bulk inserts. Every row is one JSON object, one
// line. ClickHouse handles type coercion (DateTime64 strings, Map(...) JSON
// objects, Array(...) JSON arrays, etc.) per the table DDL.
//
// We intentionally use the HTTP interface rather than the native protocol so
// the exporter can talk to any ClickHouse — including ones fronted by an
// nginx Ingress or Cloudflare proxy that wouldn't pass through native :9000.
type Client struct {
	endpoint string
	user     string
	password string
	database string
	httpc    *http.Client
}

// ClientOptions for constructing a Client.
type ClientOptions struct {
	Endpoint string        // e.g. "https://ch.superwall.dev" — no trailing slash.
	User     string        // basic auth username.
	Password string        // basic auth password.
	Database string        // ClickHouse database (e.g. "default").
	Timeout  time.Duration // per-request HTTP timeout.
}

// NewClient builds a Client.
func NewClient(opts ClientOptions) (*Client, error) {
	if opts.Endpoint == "" {
		return nil, fmt.Errorf("endpoint required")
	}
	if _, err := url.Parse(opts.Endpoint); err != nil {
		return nil, fmt.Errorf("parse endpoint: %w", err)
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	return &Client{
		endpoint: strings.TrimRight(opts.Endpoint, "/"),
		user:     opts.User,
		password: opts.Password,
		database: opts.Database,
		httpc:    &http.Client{Timeout: timeout},
	}, nil
}

// InsertJSONEachRow POSTs the supplied newline-delimited JSON rows into
// `INSERT INTO <table> FORMAT JSONEachRow`.
//
// `rows` is a slice of pre-encoded JSON objects (no trailing newlines, no
// surrounding array). The function joins them with "\n", gzips the body, and
// streams it to ClickHouse.
//
// Returns nil on 2xx, otherwise an error containing the response body so the
// retry loop in exporterhelper can decide whether to back off.
func (c *Client) InsertJSONEachRow(ctx context.Context, table string, rows [][]byte) error {
	if len(rows) == 0 {
		return nil
	}

	q := fmt.Sprintf("INSERT INTO %s FORMAT JSONEachRow", quoteIdent(table))
	u, err := url.Parse(c.endpoint + "/")
	if err != nil {
		return fmt.Errorf("build url: %w", err)
	}
	qv := u.Query()
	qv.Set("query", q)
	if c.database != "" {
		qv.Set("database", c.database)
	}
	// Server-side input parsing for JSONEachRow accepts a few helpful knobs;
	// we keep defaults tight and let table DDL drive type coercion.
	qv.Set("date_time_input_format", "best_effort")
	u.RawQuery = qv.Encode()

	body := &bytes.Buffer{}
	gz := gzip.NewWriter(body)
	for i, row := range rows {
		if i > 0 {
			if _, err := gz.Write([]byte{'\n'}); err != nil {
				return fmt.Errorf("gzip write: %w", err)
			}
		}
		if _, err := gz.Write(row); err != nil {
			return fmt.Errorf("gzip write: %w", err)
		}
	}
	if err := gz.Close(); err != nil {
		return fmt.Errorf("gzip close: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), body)
	if err != nil {
		return fmt.Errorf("new request: %w", err)
	}
	req.Header.Set("Content-Type", "text/plain")
	req.Header.Set("Content-Encoding", "gzip")
	if c.user != "" {
		// ClickHouse accepts both X-ClickHouse-User and basic auth; using the
		// dedicated headers avoids any base64 charset confusion with passwords
		// that contain special characters.
		req.Header.Set("X-ClickHouse-User", c.user)
		if c.password != "" {
			req.Header.Set("X-ClickHouse-Key", c.password)
		}
	}

	resp, err := c.httpc.Do(req)
	if err != nil {
		return fmt.Errorf("post: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode/100 != 2 {
		// Cap the error body — ClickHouse returns long verbose stacks on
		// schema mismatch; the first ~2KB is enough to diagnose without
		// flooding logs.
		buf, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("clickhouse %d: %s", resp.StatusCode, strings.TrimSpace(string(buf)))
	}
	// Drain so the connection can be reused.
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// quoteIdent backtick-quotes a table name. ClickHouse identifier rules — we
// only ever pass our own configured names, so this is belt-and-suspenders.
func quoteIdent(s string) string {
	return "`" + strings.ReplaceAll(s, "`", "``") + "`"
}
