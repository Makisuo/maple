# Ingest WAL durability

The ingest gateway (`apps/ingest`, Rust) acknowledges a request once the rows are committed to a
local write-ahead log, then exports them to Tinybird or ClickHouse in the background. That WAL is
the only copy of an accepted row until it reaches the warehouse, and it lives on Fargate ephemeral
storage, which is destroyed with the task.

This is how it stays durable.

## The log

One **lane** per `(shard, destination)` — see `lane_index` in `apps/ingest/src/telemetry.rs`. Lanes
are independent so a stalled ClickHouse export cannot back up the Tinybird lane sharing its shard.

Each lane is a directory of sealed segments:

```
$INGEST_QUEUE_DIR/shard-003-clickhouse/
  000000000041.seg     ← sealed, waiting to export
  000000000042.seg     ← sealed
  000000000043.seg     ← active; appends land here
  lane.cursor          ← "42 1048576": exported through segment 42, byte 1048576
```

Appends go to the active segment and `sync_data` before the request is acknowledged. At
`INGEST_WAL_SEGMENT_MAX_BYTES` (8 MiB) the segment is **sealed**: the file is closed and the next
one opened. Sealing is an `open` plus a directory fsync — there is no copy on the append path.

The exporter advances `lane.cursor` and unlinks every segment behind it. **Appends and exports take
different locks**, so an export can never stall a commit. That separation is the fix for the
`ingest.wal_commit` p95 that used to swing between 145ms and 998ms against a flat 3ms p50: the
previous layout was one file per lane, reclaimed by rewriting the unexported tail while holding the
append mutex.

Ordering rules that matter:

- The cursor is written **before** segments are unlinked. A crash in between costs a re-delete on
  the next boot; the other order strands a cursor pointing at bytes that are gone.
- Boot always opens a **fresh** segment, so "sealed" means "will never grow again" — which is what
  lets a sealed segment be shipped or deleted without coordinating with the appender.
- A lost or unparseable cursor replays the lane from its oldest surviving segment. Everything here
  is **at-least-once**: replaying an exported frame is a duplicate row, skipping one is silent loss.
- Backlog is `committed - exported` bytes per lane, not anything derived from file sizes, so it
  stays exact across rotation and deletion. The shutdown drain and scale-in protection read it.

## The durability tier

Sealed segments are also shipped to S3 (`apps/ingest/src/wal_store.rs`), so a task that dies without
draining does not take its backlog with it.

```
s3://<bucket>/wal/v1/
  owners/<owner>                              ← heartbeat, refreshed every 60s
  claims/<owner>                              ← conditional-PUT claim marker
  segments/<owner>/shard-003-clickhouse/000000000041.seg
```

An **owner** is one boot, identified by a fresh UUID — never a task ARN — so a sequence number can
never be reused across boots and a claim can never race a live writer for the same key.

**Shipping.** A sealed segment is announced to a shipper task (`SEGMENT_SHIPPER_WORKERS`, one lane
always handled by the same worker so its events stay ordered). The shipper skips any segment the
exporter has already passed, which in a healthy pipeline is nearly all of them — this is why the
tier costs single-digit dollars a month at ~2B traces: the bucket holds the current backlog, not the
traffic. When a segment exports, its object is deleted.

**Claiming.** On boot, a task lists `owners/`, takes every owner whose heartbeat is older than
`INGEST_WAL_S3_ORPHAN_AFTER_SECS` (10 min), and claims it with a conditional `PUT … If-None-Match: *`.
S3 answers 412 when the key exists, so exactly one task wins without a lock service. The winner
downloads that owner's segments, re-commits their frames to its own lanes, **re-ships them under its
own owner id, and only then** deletes the source objects — so the frames are never only on one
task's disk. A claim older than 30 minutes is taken over unconditionally, because the task that
wrote it evidently died before finishing.

**Shutdown.** After `INGEST_SHUTDOWN_DRAIN_SECS`, whatever did not export is sealed and shipped, and
the owner heartbeat is deleted — so the next task claims it immediately instead of waiting out the
staleness window.

Credentials come from the ECS task role (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, refreshed 5
minutes before expiry) unless `INGEST_WAL_S3_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` are set. The VPC
has an S3 gateway endpoint and no NAT, so this traffic is free.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `INGEST_QUEUE_MAX_BYTES` | — | Total WAL budget; divided evenly across lanes |
| `INGEST_WAL_SHARDS` | `max(cpus × 2, 2)` | Shards, not lanes — lanes are `shards × destinations` |
| `INGEST_WAL_SEGMENT_MAX_BYTES` | 8 MiB | Seal threshold, and so the shipped object size |
| `INGEST_WAL_S3_BUCKET` | unset | Unset keeps the WAL local-only (self-hosted, local dev) |
| `INGEST_WAL_S3_REGION` | `$AWS_REGION` | Required with a bucket |
| `INGEST_WAL_S3_ENDPOINT` | `https://s3.<region>.amazonaws.com` | For an S3-compatible target |
| `INGEST_WAL_S3_PREFIX` | `wal` | Key prefix inside the bucket |
| `INGEST_WAL_S3_ORPHAN_AFTER_SECS` | 600 | How stale a heartbeat must be to be claimable |
| `INGEST_WAL_S3_HEARTBEAT_SECS` | 60 | Owner heartbeat interval |
| `INGEST_WAL_S3_TIMEOUT_MS` | 10000 | Per-request timeout |
| `INGEST_SHUTDOWN_DRAIN_SECS` | 90 | Must stay inside the task's 120s `stopTimeout` |

The bucket, its lifecycle rule (7-day expiry as a backstop for deletes that were lost) and the
task-role policy are in `apps/ingest/alchemy.run.ts`.

## Metrics

| Metric | Read it for |
| --- | --- |
| `ingest_wal_shard_bytes` | Bytes a lane holds on disk, exported prefix included |
| `ingest_wal_shard_full_total` | Appends rejected because a lane hit its cap — customer-visible 429s |
| `ingest_wal_segments_sealed_total` | Segment rotation rate |
| `ingest_wal_reclaimed_bytes_total` | Bytes freed by deleting exported segments |
| `ingest_wal_shipped_bytes_total` | Bytes that reached the bucket |
| `ingest_wal_ship_outcomes_total` | `outcome=exported_first` (healthy), `queue_full`, `failed` |
| `ingest_wal_frames_recovered_total` | Frames claimed from a dead task — non-zero means a task died dirty |
| `ingest_wal_commit_bytes` | Per-append size; the `ingest.wal_commit` span carries the latency |

`queue_full` means the object store cannot keep up with segment rotation, and those segments stay
local-only. Sustained non-zero is the signal that the durability tier is not actually covering the
backlog.

## What is deliberately not here

A real stream (Kinesis, MSK, S2) buys ordered replay for multiple independent consumers. There is
one consumer, per-GB pricing hurts at trace volume, and MSK has a ~$500/month floor. Revisit only
when a second consumer or replay-as-a-feature is a requirement.
