//! Destination dispatcher. The pipeline holds one `Writer` per process; at
//! write-time it forwards to whichever backend was configured at startup.
//!
//! Modeled as an enum (rather than `Box<dyn Trait>`) because we have a small
//! closed set of destinations and want to avoid the `async_trait` macro
//! dependency. Adding a third destination = add a variant + a match arm.

use super::clickhouse::{ClickhouseConfig, ClickhouseWriter};
use super::tinybird::{TinybirdConfig, TinybirdWriter};

/// Errors that any destination writer can surface. Carries the destination
/// label so logs / metrics can attribute failures without the caller
/// branching on the writer kind.
#[derive(Debug)]
pub enum WriteError {
    InvalidEndpoint(String),
    Gzip(std::io::Error),
    Request(reqwest::Error),
    Status {
        status: u16,
        body: String,
        destination: &'static str,
    },
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidEndpoint(s) => write!(f, "invalid endpoint: {s}"),
            Self::Gzip(e) => write!(f, "gzip encode failed: {e}"),
            Self::Request(e) => write!(f, "request failed: {e}"),
            Self::Status {
                status,
                body,
                destination,
            } => write!(f, "{destination} {status}: {body}"),
        }
    }
}

impl std::error::Error for WriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Gzip(e) => Some(e),
            Self::Request(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for WriteError {
    fn from(e: std::io::Error) -> Self {
        Self::Gzip(e)
    }
}

impl From<reqwest::Error> for WriteError {
    fn from(e: reqwest::Error) -> Self {
        Self::Request(e)
    }
}

/// Per-destination configuration. Resolved once from env vars at startup;
/// `Pipeline::new` constructs the matching `Writer` variant.
#[derive(Clone, Debug)]
pub enum Destination {
    Clickhouse(ClickhouseConfig),
    Tinybird(TinybirdConfig),
}

impl Destination {
    /// Stable label for metrics / logs.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Clickhouse(_) => "clickhouse",
            Self::Tinybird(_) => "tinybird",
        }
    }
}

/// Live writer instance — one of the concrete implementations, chosen by the
/// configured `Destination`.
#[derive(Clone)]
pub enum Writer {
    Clickhouse(ClickhouseWriter),
    Tinybird(TinybirdWriter),
}

impl Writer {
    /// Build the matching writer from a resolved `Destination`. Surfaces
    /// construction errors (invalid endpoint, missing token, reqwest builder
    /// failure) so misconfig fails at startup rather than first request.
    pub fn from_destination(dest: Destination) -> Result<Self, WriteError> {
        match dest {
            Destination::Clickhouse(cfg) => Ok(Self::Clickhouse(ClickhouseWriter::new(cfg)?)),
            Destination::Tinybird(cfg) => Ok(Self::Tinybird(TinybirdWriter::new(cfg)?)),
        }
    }

    /// Stable label for metrics + structured-log fields. Mirrored on
    /// `Destination::kind` so the orchestrator can label metrics before the
    /// `Writer` is constructed.
    #[allow(dead_code)]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Clickhouse(_) => "clickhouse",
            Self::Tinybird(_) => "tinybird",
        }
    }

    /// Hand `rows` (single-line JSON objects, no trailing newlines) to the
    /// configured destination. Empty input is a no-op for both backends.
    ///
    /// `stream` is the destination-side name: ClickHouse table name or
    /// Tinybird datasource name. By convention they're identical so the
    /// caller doesn't have to know which destination it's hitting.
    pub async fn write(&self, stream: &str, rows: &[Vec<u8>]) -> Result<(), WriteError> {
        match self {
            Self::Clickhouse(w) => w.write(stream, rows).await,
            Self::Tinybird(w) => w.write(stream, rows).await,
        }
    }
}
