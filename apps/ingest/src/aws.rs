//! SigV4 signing, ECS credentials, and the handful of S3 verbs this binary
//! issues.
//!
//! Deliberately not `aws-sdk-s3`. The gateway needs PUT/GET/LIST/DELETE against
//! one bucket, plus the conditional PUT that makes orphan claiming safe; that is
//! a few hundred lines on top of the `hmac`/`sha2`/`chrono`/`reqwest` crates
//! already linked for ingest-key hashing, against the whole smithy stack and its
//! compile time in a binary whose image size is a deploy-latency cost.
//!
//! Two callers: `r2.rs` (replay chunks, static keys, Cloudflare R2) and
//! `wal_store.rs` (WAL segments, task-role credentials, AWS S3).

use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::telemetry::HttpClient;

type HmacSha256 = Hmac<Sha256>;

const ALGORITHM: &str = "AWS4-HMAC-SHA256";

/// Credentials for one signed request. `session_token` is present for the
/// temporary credentials an ECS task role hands out and absent for static keys.
#[derive(Clone)]
pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

/// Hand-written so the secret is not one `{:?}` away from a log line.
impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("access_key_id", &self.access_key_id)
            .field("session_token", &self.session_token.is_some())
            .finish_non_exhaustive()
    }
}

/// Where a request's credentials come from.
///
/// `Static` is a pair of long-lived keys from the environment. `Container`
/// fetches from the ECS agent's credentials endpoint and refreshes before the
/// credentials expire — which is what lets the task carry an IAM role instead of
/// a secret.
#[derive(Debug)]
pub enum CredentialsProvider {
    Static(Credentials),
    Container {
        client: HttpClient,
        url: String,
        authorization: Option<String>,
        cached: Mutex<Option<CachedCredentials>>,
    },
}

pub struct CachedCredentials {
    credentials: Credentials,
    /// Refresh once this passes, rather than at expiry: a request signed with
    /// credentials that expire mid-flight is a 403 with nothing to retry.
    refresh_after: Instant,
}

impl std::fmt::Debug for CachedCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CachedCredentials").finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct ContainerCredentialsResponse {
    #[serde(rename = "AccessKeyId")]
    access_key_id: String,
    #[serde(rename = "SecretAccessKey")]
    secret_access_key: String,
    #[serde(rename = "Token")]
    token: Option<String>,
    #[serde(rename = "Expiration")]
    expiration: Option<String>,
}

/// Refresh this far before the credentials actually expire.
const CREDENTIAL_REFRESH_MARGIN: Duration = Duration::from_secs(5 * 60);
/// How long credentials without a parseable expiry are trusted.
const CREDENTIAL_FALLBACK_TTL: Duration = Duration::from_secs(15 * 60);

impl CredentialsProvider {
    /// The provider ECS gives a task, or `None` when the environment has no
    /// container credentials endpoint (a dev machine, or a container without a
    /// task role).
    pub fn from_ecs_environment(client: HttpClient) -> Option<Self> {
        let url = std::env::var("AWS_CONTAINER_CREDENTIALS_FULL_URI")
            .ok()
            .or_else(|| {
                std::env::var("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
                    .ok()
                    .map(|path| format!("http://169.254.170.2{path}"))
            })?;
        Some(Self::Container {
            client,
            url,
            authorization: std::env::var("AWS_CONTAINER_AUTHORIZATION_TOKEN").ok(),
            cached: Mutex::new(None),
        })
    }

    pub fn from_static(access_key_id: String, secret_access_key: String) -> Self {
        Self::Static(Credentials {
            access_key_id,
            secret_access_key,
            session_token: None,
        })
    }

    pub async fn credentials(&self) -> Result<Credentials, String> {
        match self {
            Self::Static(credentials) => Ok(credentials.clone()),
            Self::Container {
                client,
                url,
                authorization,
                cached,
            } => {
                let mut slot = cached.lock().await;
                if let Some(current) = slot.as_ref() {
                    if Instant::now() < current.refresh_after {
                        return Ok(current.credentials.clone());
                    }
                }
                let mut request = client.get(url).timeout(Duration::from_secs(5));
                if let Some(token) = authorization {
                    request = request.header("authorization", token);
                }
                let response = request
                    .send()
                    .await
                    .map_err(|error| format!("fetch container credentials: {error}"))?;
                if !response.status().is_success() {
                    return Err(format!(
                        "container credentials endpoint responded {}",
                        response.status().as_u16()
                    ));
                }
                let body: ContainerCredentialsResponse = response
                    .json()
                    .await
                    .map_err(|error| format!("decode container credentials: {error}"))?;
                let ttl = body
                    .expiration
                    .as_deref()
                    .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
                    .and_then(|expiry| {
                        (expiry.with_timezone(&Utc) - Utc::now())
                            .to_std()
                            .ok()
                            .map(|ttl| ttl.saturating_sub(CREDENTIAL_REFRESH_MARGIN))
                    })
                    .filter(|ttl| !ttl.is_zero())
                    .unwrap_or(CREDENTIAL_FALLBACK_TTL);
                let credentials = Credentials {
                    access_key_id: body.access_key_id,
                    secret_access_key: body.secret_access_key,
                    session_token: body.token,
                };
                *slot = Some(CachedCredentials {
                    credentials: credentials.clone(),
                    refresh_after: Instant::now() + ttl,
                });
                Ok(credentials)
            }
        }
    }
}

#[expect(
    missing_debug_implementations,
    reason = "carries the signing secret; a derived Debug would put it one {:?} from a log line"
)]
pub struct SigningParams<'a> {
    pub method: &'a str,
    pub canonical_uri: &'a str,
    pub canonical_query: &'a str,
    /// Lowercase header names; sorted internally, so call order is free.
    pub headers: &'a [(String, String)],
    pub payload_sha256: &'a str,
    pub now: DateTime<Utc>,
    pub access_key_id: &'a str,
    pub secret_access_key: &'a str,
    pub region: &'a str,
    pub service: &'a str,
}

