//! The WAL's durability tier: sealed segments shipped to S3, and the claiming
//! protocol that lets a booting task recover a dead one's.
//!
//! The local WAL lives on Fargate ephemeral storage, which is destroyed with the
//! task. A drain on SIGTERM covers a graceful stop; this covers everything else
//! — a crash, a spot reclaim, an AZ event — by keeping every sealed, unexported
//! segment in an object store too.
//!
//! Cost is small because segments are transient: a segment is deleted from the
//! bucket as soon as its frames export, so the bucket holds roughly the current
//! backlog rather than the traffic. At ~8 MiB per object and a healthy pipeline,
//! most segments are exported before their upload is even attempted.
//!
//! Ownership is per boot, not per task ARN: an owner id is a fresh UUID, so a
//! sequence number is never reused across boots and a claim can never race a
//! live writer for the same key.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};

use crate::aws::{CredentialsProvider, S3Client, S3Error, S3Object};
use crate::telemetry::HttpClient;

/// Object-key scheme version. A future layout change lands under `v2/` while
/// `v1/` keys stay decodable for as long as a task could still be holding them.
const KEY_SCHEME: &str = "v1";

/// Pages of a listing we will walk. A boot lists its own prefix and each dead
/// owner's; 1000 keys a page makes this 100k segments, far past any real
/// backlog, and bounds a pathological prefix instead of hanging startup.
const MAX_LIST_PAGES: usize = 100;

/// How stale an owner's heartbeat must be before its segments are claimable.
///
/// Well past the heartbeat interval: claiming a live task's segments is not
/// unsafe (the frames replay at-least-once, which every destination tolerates)
/// but it is wasted work and duplicated rows, so the bar is deliberately high.
pub const DEFAULT_ORPHAN_AFTER: Duration = Duration::from_secs(10 * 60);

/// How often a live task refreshes its heartbeat object.
pub const DEFAULT_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);

/// How long a claim marker holds an owner before another task may take it over.
///
/// A claimer that dies mid-recovery would otherwise strand those segments
/// forever. Taking over an expired claim can replay frames the first claimer had
/// already exported — at-least-once again, and the alternative is loss.
const CLAIM_LEASE: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug)]
pub struct WalStoreConfig {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    /// Key prefix inside the bucket, without a trailing slash.
    pub prefix: String,
    pub timeout: Duration,
    pub orphan_after: Duration,
    pub heartbeat_interval: Duration,
}

/// A segment recovered from the object store, with the key it came from so the
/// caller can delete it once its frames are durable locally again.
#[derive(Debug)]
pub struct RecoveredSegment {
    pub key: String,
    /// `shard-NNN-<destination>`, as written by the task that owned it.
    pub lane_key: String,
    pub bytes: Vec<u8>,
}

pub struct WalSegmentStore {
    s3: S3Client,
    prefix: String,
    /// This boot's identity. Fresh per process, so no other task can be writing
    /// under it and its segments are unambiguously ours to delete.
    owner: String,
    orphan_after: Duration,
}

impl std::fmt::Debug for WalSegmentStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WalSegmentStore")
            .field("bucket", &self.s3.bucket())
            .field("prefix", &self.prefix)
            .field("owner", &self.owner)
            .finish_non_exhaustive()
    }
}

impl WalSegmentStore {
    pub fn new(
        client: impl Into<HttpClient>,
        cfg: &WalStoreConfig,
        credentials: Arc<CredentialsProvider>,
    ) -> Self {
        Self {
            s3: S3Client::new(
                client,
                &cfg.endpoint,
                cfg.bucket.clone(),
                cfg.region.clone(),
                credentials,
                cfg.timeout,
            ),
            prefix: cfg.prefix.trim_end_matches('/').to_owned(),
            owner: uuid::Uuid::new_v4().to_string(),
            orphan_after: cfg.orphan_after,
        }
    }

    pub fn owner(&self) -> &str {
        &self.owner
    }

    fn segment_key(&self, owner: &str, lane_key: &str, seq: u64) -> String {
        format!(
            "{}/{KEY_SCHEME}/segments/{owner}/{lane_key}/{seq:012}.seg",
            self.prefix
        )
    }

    fn owner_key(&self, owner: &str) -> String {
        format!("{}/{KEY_SCHEME}/owners/{owner}", self.prefix)
    }

    fn claim_key(&self, owner: &str) -> String {
        format!("{}/{KEY_SCHEME}/claims/{owner}", self.prefix)
    }

    /// Ship one sealed segment. Overwrites unconditionally: the only writer for
    /// this key is this process, and a retry of a partial PUT must win.
    pub async fn put_segment(
        &self,
        lane_key: &str,
        seq: u64,
        bytes: Vec<u8>,
    ) -> Result<(), S3Error> {
        let key = self.segment_key(&self.owner, lane_key, seq);
        self.s3.put(&key, bytes, false).await
    }

    /// Drop a segment whose frames have exported. Missing is success — the
    /// upload may simply never have happened.
    pub async fn delete_segment(&self, lane_key: &str, seq: u64) -> Result<(), S3Error> {
        let key = self.segment_key(&self.owner, lane_key, seq);
        self.s3.delete(&key).await
    }

    /// Refresh this owner's heartbeat. Liveness is the object's `LastModified`,
    /// so the body carries nothing.
    pub async fn heartbeat(&self) -> Result<(), S3Error> {
        self.s3
            .put(&self.owner_key(&self.owner), Vec::new(), false)
            .await
    }

