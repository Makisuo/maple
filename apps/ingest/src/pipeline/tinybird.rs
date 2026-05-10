//! Tinybird Events API destination writer.
//!
//! Targets `POST /v0/events?name=<datasource>&wait=false` (Tinybird's HFI
//! High-Frequency Ingestion endpoint). Body is gzipped NDJSON — the same
//! per-row shape Maple uses for ClickHouse JSONEachRow, which is why both
//! destinations can share `super::body::encode_gzip_ndjson` and the same
//! row encoders.
//!
//! Auth is `Authorization: Bearer <token>`. Region is encoded into the host
//! (`api.tinybird.co`, `api.us-east.tinybird.co`,
//! `api.eu-central-1.tinybird.co`, etc.) — we take the full host from config
//! rather than reconstructing it from a region code.

use std::time::Duration;

use reqwest::Client;
use url::Url;

use super::body::encode_gzip_ndjson;
use super::writer::WriteError;

#[derive(Clone)]
pub struct TinybirdConfig {
    /// Full Tinybird API host, e.g. `https://api.tinybird.co` or a regional
    /// variant. Trailing slash is trimmed.
    pub host: String,
    /// Bearer token. NEVER printed in `Debug` output — see the manual impl
    /// below.
    pub token: String,
    /// Per-request HTTP timeout. Tinybird's HFI is fast in `wait=false` mode
    /// but the underlying network can still spike.
    pub timeout: Duration,
    /// `wait=true` blocks the response until the row hits the queue. We
    /// default to `false` for ingest hot-path latency; flip to `true` only
    /// for diagnostic / shadow-diff jobs.
    pub wait: bool,
}

// Manual Debug impl to keep the bearer token out of logs. The auto-derived
// Debug would dump it verbatim.
impl std::fmt::Debug for TinybirdConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TinybirdConfig")
            .field("host", &self.host)
            .field("token", &"<redacted>")
            .field("timeout", &self.timeout)
            .field("wait", &self.wait)
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct TinybirdWriter {
    cfg: TinybirdConfig,
    http: Client,
}

impl TinybirdWriter {
    pub fn new(cfg: TinybirdConfig) -> Result<Self, WriteError> {
        let host = cfg.host.trim_end_matches('/').to_string();
        if host.is_empty() {
            return Err(WriteError::InvalidEndpoint("empty Tinybird host".into()));
        }
        if cfg.token.is_empty() {
            return Err(WriteError::InvalidEndpoint("empty Tinybird token".into()));
        }
        Url::parse(&host).map_err(|e| WriteError::InvalidEndpoint(e.to_string()))?;

        let http = Client::builder()
            .timeout(cfg.timeout)
            .build()
            .map_err(WriteError::from)?;

        Ok(Self {
            cfg: TinybirdConfig { host, ..cfg },
            http,
        })
    }

    pub async fn write(&self, datasource: &str, rows: &[Vec<u8>]) -> Result<(), WriteError> {
        if rows.is_empty() {
            return Ok(());
        }

        let mut url = Url::parse(&format!("{}/v0/events", self.cfg.host))
            .map_err(|e| WriteError::InvalidEndpoint(e.to_string()))?;
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("name", datasource);
            q.append_pair("wait", if self.cfg.wait { "true" } else { "false" });
        }

        let body = encode_gzip_ndjson(rows)?;

        let resp = self
            .http
            .post(url)
            .bearer_auth(&self.cfg.token)
            // application/x-ndjson is the documented MIME for HFI; Tinybird also
            // accepts text/plain, but the explicit type makes ingest dashboards
            // attribute traffic correctly.
            .header("Content-Type", "application/x-ndjson")
            .header("Content-Encoding", "gzip")
            .body(body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp
                .text()
                .await
                .unwrap_or_else(|_| "<unreadable body>".to_string());
            // Tinybird returns concise JSON errors; cap defensively just in
            // case a proxy returns a long HTML 502 page.
            let trimmed = body.chars().take(2048).collect::<String>();
            return Err(WriteError::Status {
                status: status.as_u16(),
                body: trimmed.trim().to_string(),
                destination: "tinybird",
            });
        }
        let _ = resp.bytes().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_host() {
        let err = TinybirdWriter::new(TinybirdConfig {
            host: "  ".into(),
            token: "p.token".into(),
            timeout: Duration::from_secs(1),
            wait: false,
        })
        .expect_err("empty host must error");
        assert!(matches!(err, WriteError::InvalidEndpoint(_)));
    }

    #[test]
    fn rejects_empty_token() {
        let err = TinybirdWriter::new(TinybirdConfig {
            host: "https://api.tinybird.co".into(),
            token: String::new(),
            timeout: Duration::from_secs(1),
            wait: false,
        })
        .expect_err("empty token must error");
        assert!(matches!(err, WriteError::InvalidEndpoint(_)));
    }

    #[test]
    fn url_construction_round_trips() {
        // Construct what `write()` would build for a known datasource and
        // verify the query string is properly escaped — guards against
        // accidental URL-injection if a future code change lets datasource
        // names come from less-trusted sources.
        let host = "https://api.tinybird.co".to_string();
        let mut url = Url::parse(&format!("{}/v0/events", host)).unwrap();
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("name", "traces shadow & danger");
            q.append_pair("wait", "false");
        }
        let s = url.to_string();
        assert!(s.contains("/v0/events"));
        // url crate URL-encodes the value, so the raw "&" in the datasource
        // name MUST appear as %26 — otherwise the query would split.
        assert!(s.contains("name=traces+shadow+%26+danger"), "got {s}");
        assert!(s.contains("wait=false"));
    }
}
