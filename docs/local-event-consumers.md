# Maple Local event consumer protocol

Status: version 1 durable downstream-consumer boundary for the Maple Local event outbox.

This protocol lets a local consumer deliver ready Maple CloudEvents without destructive reads or a
second delivery database. It is intentionally transport-neutral: Maple does not select a downstream
transport, store downstream credentials, or choose delivery destinations.

## Credentials

Maple creates two independent 32-byte hexadecimal credentials beside the configured data directory:

- `<dataDir>.maintenance-token` administers projection and consumer configuration.
- `<dataDir>.event-consumer-token` permits only claim and acknowledgement requests.

Both files must be real regular files. The consumer token is sent in
`x-maple-event-consumer-token`; it does not grant access to projection configuration, outbox
inspection, checkpoints, or retention controls. The existing maintenance token is sent in
`x-maple-maintenance-token` and cannot be substituted for the consumer token.

## Consumer administration

Consumer IDs match `^[a-z][a-z0-9._-]{0,63}$` and are unique. Disabled IDs remain reserved so an
operator cannot accidentally replace one consumer's durable position with an unrelated process.

Register a consumer with the maintenance credential:

```http
POST /local/eventing/consumers
Content-Type: application/json
X-Maple-Maintenance-Token: <maintenance token>

{"consumerId":"automation","startAt":"beginning"}
```

`startAt` is exact:

- `beginning` starts immediately before the earliest ready event still retained for the tenant.
- `latest` atomically skips every ready event visible at registration and receives later events.

Successful registration returns `201` and the consumer record. Reusing any existing or disabled ID
returns `409`. `GET /local/eventing/consumers` lists records under maintenance authorization.

Disable a consumer explicitly:

```http
POST /local/eventing/consumers/disable
Content-Type: application/json
X-Maple-Maintenance-Token: <maintenance token>

{"consumerId":"automation"}
```

Disabling clears any active lease and removes that cursor from the retention quorum. It does not
delete the audit record or permit the ID to be reused.

## Claim and acknowledgement

Claim between 1 and 1,000 ready events for a lease of 5 through 300 seconds:

```http
POST /local/eventing/claims
Content-Type: application/json
X-Maple-Event-Consumer-Token: <consumer token>

{"consumerId":"automation","limit":100,"leaseSeconds":60}
```

A non-empty response has this shape:

```json
{
	"consumerId": "automation",
	"leaseToken": "<64 lowercase hexadecimal characters>",
	"leaseExpiresAt": "2026-08-13T16:01:00.000Z",
	"throughSequence": 42,
	"events": [
		{
			"sequence": 42,
			"event": {
				"specversion": "1.0",
				"id": "sha256:...",
				"type": "dev.maple.example.record.observed.v1"
			},
			"stagedAt": "2026-08-13T16:00:00.000Z",
			"readyAt": "2026-08-13T16:00:00.010Z"
		}
	]
}
```

The real `event` member is the complete validated CloudEvent. An empty claim returns null lease
fields and an empty event array. Only a SHA-256 hash of the lease token is stored. A second claim
while the lease is live returns `409`; at or after expiry it returns the same unacknowledged prefix,
possibly with a new token.

After every event in the claimed batch has been accepted by the downstream system, acknowledge the
exact `throughSequence` returned by the claim:

```http
POST /local/eventing/acks
Content-Type: application/json
X-Maple-Event-Consumer-Token: <consumer token>

{"consumerId":"automation","leaseToken":"<claim token>","throughSequence":42}
```

Partial, extended, expired, missing, and wrong-token acknowledgements return `409`. Success returns:

```json
{ "consumerId": "automation", "acknowledgedThrough": 42, "prunedEvents": 0 }
```

Claims are at-least-once. A consumer crash after a downstream send and before acknowledgement causes
re-delivery after lease expiry. A consumer must therefore use the immutable Maple CloudEvent `id` as
its downstream idempotency key whenever the destination supports one.

## Retention, capacity, and checkpoints

Ready events are eligible for pruning only through the lowest acknowledged sequence among all active
consumers for the tenant. Maple retains the newest 1,000 otherwise-prunable ready events by default.
Disabled consumers do not block pruning; staged events are never pruned by consumer acknowledgement.
If no consumer is active, acknowledgement retention performs no deletion.

The eventing control database uses schema 4. Schemas 1 through 3 are accepted and each migration step
is applied transactionally on open. A schema-3 database containing a staged source-backed event is
rejected before the schema-4 migration: schema 3 did not persist the normalized-source fingerprint
needed to distinguish an exact retry from source-ID reuse. Complete or explicitly abandon those
staged events with the schema-3 build before upgrading. Ready schema-3 events and older snapshots
without that unresolved state remain migratable. Restore opens and migrates a private scratch copy
before publishing restored state, so an unrecoverable legacy snapshot cannot replace the live store.
Schema-4 validation also rejects staged source-backed rows with missing or malformed fingerprints.
Consumer cursors and leases are part of the same SQLite backup as projection and outbox state.
Consumer mutations enter the server admission gate, so checkpoint exclusivity cannot capture a
half-applied claim or acknowledgement.