    /// Remove this owner's heartbeat, so a successor does not have to wait out
    /// `orphan_after` before claiming whatever we failed to drain.
    pub async fn retire(&self) -> Result<(), S3Error> {
        self.s3.delete(&self.owner_key(&self.owner)).await
    }

    /// Owners whose heartbeat has gone stale, newest-stale first.
    pub async fn stale_owners(&self, now: DateTime<Utc>) -> Result<Vec<String>, S3Error> {
        let prefix = format!("{}/{KEY_SCHEME}/owners/", self.prefix);
        let objects = self.s3.list(&prefix, MAX_LIST_PAGES).await?;
        Ok(objects
            .into_iter()
            .filter(|object| !object.key.ends_with(&self.owner))
            .filter(|object| is_older_than(object, now, self.orphan_after))
            .filter_map(|object| {
                object
                    .key
                    .rsplit('/')
                    .next()
                    .filter(|owner| !owner.is_empty())
                    .map(str::to_owned)
            })
            .collect())
    }

    /// Take ownership of a dead task's segments, or report that someone else
    /// already has.
    ///
    /// The claim is a conditional PUT: S3 answers 412 when the key exists, which
    /// makes exactly one booting task the winner without a lock service. A claim
    /// older than `CLAIM_LEASE` is taken over unconditionally, because the task
    /// that wrote it evidently died before finishing.
    pub async fn claim(&self, owner: &str, now: DateTime<Utc>) -> Result<bool, S3Error> {
        let key = self.claim_key(owner);
        match self
            .s3
            .put(&key, self.owner.as_bytes().to_vec(), true)
            .await
        {
            Ok(()) => Ok(true),
            Err(error) if error.status() == Some(412) => {
                let existing = self.s3.list(&key, 1).await?;
                let expired = existing
                    .first()
                    .is_some_and(|object| is_older_than(object, now, CLAIM_LEASE));
                if !expired {
                    return Ok(false);
                }
                self.s3
                    .put(&key, self.owner.as_bytes().to_vec(), false)
                    .await?;
                Ok(true)
            }
            Err(error) => Err(error),
        }
    }

    /// Every segment a claimed owner left behind, oldest first, with its bytes.
    ///
    /// Keys sort by `(lane, sequence)` and sequences are zero-padded, so the
    /// listing order is the order the frames were written.
    pub async fn take_segments(&self, owner: &str) -> Result<Vec<RecoveredSegment>, S3Error> {
        let prefix = format!("{}/{KEY_SCHEME}/segments/{owner}/", self.prefix);
        let mut objects = self.s3.list(&prefix, MAX_LIST_PAGES).await?;
        objects.sort_by(|a, b| a.key.cmp(&b.key));
        let mut segments = Vec::with_capacity(objects.len());
        for object in objects {
            let Some(lane_key) = lane_key_of(&object.key) else {
                continue;
            };
            let bytes = self.s3.get(&object.key).await?;
            segments.push(RecoveredSegment {
                key: object.key,
                lane_key,
                bytes,
            });
        }
        Ok(segments)
    }

    /// Finish a claim: drop the recovered object and, once every segment is
    /// gone, the owner's heartbeat and claim marker.
    pub async fn release_key(&self, key: &str) -> Result<(), S3Error> {
        self.s3.delete(key).await
    }

    pub async fn release_owner(&self, owner: &str) -> Result<(), S3Error> {
        self.s3.delete(&self.owner_key(owner)).await?;
        self.s3.delete(&self.claim_key(owner)).await
    }
}

fn is_older_than(object: &S3Object, now: DateTime<Utc>, age: Duration) -> bool {
    let Some(modified) = object.last_modified else {
        // No timestamp is not evidence of life; treat it as stale so a listing
        // this parser did not understand cannot strand segments forever.
        return true;
    };
    (now - modified)
        .to_std()
        .is_ok_and(|elapsed| elapsed >= age)
}

/// `…/segments/<owner>/<lane_key>/<seq>.seg` → `<lane_key>`.
fn lane_key_of(key: &str) -> Option<String> {
    let mut parts = key.rsplit('/');
    parts.next()?; // the segment file
    parts.next().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(key: &str, minutes_ago: i64) -> S3Object {
        S3Object {
            key: key.to_owned(),
            last_modified: Some(Utc::now() - chrono::Duration::minutes(minutes_ago)),
            size: 0,
        }
    }

    #[test]
    fn lane_key_is_the_directory_above_the_segment() {
        assert_eq!(
            lane_key_of("wal/v1/segments/owner-a/shard-003-clickhouse/000000000012.seg").as_deref(),
            Some("shard-003-clickhouse")
        );
        assert_eq!(lane_key_of("nodirectory.seg").as_deref(), None);
    }

    #[test]
    fn staleness_is_measured_against_the_heartbeat() {
        let now = Utc::now();
        assert!(is_older_than(
            &object("owners/a", 30),
            now,
            DEFAULT_ORPHAN_AFTER
        ));
        assert!(!is_older_than(
            &object("owners/b", 1),
            now,
            DEFAULT_ORPHAN_AFTER
        ));
    }

    #[test]
    fn a_listing_without_a_timestamp_reads_as_stale() {
        // Otherwise an unparsed LastModified would strand the segments under it
        // for good: nobody would ever claim them.
        let unparsed = S3Object {
            key: "owners/c".to_owned(),
            last_modified: None,
            size: 0,
        };
        assert!(is_older_than(&unparsed, Utc::now(), DEFAULT_ORPHAN_AFTER));
    }
}
