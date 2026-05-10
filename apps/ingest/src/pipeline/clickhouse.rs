//! ClickHouse destination writer.
//!
//! Targets the same `?query=INSERT INTO <table> FORMAT JSONEachRow` HTTP
//! entry point as the existing Go exporter (`internal/clickhouse_client.go`)
//! so the wire shape is identical: gzipped NDJSON, no trailing newline,
//! `X-ClickHouse-User` / `X-ClickHouse-Key` headers for auth.
//!
//! HTTP rather than native :9000 — same reason as the Go exporter: any CH
//! fronted by an nginx Ingress or Cloudflare proxy can receive this without
//! special-casing.

use std::time::Duration;

use reqwest::Client;
use url::Url;

use super::body::encode_gzip_ndjson;
use super::writer::WriteError;

#[derive(Clone)]
pub struct ClickhouseConfig {
    pub endpoint: String,
    pub user: Option<String>,
    /// Auth password. Redacted in `Debug`.
    pub password: Option<String>,
    pub database: Option<String>,
    pub timeout: Duration,
}

// Manual Debug impl: never print the password.
impl std::fmt::Debug for ClickhouseConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClickhouseConfig")
            .field("endpoint", &self.endpoint)
            .field("user", &self.user)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("database", &self.database)
            .field("timeout", &self.timeout)
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct ClickhouseWriter {
    cfg: ClickhouseConfig,
    http: Client,
}

impl ClickhouseWriter {
    pub fn new(cfg: ClickhouseConfig) -> Result<Self, WriteError> {
        let trimmed = cfg.endpoint.trim_end_matches('/').to_string();
        if trimmed.is_empty() {
            return Err(WriteError::InvalidEndpoint("empty".into()));
        }
        Url::parse(&trimmed).map_err(|e| WriteError::InvalidEndpoint(e.to_string()))?;

        let http = Client::builder()
            .timeout(cfg.timeout)
            .build()
            .map_err(WriteError::from)?;

        Ok(Self {
            cfg: ClickhouseConfig {
                endpoint: trimmed,
                ..cfg
            },
            http,
        })
    }

    pub async fn write(&self, table: &str, rows: &[Vec<u8>]) -> Result<(), WriteError> {
        if rows.is_empty() {
            return Ok(());
        }

        let mut url = Url::parse(&format!("{}/", self.cfg.endpoint))
            .map_err(|e| WriteError::InvalidEndpoint(e.to_string()))?;
        {
            let mut q = url.query_pairs_mut();
            q.append_pair(
                "query",
                &format!("INSERT INTO {} FORMAT JSONEachRow", quote_ident(table)),
            );
            if let Some(db) = &self.cfg.database {
                if !db.is_empty() {
                    q.append_pair("database", db);
                }
            }
            // Same knob the Go exporter sets — lets CH coerce timestamp
            // strings into DateTime64 without us pre-computing the exact
            // format CH expects.
            q.append_pair("date_time_input_format", "best_effort");
        }

        let body = encode_gzip_ndjson(rows)?;

        let mut req = self
            .http
            .post(url)
            .header("Content-Type", "text/plain")
            .header("Content-Encoding", "gzip");
        if let Some(user) = &self.cfg.user {
            if !user.is_empty() {
                req = req.header("X-ClickHouse-User", user);
                if let Some(pw) = &self.cfg.password {
                    if !pw.is_empty() {
                        req = req.header("X-ClickHouse-Key", pw);
                    }
                }
            }
        }

        let resp = req.body(body).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp
                .text()
                .await
                .unwrap_or_else(|_| "<unreadable body>".to_string());
            // Cap matches Go exporter — CH stack-traces are long.
            let trimmed = body.chars().take(2048).collect::<String>();
            return Err(WriteError::Status {
                status: status.as_u16(),
                body: trimmed.trim().to_string(),
                destination: "clickhouse",
            });
        }
        let _ = resp.bytes().await;
        Ok(())
    }
}

/// Backtick-quote a CH identifier. We only ever pass our own configured
/// table names, so this is belt-and-suspenders matching the Go exporter.
fn quote_ident(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_ident_escapes_backticks() {
        assert_eq!(quote_ident("traces"), "`traces`");
        assert_eq!(quote_ident("a`b"), "`a``b`");
    }

    #[test]
    fn rejects_empty_endpoint() {
        let err = ClickhouseWriter::new(ClickhouseConfig {
            endpoint: "  ".into(),
            user: None,
            password: None,
            database: None,
            timeout: Duration::from_secs(1),
        })
        .expect_err("empty endpoint must error");
        assert!(matches!(err, WriteError::InvalidEndpoint(_)));
    }
}
