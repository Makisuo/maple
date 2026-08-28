//! Minimal S3-compatible object writer for Cloudflare R2.
//!
//! The gateway runs as a container (Railway), not on Workers, so it can't reach
//! R2 through a native binding — it signs S3 requests with SigV4 like any other
//! client. That is the whole reason this module exists.
//!
//! Deliberately not `aws-sdk-s3`: we issue exactly one verb (`PUT`) against one
//! bucket with a known-length in-memory payload. Signing that is ~100 lines on
//! top of the `hmac`/`sha2`/`chrono`/`reqwest` crates the binary already links
//! for ingest-key hashing, versus pulling the whole smithy stack in for it.
//!
//! Scope: replay chunk payloads only. If this ever grows a second caller or a
//! second verb, that is the moment to reconsider the dependency.

use std::time::Duration;

use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

const ALGORITHM: &str = "AWS4-HMAC-SHA256";
const SERVICE: &str = "s3";

/// Object-key scheme version. Bumping this is how a future key layout change
/// stays decodable: rows written under `v1/` keep resolving while new rows land
/// under `v2/`, for the 30 days it takes the old ones to age out.
const KEY_SCHEME: &str = "v1";

/// How many times one PUT is attempted before the chunk is given up on.
///
/// R2 answers 503/500/429 under its own load and a bare re-attempt clears
/// nearly all of them; before this existed a single blip lost the chunk and the
/// replay played back with a hole. Four attempts spans at most ~2.8s of backoff,
/// inside the request timeout the SDK is already waiting on.
const MAX_ATTEMPTS: u32 = 4;

/// First backoff step. Doubles per attempt, plus per-object jitter.
const BASE_BACKOFF_MS: u64 = 100;

/// Ceiling on a `Retry-After` we will honour. R2 rarely sends one, but an
/// unbounded value would park a request until the caller's timeout fires.
const MAX_RETRY_AFTER_MS: u64 = 2_000;

#[derive(Debug)]
pub enum R2Error {
    /// The request never got a response (DNS, TLS, connect, timeout).
    Transport(String),
    /// R2 answered with a non-2xx status. `request_id` and `cf_ray` are what
    /// Cloudflare support asks for first, and they are unrecoverable after the
    /// fact — so they are carried on the error rather than only logged.
    Status {
        status: u16,
        body: String,
        request_id: Option<String>,
        cf_ray: Option<String>,
        /// Parsed `Retry-After`, in ms. Never folded into `body`: the Display
        /// string is the error fingerprint, and a varying suffix would split
        /// one cause across thousands of issues.
        retry_after_ms: Option<u64>,
    },
}

impl std::fmt::Display for R2Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(message) => write!(f, "r2 transport error: {message}"),
            Self::Status { status, body, .. } => {
                write!(f, "r2 responded {status}: {body}")
            }
        }
    }
}

impl std::error::Error for R2Error {}

impl R2Error {
    /// Whether another attempt could plausibly succeed. Transport failures and
    /// R2's own overload/throttle statuses are transient; any other 4xx is our
    /// request being wrong and would be rejected identically forever.
    fn is_retryable(&self) -> bool {
        match self {
            Self::Transport(_) => true,
            Self::Status { status, .. } => matches!(status, 429 | 500 | 502 | 503 | 504),
        }
    }

    /// Stable low-cardinality label for `error.type` and metrics.
    pub fn error_kind(&self) -> &'static str {
        match self {
            Self::Transport(_) => "r2_transport",
            Self::Status { status, .. } => match status {
                429 => "r2_throttled",
                500..=599 => "r2_server_error",
                _ => "r2_rejected",
            },
        }
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Transport(_) => None,
            Self::Status { status, .. } => Some(*status),
        }
    }

    pub fn request_id(&self) -> Option<&str> {
        match self {
            Self::Transport(_) => None,
            Self::Status { request_id, .. } => request_id.as_deref(),
        }
    }

    pub fn cf_ray(&self) -> Option<&str> {
        match self {
            Self::Transport(_) => None,
            Self::Status { cf_ray, .. } => cf_ray.as_deref(),
        }
    }

    fn retry_after_ms(&self) -> Option<u64> {
        match self {
            Self::Transport(_) => None,
            Self::Status { retry_after_ms, .. } => *retry_after_ms,
        }
    }
}

