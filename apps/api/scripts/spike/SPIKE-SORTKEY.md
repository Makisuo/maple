# Sort-key / `read_in_order` spike (ClickStack Phase 3)

**Question:** ClickStack changed their primary key to `(toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp)`, activating `optimize_read_in_order` for `ORDER BY Timestamp DESC LIMIT N`. Maple's `traces`/`logs` sort keys are `(OrgId, ServiceName, …)`, so the list queries use a **two-stage cutoff workaround** (`logsListQuery` / `tracesListQuery`). Would a time-bucketed key let us **delete that workaround** without regressing service-scoped reads, attribute-bloom pruning, or compression?

This is a **measure-then-decide** spike. It ships **no production change** by itself — it builds throwaway shadow tables, backfills one busy org, and A/Bs them with the committed benchmark suite.

## Prerequisites

- A **dedicated ClickHouse** (docker `clickhouse-server`, or a staging cluster) reachable via `CLICKHOUSE_URL`. **Not** a Tinybird branch — branches share prod compute, so wall-time is noisy; lean on `read rows` / `read bytes`, which are deterministic.
- The base `traces` / `logs` tables populated with real data for the target org (restore a partition, or replicate from prod into the dedicated CH).
- One **busy org id** and its **7-day window**.

## Candidate sort keys

Defined in [`sortkey-variants.ts`](sortkey-variants.ts). OrgId stays first in every candidate (tenant scoping is enforced on every query).

| Shadow | ORDER BY | Trade-off |
| --- | --- | --- |
| `traces_t1` / `logs_l1` | current key (rebuilt) | **control** — compare against a like-aged table, never the aged prod one |
| `traces_t2` / `logs_l2` | `(OrgId, toStartOfFiveMinutes(ts), ServiceName, ts)` | time bucket **+** service locality |
| `traces_t3` / `logs_l3` | `(OrgId, ts)` | pure time-first — the read_in_order upper bound |

## Procedure

```bash
export CLICKHOUSE_URL=http://localhost:8123     # dedicated CH
ORG=org_xxxxx ; END="2026-01-08 00:00:00" ; DAYS=7
CH() { curl -sS "$CLICKHOUSE_URL" --data-binary @- ; }   # or clickhouse-client -mn <

# 1. Create shadow tables (CREATE ... AS copies columns + skip indexes).
bun run scripts/spike/emit-spike-sql.ts --tables all --mode setup | CH

# 2. Backfill 7 days of one org, one INSERT per day per table.
bun run scripts/spike/emit-spike-sql.ts --org $ORG --days $DAYS --end "$END" --mode backfill | CH

# 3. Confirm read_in_order actually engaged for each candidate (EXPLAIN).
bun run scripts/spike/emit-spike-sql.ts --org $ORG --mode probe | CH
#    Look for ReadFromMergeTree WITHOUT a separate Sorting step on t2/t3/l2/l3
#    (and its presence on t1/l1). EXPLAIN PIPELINE via `bench inspect` also shows it.

# 4. A/B the benchmark suite: control vs each candidate. Same org + window.
bun bench:suite --org $ORG --since ${DAYS}d --trace-id <real> --service <real> \
  --table-map "traces=traces_t1,logs=logs_l1" --out .bench/ctrl.json
bun bench:suite --org $ORG --since ${DAYS}d --trace-id <real> --service <real> \
  --table-map "traces=traces_t2,logs=logs_l2" --out .bench/t2.json
bun bench:run .bench/ctrl.json --out .bench/resCtrl.json
bun bench:run .bench/t2.json   --out .bench/resT2.json
bun bench:compare .bench/resCtrl.json .bench/resT2.json

# 5. (Repeat 4 for t3/l3.) Tear down.
bun run scripts/spike/emit-spike-sql.ts --tables all --mode drop | CH
```

To test whether the **two-stage workaround can be deleted**, also hand-run a single-stage `ORDER BY <ts> DESC LIMIT N` on the candidate table and compare its `read rows` / wall-time to the two-stage form on the control — that difference is the whole point.

## Decision criteria (promote `t2`/`l2` only if ALL hold)

- **List win:** list-group p50 −40% **or** `read_rows` −80% vs control, **and** the single-stage form ≤ the two-stage-on-control form.
- **Service-scoped raw reads** (`service_span_search`, `top_operations`, MV-disqualified timeseries) regress ≤ **+25% p50** / **+50% read_rows**.
- **Attribute-bloom pruning** (`traces_list_attr_equals`) regresses ≤ **+25% read_rows** (the item/attr blooms must still skip).
- **Compression:** compressed size (`system.parts`) ≤ **+15%**.
- **MV-backed cases** (facets, autocomplete) stay flat — they don't read the raw tables, so they're a sanity check that the harness is measuring what we think.

If `t3`/`l3` (pure time-first) wins big but `t2`/`l2` doesn't, the service-locality cost is real and the decision is a genuine trade-off — capture the numbers and escalate rather than auto-promoting.

## If it's a go (separate production PR)

- Tinybird: change `sortingKey` in `datasources.ts` (needs-verification: tb deploy semantics for a key change = full table rewrite).
- BYO: a `000X` migration that rebuilds + `RENAME`s (immutable sort key, like migration 0004's aggregate rebuild).
- Delete the two-stage cutoff in `logsListQuery` / `tracesListQuery` if the single-stage form proved competitive.
- `logs.TimestampTime` elimination is a **further** scoped change (partition key + Rust insert mappings + MV + `rawLogsTimeRange`); `logs_l3` measures whether it's worth it.