pub fn authorization_header(params: &SigningParams) -> String {
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

pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(HEX_LOWER[usize::from(byte >> 4)]));
        out.push(char::from(HEX_LOWER[usize::from(byte & 0x0f)]));
    }
    out
}

const HEX_LOWER: &[u8; 16] = b"0123456789abcdef";
const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";

pub fn amz_date(now: DateTime<Utc>) -> String {
    now.format("%Y%m%dT%H%M%SZ").to_string()
}

/// RFC 3986 encoding for a URI path: `/` stays a separator, everything outside
/// the unreserved set is percent-encoded with uppercase hex. A signature that
/// disagrees with the request line by one byte is a 403 with no useful message,
/// so encode properly rather than trusting the caller.
pub fn uri_encode_path(path: &str) -> String {
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

/// Same rules as a path segment, except `/` is also encoded — query values are
/// not path separators.
fn uri_encode_query(value: &str) -> String {
    uri_encode_path(value).replace('/', "%2F")
}

pub fn host_from_endpoint(endpoint: &str) -> String {
    endpoint
        .split_once("://")
        .map_or(endpoint, |(_, rest)| rest)
        .split('/')
        .next()
        .unwrap_or("")
        .to_owned()
}

#[derive(Debug)]
pub enum S3Error {
    /// The request never got a response (DNS, TLS, connect, timeout).
    Transport(String),
    /// A non-2xx status, with a bounded prefix of the XML error document.
    Status { status: u16, body: String },
}

impl std::fmt::Display for S3Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(message) => write!(f, "s3 transport error: {message}"),
            Self::Status { status, body } => write!(f, "s3 responded {status}: {body}"),
        }
    }
}

impl std::error::Error for S3Error {}

impl S3Error {
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Transport(_) => None,
            Self::Status { status, .. } => Some(*status),
        }
    }

    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Transport(_) => true,
            Self::Status { status, .. } => matches!(status, 429 | 500 | 502 | 503 | 504),
        }
    }

    /// Stable low-cardinality label for `error.type`.
    pub fn error_kind(&self) -> &'static str {
        match self {
            Self::Transport(_) => "s3_transport",
            Self::Status { status, .. } => match status {
                412 => "s3_precondition_failed",
                429 => "s3_throttled",
                500..=599 => "s3_server_error",
                _ => "s3_rejected",
            },
        }
    }
}

/// One object in a `ListObjectsV2` page.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct S3Object {
    pub key: String,
    pub last_modified: Option<DateTime<Utc>>,
    pub size: u64,
}

/// A bucket, addressed path-style, signed per request.
///
/// Path-style keeps one host for signing and DNS, which matters for the S3
/// gateway endpoint the ingest VPC routes through (there is no NAT, so a
/// virtual-hosted name that resolves outside the endpoint's prefix list would
/// simply not be reachable).
pub struct S3Client {
    client: HttpClient,
    endpoint: String,
    host: String,
    bucket: String,
    region: String,
    credentials: Arc<CredentialsProvider>,
    timeout: Duration,
}

