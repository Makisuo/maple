# `@maple/eventing-core`

Host-neutral signal-to-event contracts and deterministic runtime semantics.

The package owns typed signal values, bounded selectors, pure projector
registration, canonical event identity, and an immutable compiled projection
registry. It has no database, network, scheduler, or wall-clock dependency. A
host authenticates and normalizes source input, supplies durable projection and
outbox adapters, and decides when compiled registries become active.

See [`docs/signal-to-event-projection.md`](../../docs/signal-to-event-projection.md)
for the architecture and acceptance contract.

The versioned interoperability artifacts are generated under `schemas/`, with
valid comparison and identity vectors in `fixtures/v1.json`. Run `bun test` to
verify generated-schema drift, hostile selector bounds, typed comparison
semantics, deterministic event IDs, and projector isolation.

The first host adapter is Maple Local in `apps/cli/src/server/eventing`. It uses
an authenticated configuration endpoint, a SQLite projection/outbox store, and
the pre-chDB OTLP seam. The package itself deliberately contains none of those
host decisions.
