# ClickHouse Architecture Advisor

Agent skill providing workload-aware architecture guidance for ClickHouse.

This skill is intended to complement `clickhouse-best-practices`, not replace it.

## What it adds

The existing best-practices skill is rule-first and documentation-first. This skill adds:

- workload classification
- decision frameworks
- architecture tradeoff guidance
- broader system design suggestions
- explicit separation of doc-backed guidance from field heuristics

## Recommendation categories

Every recommendation must be labeled as exactly one of:

- `official` — directly backed by official ClickHouse documentation
- `derived` — reasoned from official documentation and core ClickHouse behavior
- `field` — practice-based guidance from field experience, explicitly flagged as non-authoritative

## When this skill should activate

Use this skill when the user is:
- designing a real-time architecture
- choosing between ingestion patterns
- deciding whether to use joins, dictionaries, denormalization, or MVs
- planning for late-arriving data or upserts
- reasoning about time-series modeling
- building a POC or workshop design
- asking for “what should the architecture look like?”

## Relationship to `clickhouse-best-practices`

Use `clickhouse-best-practices` for:
- concrete schema and query rule checks
- low-level design validation
- docs-backed enforcement

Use this skill for:
- when / why / how decisioning
- architecture shape
- system-level tradeoffs
- converting best practices into a target design

## Included decision frameworks

- ingestion strategy for throughput and latency
- time-series partitioning and retention design
- enrichment path selection: JOIN vs dictionary vs denormalization
- late-arriving data and mutable-state patterns
- real-time pre-aggregation with incremental MVs

## Output contract

Responses should typically include:
1. workload summary
2. key decisions
3. recommendations with provenance labels
4. suggested target architecture
5. example DDL and query patterns
6. caveats and validation steps