/// A failed PUT plus how many attempts it actually cost. A non-retryable
/// rejection stops at 1, so the caller must not assume the maximum. Display
/// delegates to the inner error: the message is the error fingerprint and a
/// varying attempt count in it would split one cause into several issues.
#[derive(Debug)]
pub struct R2PutError {
    pub error: R2Error,
    pub attempts: u32,
}

impl std::fmt::Display for R2PutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(f)
    }
}

impl std::error::Error for R2PutError {}

impl R2PutError {
    pub fn error_kind(&self) -> &'static str {
        self.error.error_kind()
    }
    pub fn status(&self) -> Option<u16> {
        self.error.status()
    }
    pub fn request_id(&self) -> Option<&str> {
        self.error.request_id()
    }
    pub fn cf_ray(&self) -> Option<&str> {
        self.error.cf_ray()
    }
}

/// What one (possibly retried) PUT cost. `attempts` is 1 on the happy path;
/// anything higher is a transient failure this module absorbed, and is the only
/// evidence that R2 is degrading before it starts dropping chunks outright.
#[derive(Debug, Clone, Copy)]
pub struct PutOutcome {
    pub attempts: u32,
}

/// Read one response header as an owned string, dropping non-ASCII values.
fn header_string(response: &reqwest::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.chars().take(128).collect())
}

/// `Retry-After` in delta-seconds. The HTTP-date form is not parsed: R2 does
/// not send it, and a date we mis-parse is worse than the backoff we already
/// have.
fn parse_retry_after_ms(value: &str) -> Option<u64> {
    value
        .trim()
        .parse::<u64>()
        .ok()
        .map(|seconds| seconds.saturating_mul(1_000))
}

/// Exponential backoff with per-key jitter, floored by any `Retry-After`.
///
/// The jitter is derived from the object key rather than a RNG: it needs to
/// decorrelate *different* chunks retrying against a degraded R2, and the key is
/// already unique per chunk. Same-key retries sharing an offset is harmless, and
/// this keeps the module dependency-free, which is the point of it existing.
fn backoff_for(attempt: u32, key: &str, retry_after_ms: Option<u64>) -> Duration {
    let step = BASE_BACKOFF_MS.saturating_mul(1u64 << attempt.min(6));
    let backoff = step.saturating_add(key_jitter(key, step));
    let floor = retry_after_ms.unwrap_or(0).min(MAX_RETRY_AFTER_MS);
    Duration::from_millis(backoff.max(floor))
}

