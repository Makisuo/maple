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

The boundary is:

- query adapter -> `AlertObservation`;
- evaluation policy + observation -> `AlertEvaluation`;
- persistence snapshot + evaluation -> `AlertLifecyclePlan`;
- host persists the plan and sends its optional `eventType` through a delivery
  adapter;
- delivery adapters share idempotency-key and bounded retry policy helpers;
- host clock supplies `nowMs`; the core never reads global time.

Rule CRUD, storage schemas, scheduler claims, destination configuration, and
delivery transports remain host concerns. This keeps Local UI work optional:
the alert runtime can evaluate and deliver while no browser is open.