impl std::fmt::Debug for S3Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S3Client")
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field("region", &self.region)
            .finish_non_exhaustive()
    }
}

impl S3Client {
    pub fn new(
        client: impl Into<HttpClient>,
        endpoint: &str,
        bucket: String,
        region: String,
        credentials: Arc<CredentialsProvider>,
        timeout: Duration,
    ) -> Self {
        let endpoint = endpoint.trim_end_matches('/').to_owned();
        let host = host_from_endpoint(&endpoint);
        Self {
            client: client.into(),
            endpoint,
            host,
            bucket,
            region,
            credentials,
            timeout,
        }
    }

    pub fn bucket(&self) -> &str {
        &self.bucket
    }

    /// PUT an object. `if_none_match` set to `*` makes the write conditional on
    /// the key not existing, which S3 answers with 412 when it does — the
    /// primitive orphan claiming is built on.
    pub async fn put(&self, key: &str, body: Vec<u8>, if_none_match: bool) -> Result<(), S3Error> {
        let mut headers = vec![(
            "content-type".to_owned(),
            "application/octet-stream".to_owned(),
        )];
        if if_none_match {
            headers.push(("if-none-match".to_owned(), "*".to_owned()));
        }
        self.send("PUT", key, "", headers, body).await.map(drop)
    }

    pub async fn get(&self, key: &str) -> Result<Vec<u8>, S3Error> {
        self.send("GET", key, "", Vec::new(), Vec::new()).await
    }

    pub async fn delete(&self, key: &str) -> Result<(), S3Error> {
        match self.send("DELETE", key, "", Vec::new(), Vec::new()).await {
            // S3 answers 204 for a key that was never there; treat an explicit
            // 404 the same way so a re-run of a half-finished cleanup is a no-op.
            Err(S3Error::Status { status: 404, .. }) | Ok(_) => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// Every object under `prefix`, following continuation tokens.
    ///
    /// `max_keys` bounds one page; the loop is bounded by `max_pages` so a
    /// pathological prefix cannot turn a boot into an unbounded listing.
    pub async fn list(&self, prefix: &str, max_pages: usize) -> Result<Vec<S3Object>, S3Error> {
        let mut objects = Vec::new();
        let mut token: Option<String> = None;
        for _ in 0..max_pages {
            // Query parameters must be sorted by key for the canonical request.
            let mut query = format!(
                "continuation-token={}&list-type=2&max-keys=1000&prefix={}",
                token.as_deref().map(uri_encode_query).unwrap_or_default(),
                uri_encode_query(prefix),
            );
            if token.is_none() {
                query = format!(
                    "list-type=2&max-keys=1000&prefix={}",
                    uri_encode_query(prefix)
                );
            }
            let body = self.send("GET", "", &query, Vec::new(), Vec::new()).await?;
            let body = String::from_utf8_lossy(&body);
            objects.extend(parse_list_objects(&body));
            match parse_tag(&body, "NextContinuationToken") {
                Some(next) if parse_tag(&body, "IsTruncated").as_deref() == Some("true") => {
                    token = Some(next);
                }
                _ => return Ok(objects),
            }
        }
        Ok(objects)
    }

    async fn send(
        &self,
        method: &str,
        key: &str,
        canonical_query: &str,
        extra_headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> Result<Vec<u8>, S3Error> {
        let credentials = self
            .credentials
            .credentials()
            .await
            .map_err(S3Error::Transport)?;
        let canonical_uri = if key.is_empty() {
            format!("/{}", self.bucket)
        } else {
            format!("/{}/{}", self.bucket, uri_encode_path(key))
        };
        let payload_sha256 = hex(&Sha256::digest(&body));
        let now = Utc::now();

        let mut headers = extra_headers;
        headers.push(("host".to_owned(), self.host.clone()));
        headers.push(("x-amz-content-sha256".to_owned(), payload_sha256.clone()));
        headers.push(("x-amz-date".to_owned(), amz_date(now)));
        if let Some(token) = &credentials.session_token {
            headers.push(("x-amz-security-token".to_owned(), token.clone()));
        }

        let authorization = authorization_header(&SigningParams {
            method,
            canonical_uri: &canonical_uri,
            canonical_query,
            headers: &headers,
            payload_sha256: &payload_sha256,
            now,
            access_key_id: &credentials.access_key_id,
            secret_access_key: &credentials.secret_access_key,
            region: &self.region,
            service: "s3",
        });

        let url = if canonical_query.is_empty() {
            format!("{}{}", self.endpoint, canonical_uri)
        } else {
            format!("{}{}?{}", self.endpoint, canonical_uri, canonical_query)
        };
        let mut request = self
            .client
            .request(
                method
                    .parse()
                    .map_err(|_| S3Error::Transport(format!("bad method {method}")))?,
                url,
            )
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
            .map_err(|error| S3Error::Transport(error.to_string()))?;
        let status = response.status();
        let body = response.bytes().await.unwrap_or_default();
        if status.is_success() {
            return Ok(body.to_vec());
        }
        Err(S3Error::Status {
            status: status.as_u16(),
            body: String::from_utf8_lossy(&body).chars().take(512).collect(),
        })
    }
}

/// First value of `<tag>…</tag>`, or `None`.
fn parse_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].to_owned())
}