/// Jitter in `[0, step)`, derived from the object key.
///
/// FNV-1a rather than a byte sum: keys differ only in their trailing chunk
/// sequence, and a sum sends adjacent chunks to adjacent values that integer
/// division then collapses onto the same delay — which is the lockstep the
/// jitter exists to break.
fn key_jitter(key: &str, step: u64) -> u64 {
    let hash = key.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |acc, byte| {
        (acc ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    hash % step.max(1)
}

/// Storage key for one replay chunk.
///
/// `orgId` leads so a per-tenant lifecycle rule or a "delete this org's data"
/// sweep is a prefix operation. `chunkSeq` is zero-padded so lexicographic list
/// order equals playback order.
///
/// Deliberately carries no date component: the read side reconstructs this key
/// from the ClickHouse row's `(OrgId, SessionId, ChunkSeq)` alone, and a date
/// would couple it to the gateway's `Utc::now()` in a way that disagrees with
/// the row's own `Timestamp` across a UTC midnight boundary.
pub fn replay_object_key(org_id: &str, session_id: &str, chunk_seq: u32) -> String {
    format!("{KEY_SCHEME}/{org_id}/{session_id}/{chunk_seq:08}.json.gz")
}

/// Writes replay chunk payloads to an S3-compatible bucket.
#[derive(Clone)]
pub struct ReplayBlobStore {
    client: crate::telemetry::HttpClient,
    /// Origin only, no trailing slash: `https://<account>.r2.cloudflarestorage.com`.
    endpoint: String,
    host: String,
    bucket: String,
    access_key_id: String,
    secret_access_key: String,
    region: String,
    timeout: Duration,
}
/// Hand-written: a derived `Debug` would put the signing credentials one
/// `{:?}` away from a log line.
impl std::fmt::Debug for ReplayBlobStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReplayBlobStore")
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field("region", &self.region)
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

impl ReplayBlobStore {
    pub fn new(
        client: impl Into<crate::telemetry::HttpClient>,
        endpoint: &str,
        bucket: String,
        access_key_id: String,
        secret_access_key: String,
        region: String,
        timeout: Duration,
    ) -> Self {
        let endpoint = endpoint.trim_end_matches('/').to_owned();
        let host = host_from_endpoint(&endpoint);
        Self {
            client: client.into(),
            endpoint,
            host,
            bucket,
            access_key_id,
            secret_access_key,
            region,
            timeout,
        }
    }

    /// PUT one object, retrying transient failures. `body` is stored verbatim —
    /// the caller owns compression.
    ///
    /// Each attempt re-signs against a fresh clock rather than reusing the first
    /// signature: SigV4 timestamps have a validity window, and a retry that
    /// waited out a long backoff would otherwise be rejected as skewed.
    pub async fn put_object(
        &self,
        key: &str,
        body: Vec<u8>,
        content_type: &str,
        content_encoding: Option<&str>,
    ) -> Result<PutOutcome, R2PutError> {
        // `Bytes` so a retry is a refcount bump rather than a copy of the whole
        // chunk — this path runs ~800k times a day and all but ~0.02% of those
        // never reach attempt 2.
        let body = bytes::Bytes::from(body);
        let mut attempt = 1;
        loop {
            let error = match self
                .put_object_at(
                    key,
                    body.clone(),
                    content_type,
                    content_encoding,
                    Utc::now(),
                )
                .await
            {
                Ok(()) => return Ok(PutOutcome { attempts: attempt }),
                Err(error) => error,
            };
            if attempt >= MAX_ATTEMPTS || !error.is_retryable() {
                return Err(R2PutError {
                    error,
                    attempts: attempt,
                });
            }
            tracing::warn!(
                key,
                attempt,
                error_kind = error.error_kind(),
                request_id = error.request_id().unwrap_or_default(),
                cf_ray = error.cf_ray().unwrap_or_default(),
                error = %error,
                "retrying replay chunk PUT after transient r2 failure"
            );
            tokio::time::sleep(backoff_for(attempt, key, error.retry_after_ms())).await;
            attempt += 1;
        }
    }

    async fn put_object_at(
        &self,
        key: &str,
        body: bytes::Bytes,
        content_type: &str,
        content_encoding: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(), R2Error> {
        let canonical_uri = format!("/{}/{}", self.bucket, uri_encode_path(key));
        let payload_sha256 = hex(&Sha256::digest(&body));

        let mut headers: Vec<(String, String)> = vec![
            ("content-type".to_owned(), content_type.to_owned()),
            ("host".to_owned(), self.host.clone()),
            ("x-amz-content-sha256".to_owned(), payload_sha256.clone()),
            ("x-amz-date".to_owned(), amz_date(now)),
        ];
        if let Some(encoding) = content_encoding {
            headers.push(("content-encoding".to_owned(), encoding.to_owned()));
        }

        let authorization = authorization_header(&SigningParams {
            method: "PUT",
            canonical_uri: &canonical_uri,
            canonical_query: "",
            headers: &headers,
            payload_sha256: &payload_sha256,
            now,
            access_key_id: &self.access_key_id,
            secret_access_key: &self.secret_access_key,
            region: &self.region,
            service: SERVICE,
        });

        let mut request = self
            .client
            .put(format!("{}{}", self.endpoint, canonical_uri))
            .timeout(self.timeout)
            .header("authorization", authorization);
        for (name, value) in &headers {
            // `host` is set by reqwest from the URL; re-setting it risks a
            // mismatch with what we just signed.
            if name != "host" {
                request = request.header(name.as_str(), value.as_str());
            }
        }

        let response = request
            .body(body)
            .send()
            .await
            .map_err(|e| R2Error::Transport(e.to_string()))?;

        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        // Read before the body: `text()` consumes the response.
        let request_id = header_string(&response, "x-amz-request-id");
        let cf_ray = header_string(&response, "cf-ray");
        let retry_after = header_string(&response, "retry-after");
        // R2 returns an XML error document; keep a bounded prefix for the log.
        let body = response.text().await.unwrap_or_default();
        Err(R2Error::Status {
            status: status.as_u16(),
            body: body.chars().take(512).collect(),
            request_id,
            cf_ray,
            retry_after_ms: retry_after.and_then(|value| parse_retry_after_ms(&value)),
        })
    }
}

struct SigningParams<'a> {
    method: &'a str,
    canonical_uri: &'a str,
    canonical_query: &'a str,
    /// Lowercase header names; sorted internally, so call order is free.
    headers: &'a [(String, String)],
    payload_sha256: &'a str,
    now: DateTime<Utc>,
    access_key_id: &'a str,
    secret_access_key: &'a str,
    region: &'a str,
    service: &'a str,
}

fn authorization_header(params: &SigningParams) -> String {
    let mut headers: Vec<(String, String)> = params
        .headers
        .iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    headers.sort_by(|a, b| a.0.cmp(&b.0));

    let signed_headers = headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers = headers
        .iter()
        .fold(String::new(), |mut out, (name, value)| {
            out.push_str(name);
            out.push(':');
            out.push_str(value);
            out.push('\n');
            out
        });

    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        params.method,
        params.canonical_uri,
        params.canonical_query,
        canonical_headers,
        signed_headers,
        params.payload_sha256,
    );

    let datestamp = params.now.format("%Y%m%d").to_string();
    let scope = format!(
        "{}/{}/{}/aws4_request",
        datestamp, params.region, params.service
    );
    let string_to_sign = format!(
        "{}\n{}\n{}\n{}",
        ALGORITHM,
        amz_date(params.now),
        scope,
        hex(&Sha256::digest(canonical_request.as_bytes())),
    );

    let signing_key = signing_key(
        params.secret_access_key,
        &datestamp,
        params.region,
        params.service,
    );
    let signature = hex(&hmac(&signing_key, string_to_sign.as_bytes()));

    format!(
        "{ALGORITHM} Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        params.access_key_id,
    )
}

fn signing_key(secret_access_key: &str, datestamp: &str, region: &str, service: &str) -> Vec<u8> {
    let mut key = hmac(
        format!("AWS4{secret_access_key}").as_bytes(),
        datestamp.as_bytes(),
    );
    key = hmac(&key, region.as_bytes());
    key = hmac(&key, service.as_bytes());
    hmac(&key, b"aws4_request")
}

#[expect(
    clippy::expect_used,
    reason = "HMAC accepts keys of any length, so `new_from_slice` cannot fail here"
)]
fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(HEX_LOWER[usize::from(byte >> 4)]));
        out.push(char::from(HEX_LOWER[usize::from(byte & 0x0f)]));
    }
    out
}

