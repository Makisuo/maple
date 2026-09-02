/**
 * 0025 — `audit_log`: the org-wide audit trail, moved out of Postgres.
 *
 * Written only by the API worker through the managed Tinybird pipeline and read
 * only by the admin-gated `GET /v2/audit_log`. It ships in the migration set so
 * self-hosted deployments (where the "managed" pipeline IS this ClickHouse) have
 * the table; a BYO-ClickHouse org never reads or writes it — reads are pinned to
 * the managed route (`INGEST_PINNED_TABLES`).
 *
 * `requiredForIngest: false`: the ingest gateway writes nothing here, so the
 * table's presence must not gate an org's ingest readiness.
 *
 * Retention is six years (HIPAA §164.316(b)(2)); `''` stands in for absent
 * values throughout — see the datasource definition for the column contract.
 */
export const migration_0025_audit_log = {
	version: 25,
	description: "Create audit_log, the org-wide audit trail (actions, denials, and telemetry reads).",
	requiredForIngest: false,
	statements: [
		`CREATE TABLE IF NOT EXISTS audit_log (
  OrgId LowCardinality(String),
  Id String,
  OccurredAt DateTime64(3),
  RecordedAt DateTime64(3),
  ActorType LowCardinality(String),
  UserId String,
  ApiKeyId String,
  ActorId String,
  ActorLabel String,
  AffectedUserId String,
  Source LowCardinality(String),
  Action LowCardinality(String),
  Outcome LowCardinality(String),
  DenialReason String,
  ResourceType LowCardinality(String),
  ResourceId String,
  ChangedFields Array(String),
  Changes String,
  Metadata String,
  RequestId String,
  OriginIp String,
  OriginCountry LowCardinality(String)
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(OccurredAt)
ORDER BY (OrgId, OccurredAt, Id)
TTL toDate(OccurredAt) + INTERVAL 2190 DAY`,
	],
} as const
