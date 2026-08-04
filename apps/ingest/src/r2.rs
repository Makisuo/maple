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

#[derive(Debug)]
pub enum R2Error {
    /// The request never got a response (DNS, TLS, connect, timeout).
    Transport(String),
    /// R2 answered with a non-2xx status.
    Status { status: u16, body: String },
}

impl std::fmt::Display for R2Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            R2Error::Transport(message) => write!(f, "r2 transport error: {message}"),
            R2Error::Status { status, body } => {
                write!(f, "r2 responded {status}: {body}")
            }
        }
    }
}

impl std::error::Error for R2Error {}

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
    client: reqwest::Client,
    /// Origin only, no trailing slash: `https://<account>.r2.cloudflarestorage.com`.
    endpoint: String,
    host: String,
    bucket: String,
    access_key_id: String,
    secret_access_key: String,
    region: String,
    timeout: Duration,
}

impl ReplayBlobStore {
    pub fn new(
        client: reqwest::Client,
        endpoint: String,
        bucket: String,
        access_key_id: String,
        secret_access_key: String,
        region: String,
        timeout: Duration,
    ) -> Self {
        let endpoint = endpoint.trim_end_matches('/').to_string();
        let host = host_from_endpoint(&endpoint);
        Self {
            client,
            endpoint,
            host,
            bucket,
            access_key_id,
            secret_access_key,
            region,
            timeout,
        }
    }

    /// PUT one object. `body` is stored verbatim — the caller owns compression.
    pub async fn put_object(
        &self,
        key: &str,
        body: Vec<u8>,
        content_type: &str,
        content_encoding: Option<&str>,
    ) -> Result<(), R2Error> {
        self.put_object_at(key, body, content_type, content_encoding, Utc::now())
            .await
    }

    async fn put_object_at(
        &self,
        key: &str,
        body: Vec<u8>,
        content_type: &str,
        content_encoding: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(), R2Error> {
        let canonical_uri = format!("/{}/{}", self.bucket, uri_encode_path(key));
        let payload_sha256 = hex(&Sha256::digest(&body));

        let mut headers: Vec<(String, String)> = vec![
            ("content-type".to_string(), content_type.to_string()),
            ("host".to_string(), self.host.clone()),
            ("x-amz-content-sha256".to_string(), payload_sha256.clone()),
            ("x-amz-date".to_string(), amz_date(now)),
        ];
        if let Some(encoding) = content_encoding {
            headers.push(("content-encoding".to_string(), encoding.to_string()));
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
        // R2 returns an XML error document; keep a bounded prefix for the log.
        let body = response.text().await.unwrap_or_default();
        Err(R2Error::Status {
            status: status.as_u16(),
            body: body.chars().take(512).collect(),
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
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    headers.sort_by(|a, b| a.0.cmp(&b.0));

    let signed_headers = headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers = headers
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect::<String>();

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

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

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
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn host_from_endpoint(endpoint: &str) -> String {
    endpoint
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(endpoint)
        .split('/')
        .next()
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone as _;

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
            "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072".to_string();
        let headers = vec![
            (
                "date".to_string(),
                "Fri, 24 May 2013 00:00:00 GMT".to_string(),
            ),
            ("host".to_string(), "examplebucket.s3.amazonaws.com".to_string()),
            ("x-amz-content-sha256".to_string(), payload_sha256.clone()),
            ("x-amz-date".to_string(), "20130524T000000Z".to_string()),
            (
                "x-amz-storage-class".to_string(),
                "REDUCED_REDUNDANCY".to_string(),
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
        let sha = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072".to_string();
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
            ("host".to_string(), "h".to_string()),
            ("x-amz-date".to_string(), "20130524T000000Z".to_string()),
        ]);
        let reversed = build(vec![
            ("x-amz-date".to_string(), "20130524T000000Z".to_string()),
            ("HOST".to_string(), "h".to_string()),
        ]);
        assert_eq!(forward, reversed);
    }
}
