# Cloudflare Workers vs Self-Hosted Ingest: Cost Analysis

## Current Architecture

The Maple ingest pipeline is a three-service chain:

```
Client SDKs ──OTLP/HTTP──▶ Ingest Gateway (Rust, port 3474)
                                │
                                ├──▶ OTel Collector (port 4318) ──▶ Tinybird
                                └──▶ Autumn Billing (async, usage tracking)
```

**Ingest Gateway** (Rust/Axum) handles:
- Auth: HMAC-SHA256 key lookup against Turso/SQLite (cached 60s, LRU 1,000 entries)
- Enrichment: decode protobuf/JSON, inject `maple_org_id` + metadata into OTLP resource attributes, re-encode
- Compression: gzip decompress → enrich → gzip re-compress
- Forward: HTTP POST enriched payload to OTel Collector
- Billing: async usage tracking to Autumn

**OTel Collector** handles:
- Batching (5,000 items / 1s timeout)
- Memory limiting (512 MiB)
- Persistent queue (file-backed, 10,000 items)
- Export to Tinybird with retry

The gateway does **no batching itself** — every inbound request is enriched and forwarded 1:1.

---

## What Would Move to Cloudflare

Only the **Ingest Gateway** is a candidate. The OTel Collector cannot run on Workers (it's a stateful, long-running Go process with file-backed queues and a persistent memory buffer). You'd need to either:

- **Option A**: Replace both gateway + collector — Workers receives OTLP, enriches, batches, and exports directly to Tinybird
- **Option B**: Replace only the gateway — Workers enriches and forwards to a self-hosted OTel Collector

Option B is simpler but still requires a self-hosted collector, so the savings are partial. Option A is more ambitious and requires reimplementing batching/retry/queue logic in Workers.

---

## Cost Comparison

### Scenario Definitions

| Scenario | Requests/month | Avg payload (compressed) | Avg CPU work/req |
|----------|---------------|-------------------------|-----------------|
| Low      | 1M            | ~5 KB                   | ~3-5 ms         |
| Medium   | 10M           | ~5 KB                   | ~3-5 ms         |
| High     | 100M          | ~5 KB                   | ~3-5 ms         |

CPU estimate rationale: each request does HMAC-SHA256, protobuf decode, attribute mutation, protobuf re-encode, gzip decompress/recompress. In Rust this is fast (~1-3 ms). In JavaScript/WASM on Workers, expect 3-5 ms due to protobuf parsing overhead and lack of native gzip.

### Cloudflare Workers (Standard Plan)

Base: **$5/month** (includes 10M requests + 30M CPU-ms)

| Scenario | Requests | Req Cost | CPU-ms Used | CPU Cost | Total |
|----------|----------|----------|-------------|----------|-------|
| 1M       | 1M       | $0       | 5M          | $0       | **~$5/mo** |
| 10M      | 10M      | $0       | 50M         | $0.40    | **~$5.40/mo** |
| 100M     | 100M     | $27.00   | 500M        | $9.40    | **~$41.40/mo** |

Egress: **$0** (Cloudflare never charges egress on Workers).

If you need batching before Tinybird (Option A), add Cloudflare Queues:

| Scenario | Queue Ops (3 per msg) | Queue Cost | Total w/ Queues |
|----------|----------------------|------------|-----------------|
| 1M       | 3M                   | $0.80      | **~$5.80/mo** |
| 10M      | 30M                  | $11.60     | **~$17.00/mo** |
| 100M     | 300M                 | $119.60    | **~$161.00/mo** |

### Self-Hosted on Railway

Railway pricing: **$5/mo base** + usage-based compute ($0.000463/min vCPU, $0.000231/min per 512 MB RAM) + egress ($0.10/GB).

A lightweight Rust service running 24/7:

| Resource | Allocation | Monthly Cost |
|----------|-----------|-------------|
| Base plan | — | $5.00 |
| vCPU (0.5 vCPU, 24/7) | 0.5 vCPU × 43,200 min | ~$10.00 |
| RAM (512 MB, 24/7) | 512 MB × 43,200 min | ~$10.00 |
| Egress (forwarding to collector) | Internal (same project) | $0 (internal) |

**Ingest Gateway alone: ~$20-25/mo** regardless of traffic volume (it's always-on compute).

But you also need the **OTel Collector** running alongside:

| Resource | Allocation | Monthly Cost |
|----------|-----------|-------------|
| vCPU (0.5 vCPU, 24/7) | 0.5 vCPU × 43,200 min | ~$10.00 |
| RAM (1 GB for batching/queue) | 1 GB × 43,200 min | ~$20.00 |
| Volume (file-backed queue) | 1 GB | ~$0.25 |

**Total Railway (gateway + collector): ~$55-65/mo** at any traffic level.

### Alternative Self-Hosted (Hetzner/Fly.io)

| Platform | Spec | Monthly Cost |
|----------|------|-------------|
| Hetzner CX22 | 2 vCPU, 4 GB RAM | ~$4.50/mo |
| Fly.io shared-cpu-1x | 1 vCPU, 256 MB | ~$3-5/mo |
| DigitalOcean Basic | 1 vCPU, 1 GB | ~$6/mo |

Running both gateway + collector on a single cheap VPS: **~$5-10/mo** (but no auto-scaling, no HA, manual ops).

---

## Side-by-Side Summary

| | Cloudflare Workers (Option B: gateway only) | Cloudflare Workers (Option A: gateway + batching) | Railway (current) | Cheap VPS |
|---|---|---|---|---|
| **1M req/mo** | ~$5 | ~$6 | ~$55-65 | ~$5-10 |
| **10M req/mo** | ~$5 | ~$17 | ~$55-65 | ~$5-10 |
| **100M req/mo** | ~$41 | ~$161 | ~$55-65 | ~$10-20 |
| **Scales to zero** | Yes | Yes | No | No |
| **Egress cost** | $0 | $0 | $0 (internal) | Varies |
| **Global edge** | Yes (300+ PoPs) | Yes | Single region | Single region |
| **Ops burden** | Very low | Low | Medium | High |

---

## Key Trade-offs

### Cloudflare Advantages

1. **Scale-to-zero**: At low traffic, you pay almost nothing. Railway charges ~$55/mo even with zero requests.
2. **No egress fees**: OTLP payloads forwarded to Tinybird are free. On other platforms, outbound data transfer adds up.
3. **Global edge**: Requests are handled at the nearest Cloudflare PoP, reducing latency for geographically distributed SDKs.
4. **CPU billing only**: Wall-clock time waiting on Tinybird/Turso responses doesn't count. The gateway is I/O-heavy (forward to collector, query Turso for key lookup), so this billing model is favorable.
5. **No container management**: No Docker builds, no Rust compilation step, no memory tuning.

### Cloudflare Concerns

1. **128 MB memory limit**: Each Worker isolate is capped at 128 MB. The current gateway accepts payloads up to 20 MB and does decompress → parse → enrich → re-encode in memory. Large payloads with many spans could approach this limit.
2. **No OTel Collector on Workers**: The collector is a stateful Go binary. Workers can't run it. You'd need to either keep a self-hosted collector (partial savings) or reimplement batching/queuing in Workers + Queues (significant engineering effort).
3. **Protobuf in JS/WASM**: The current gateway uses Rust's `prost` for protobuf and `flate2` for gzip. On Workers, you'd need `protobufjs` or a WASM-compiled codec. This may be slower and increase CPU-ms billing.
4. **Database connectivity**: The gateway queries Turso (libSQL) for key lookups. Workers supports Turso via HTTP, but connection pooling and latency characteristics differ from a persistent Rust process.
5. **No persistent queue**: The OTel Collector has file-backed persistent queuing. If Tinybird is down, data is buffered to disk. Workers has no durable local storage — you'd need Queues or Durable Objects for reliability, adding cost and complexity.
6. **Queues cost at scale**: At 100M req/mo, Queues alone costs ~$120/mo. At that volume, a fixed-cost VPS or Railway instance is cheaper.

### Break-Even Analysis

- **vs Railway**: Cloudflare is cheaper at every volume until ~150M+ req/mo (if using Queues for batching). Without Queues (Option B, keeping a self-hosted collector), Workers is cheaper at every volume since you still save on the gateway compute.
- **vs cheap VPS**: A $5 Hetzner box is hard to beat on raw cost at high volume. But you lose auto-scaling, global distribution, and operational simplicity.

---

## Recommendation

**At current/moderate scale (< 50M req/mo): Cloudflare Workers is likely cheaper and operationally simpler**, especially if you keep a self-hosted OTel Collector (Option B). The gateway is a stateless, I/O-heavy proxy — the ideal Workers workload.

**At high scale (100M+ req/mo): Self-hosted becomes more cost-effective** due to fixed compute costs not scaling with requests.

**Biggest risk**: Reimplementing the protobuf enrichment pipeline in JavaScript/WASM. The current Rust implementation is clean (~1,000 lines) and fast. A Workers port needs careful benchmarking to ensure CPU-ms stays under ~5 ms per request, otherwise the cost advantage erodes.

**Pragmatic path**: Start with Option B — port only the gateway to Workers, keep the OTel Collector self-hosted. This gives you scale-to-zero and global edge with minimal engineering risk. Evaluate Option A (full replacement) later if collector hosting costs become a concern.
