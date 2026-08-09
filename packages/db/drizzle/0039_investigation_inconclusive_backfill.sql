-- Reclassify historical "the validator promoted nothing" runs from `failed` to
-- `inconclusive`.
--
-- Hand-written: drizzle-kit generates no DDL for this. `status` is a `text`
-- column, not a pg enum, so widening the TypeScript union needed no ALTER TYPE
-- and this file is pure data movement.
--
-- The `error LIKE` predicate is what makes it safe. Three writers in
-- InvestigationFanoutWorkflow.run.ts produce `failed` + `rejected_all`:
-- `collapsed_no_diagnosis`, `validation_failed`, and `validation_inconclusive`.
-- Only the last is the outcome being reclassified, and only it writes that
-- prefix — the other two are genuine failures and must keep reading as such.
--
-- Idempotent: a second run clears `error`, so it matches zero rows.
--
-- Rollout order matters, because production migrations are applied by hand and
-- not by the deploy. Ship the API and web bundles FIRST, then run this. A row
-- with `status = 'inconclusive'` in front of a bundle whose STATUS record has no
-- key for it throws on `STATUS[status].tone` and blanks the investigations hub.
-- `severity` and `diagnosed_at` are cleared for the same reasons
-- `applyInconclusiveWrites` never sets them: severity here would be an AI
-- assessment of a cause nobody established, and `diagnosed_at` is what "time to
-- diagnosis" reads, so a timestamp claims a diagnosis happened. The old
-- inconclusive path left both untouched, so a run that was diagnosed and then
-- restarted into an inconclusive result kept stale values in both — backfilling
-- the status alone would leave those rows rendering differently from identical
-- runs produced after this change.
UPDATE "investigations"
SET "status" = 'inconclusive',
    "error" = NULL,
    "severity" = NULL,
    "diagnosed_at" = NULL
WHERE "status" = 'failed'
  AND "fanout_state" = 'rejected_all'
  AND "error" LIKE 'validation_inconclusive:%';