/// The `<Contents>` entries of a `ListObjectsV2` response.
///
/// A hand-rolled reader rather than an XML crate: the response shape is fixed,
/// the fields are three, and the keys this binary lists are its own — they
/// contain no characters that would need entity decoding.
fn parse_list_objects(xml: &str) -> Vec<S3Object> {
    let mut objects = Vec::new();
    for chunk in xml.split("<Contents>").skip(1) {
        let Some(entry) = chunk.split("</Contents>").next() else {
            continue;
        };
        let Some(key) = parse_tag(entry, "Key") else {
            continue;
        };
        objects.push(S3Object {
            key,
            last_modified: parse_tag(entry, "LastModified")
                .and_then(|raw| DateTime::parse_from_rfc3339(&raw).ok())
                .map(|stamp| stamp.with_timezone(&Utc)),
            size: parse_tag(entry, "Size")
                .and_then(|raw| raw.parse::<u64>().ok())
                .unwrap_or(0),
        });
    }
    objects
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_objects_parses_keys_sizes_and_timestamps() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>wal/v1/segments/task-a/000000000007.seg</Key>
    <LastModified>2026-08-29T10:11:12.000Z</LastModified>
    <Size>8388608</Size>
  </Contents>
  <Contents>
    <Key>wal/v1/owners/task-a</Key>
    <LastModified>2026-08-29T10:12:00.000Z</LastModified>
    <Size>0</Size>
  </Contents>
</ListBucketResult>"#;
        let objects = parse_list_objects(xml);
        assert_eq!(objects.len(), 2);
        assert_eq!(objects[0].key, "wal/v1/segments/task-a/000000000007.seg");
        assert_eq!(objects[0].size, 8_388_608);
        assert_eq!(
            objects[0].last_modified.unwrap().to_rfc3339(),
            "2026-08-29T10:11:12+00:00"
        );
        assert_eq!(objects[1].size, 0);
    }

    #[test]
    fn list_objects_ignores_common_prefixes() {
        // A delimited listing carries <CommonPrefixes>, which has no <Key> and
        // must not be mistaken for an object.
        let xml = "<ListBucketResult><CommonPrefixes><Prefix>wal/v1/segments/task-a/</Prefix>\
                   </CommonPrefixes></ListBucketResult>";
        assert!(parse_list_objects(xml).is_empty());
    }

    #[test]
    fn signing_matches_the_aws_sigv4_get_vanilla_case() {
        // The canonical example from AWS's SigV4 test suite (get-vanilla), which
        // pins header sorting, the scope string and the key derivation together.
        let now = DateTime::parse_from_rfc3339("2015-08-30T12:36:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let headers = vec![
            ("host".to_owned(), "example.amazonaws.com".to_owned()),
            ("x-amz-date".to_owned(), amz_date(now)),
        ];
        let authorization = authorization_header(&SigningParams {
            method: "GET",
            canonical_uri: "/",
            canonical_query: "",
            headers: &headers,
            payload_sha256: &hex(&Sha256::digest(b"")),
            now,
            access_key_id: "AKIDEXAMPLE",
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            region: "us-east-1",
            service: "service",
        });
        assert_eq!(
            authorization,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, \
             SignedHeaders=host;x-amz-date, \
             Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
    }

    #[test]
    fn query_encoding_escapes_slashes() {
        assert_eq!(uri_encode_query("wal/v1/a b"), "wal%2Fv1%2Fa%20b");
        assert_eq!(uri_encode_path("wal/v1/a b"), "wal/v1/a%20b");
    }
}
