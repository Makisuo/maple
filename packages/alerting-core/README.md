# `@maple/alerting-core`

Host-neutral alert evaluation and incident-lifecycle semantics shared by Maple
deployment targets.

The core is deliberately free of database, telemetry warehouse, scheduler,
network, and wall-clock dependencies. A host supplies observations and durable
state, calls the pure decision functions, then applies the returned transition
and delivery intent through its own adapters.

Current hosted adapters live in `apps/api` and are scheduled by
`apps/alerting`. A Maple Local adapter can use the same core with chDB-backed
queries, Local durable state, an in-process scheduler, and its own outbound URL
policy without importing either hosted application.

This package covers scheduled aggregate alerts. Immediate per-occurrence events
use the separate ingest-time architecture described in
[`docs/signal-to-event-projection.md`](../../docs/signal-to-event-projection.md).
Both paths may ultimately publish through the same typed event outbox, but raw
signal matching does not poll chDB or impersonate an alert lifecycle.

The boundary is:

- query adapter -> `AlertObservation`;
- evaluation policy + observation -> `AlertEvaluation`;
- persistence snapshot + evaluation -> `AlertLifecyclePlan`;
- host persists the plan, projects its optional `eventType` into the common
  CloudEvents envelope, and sends that event through a delivery adapter;
- delivery adapters share idempotency-key and bounded retry policy helpers;
- host clock supplies `nowMs`; the core never reads global time.

Rule CRUD, storage schemas, scheduler claims, destination configuration, and
delivery transports remain host concerns. This keeps Local UI work optional:
the alert runtime can evaluate and deliver while no browser is open.

Hosted alert delivery rows are the existing durable outbox for this producer.
Their additive `event` payload contains the deterministic
`dev.maple.alert.lifecycle.{trigger,resolve,renotify,test}.v1` envelope; current
destinations continue to receive the legacy top-level payload fields during the
migration.