const HEX_LOWER: &[u8; 16] = b"0123456789abcdef";
const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";

fn amz_date(now: DateTime<Utc>) -> String {
    now.format("%Y%m%dT%H%M%SZ").to_string()
}

/// RFC 3986 encoding for a URI path: `/` stays a separator, everything outside
/// the unreserved set is percent-encoded with uppercase hex. Replay keys only
/// ever contain unreserved characters, but a signature that disagrees with the
/// request line by one byte is a 403 with no useful message, so encode properly
/// rather than trusting the caller.
fn uri_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*byte as char);
            }
            _ => {
                out.push('%');
                out.push(char::from(HEX_UPPER[usize::from(byte >> 4)]));
                out.push(char::from(HEX_UPPER[usize::from(byte & 0x0f)]));
            }
        }
    }
    out
}

fn host_from_endpoint(endpoint: &str) -> String {
    endpoint
        .split_once("://")
        .map_or(endpoint, |(_, rest)| rest)
        .split('/')
        .next()
        .unwrap_or("")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone as _;

    fn status_error(status: u16) -> R2Error {
        R2Error::Status {
            status,
            body: String::new(),
            request_id: None,
            cf_ray: None,
            retry_after_ms: None,
        }
    }

    // The whole point of the retry: R2's overload and throttle statuses are
    // transient, and a chunk dropped on one of them is a hole in a replay.
    #[test]
    fn retries_transient_r2_failures_only() {
        for status in [429, 500, 502, 503, 504] {
            assert!(
                status_error(status).is_retryable(),
                "{status} is transient and must be retried"
            );
        }
        // Our request is wrong; re-sending it is guaranteed to fail identically.
        for status in [400, 403, 404, 412] {
            assert!(
                !status_error(status).is_retryable(),
                "{status} is terminal and must not be retried"
            );
        }
        assert!(R2Error::Transport("connection reset".to_owned()).is_retryable());
    }

    #[test]
    fn labels_failures_for_triage() {
        assert_eq!(status_error(429).error_kind(), "r2_throttled");
        assert_eq!(status_error(503).error_kind(), "r2_server_error");
        assert_eq!(status_error(403).error_kind(), "r2_rejected");
        assert_eq!(
            R2Error::Transport(String::new()).error_kind(),
            "r2_transport"
        );
    }

    // A varying attempt count or retry-after in the message would split one
    // cause across thousands of error issues, which is what the separate fields
    // exist to prevent.
    #[test]
    fn the_error_message_stays_a_stable_fingerprint() {
        let one = R2PutError {
            error: status_error(503),
            attempts: 1,
        };
        let four = R2PutError {
            error: status_error(503),
            attempts: 4,
        };
        assert_eq!(one.to_string(), four.to_string());
        assert_eq!(one.to_string(), "r2 responded 503: ");
    }

    #[test]
    fn backoff_grows_and_differs_between_keys() {
        let first = backoff_for(1, "v1/org/sess/00000001.json.gz", None);
        let later = backoff_for(3, "v1/org/sess/00000001.json.gz", None);
        assert!(later > first, "backoff must grow with the attempt");
        assert!(
            later < Duration::from_millis(1_600),
            "one backoff step must stay well inside the caller's timeout, got {later:?}"
        );
        // Different chunks must not retry in lockstep against a degraded bucket.
        assert_ne!(
            backoff_for(1, "v1/org/sess/00000001.json.gz", None),
            backoff_for(1, "v1/org/sess/00000002.json.gz", None)
        );
    }

    #[test]
    fn retry_after_raises_the_floor_but_is_capped() {
        assert_eq!(parse_retry_after_ms("2"), Some(2_000));
        assert_eq!(parse_retry_after_ms("Wed, 21 Oct 2026 07:28:00 GMT"), None);
        // An unbounded Retry-After would park the request past the caller's
        // timeout; the cap keeps the wait bounded.
        let capped = backoff_for(1, "k", Some(600_000));
        assert!(capped <= Duration::from_millis(MAX_RETRY_AFTER_MS));
    }

    #[test]
    fn builds_the_documented_object_key() {
        assert_eq!(
            replay_object_key("org_123", "sess_abc", 7),
            "v1/org_123/sess_abc/00000007.json.gz"
        );
    }

    #[test]
    fn zero_pads_chunk_seq_so_lexicographic_order_is_playback_order() {
        let mut keys = vec![
            replay_object_key("o", "s", 10),
            replay_object_key("o", "s", 2),
            replay_object_key("o", "s", 1),
        ];
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "v1/o/s/00000001.json.gz",
                "v1/o/s/00000002.json.gz",
                "v1/o/s/00000010.json.gz",
            ]
        );
    }

    #[test]
    fn chunk_seq_above_the_padding_width_still_sorts_after() {
        // u32::MAX is 10 digits, so it overflows the :08 pad. Ordering only has
        // to hold within a session, and a session cannot reach 100M chunks
        // (the SDK flushes at most every 5s), but assert the format doesn't
        // truncate.
        assert_eq!(
            replay_object_key("o", "s", 123_456_789),
            "v1/o/s/123456789.json.gz"
        );
    }

    #[test]
    fn encodes_reserved_characters_in_the_path() {
        assert_eq!(uri_encode_path("/test$file.text"), "/test%24file.text");
        assert_eq!(uri_encode_path("v1/a-b_c.d~e/f"), "v1/a-b_c.d~e/f");
        assert_eq!(uri_encode_path("a b"), "a%20b");
    }

    #[test]
    fn extracts_host_from_endpoint() {
        assert_eq!(
            host_from_endpoint("https://acct.r2.cloudflarestorage.com"),
            "acct.r2.cloudflarestorage.com"
        );
        assert_eq!(host_from_endpoint("http://127.0.0.1:8080"), "127.0.0.1:8080");
    }

    // AWS SigV4 published test vector — "Signature Calculation: Transfer Payload
    // in a Single Chunk", PUT Object example from the S3 REST API docs. Uses the
    // canonical AKIAIOSFODNN7EXAMPLE credentials. A signing bug is otherwise a
    // 403 with an opaque body that you debug in staging, so pin the whole
    // Authorization value against a known-good vector.
    const AWS_EXAMPLE_KEY_ID: &str = "AKIAIOSFODNN7EXAMPLE";
    const AWS_EXAMPLE_SECRET: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    // `signing_key` is covered transitively and non-circularly by the vector
    // below: that signature cannot match unless all four derivation stages are
    // right. A standalone assertion on the intermediate key would have to pin a
    // hex string we produced ourselves, which proves nothing.
    #[test]
    fn matches_the_aws_put_object_vector() {
        let now = Utc.with_ymd_and_hms(2013, 5, 24, 0, 0, 0).unwrap();
        let payload_sha256 =
            "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072".to_owned();
        let headers = vec![
            (
                "date".to_owned(),
                "Fri, 24 May 2013 00:00:00 GMT".to_owned(),
            ),
            (
                "host".to_owned(),
                "examplebucket.s3.amazonaws.com".to_owned(),
            ),
            ("x-amz-content-sha256".to_owned(), payload_sha256.clone()),
            ("x-amz-date".to_owned(), "20130524T000000Z".to_owned()),
            (
                "x-amz-storage-class".to_owned(),
                "REDUCED_REDUNDANCY".to_owned(),
            ),
        ];

        let authorization = authorization_header(&SigningParams {
            method: "PUT",
            canonical_uri: "/test%24file.text",
            canonical_query: "",
            headers: &headers,
            payload_sha256: &payload_sha256,
            now,
            access_key_id: AWS_EXAMPLE_KEY_ID,
            secret_access_key: AWS_EXAMPLE_SECRET,
            region: "us-east-1",
            service: "s3",
        });

        assert_eq!(
            authorization,
            "AWS4-HMAC-SHA256 \
             Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, \
             Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
        );
    }

    #[test]
    fn sorts_headers_regardless_of_call_order() {
        let now = Utc.with_ymd_and_hms(2013, 5, 24, 0, 0, 0).unwrap();
        let sha = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072".to_owned();
        let build = |headers: Vec<(String, String)>| {
            authorization_header(&SigningParams {
                method: "PUT",
                canonical_uri: "/bucket/key",
                canonical_query: "",
                headers: &headers,
                payload_sha256: &sha,
                now,
                access_key_id: AWS_EXAMPLE_KEY_ID,
                secret_access_key: AWS_EXAMPLE_SECRET,
                region: "auto",
                service: "s3",
            })
        };
        let forward = build(vec![
            ("host".to_owned(), "h".to_owned()),
            ("x-amz-date".to_owned(), "20130524T000000Z".to_owned()),
        ]);
        let reversed = build(vec![
            ("x-amz-date".to_owned(), "20130524T000000Z".to_owned()),
            ("HOST".to_owned(), "h".to_owned()),
        ]);
        assert_eq!(forward, reversed);
    }
}
