# Extending Maple's signal-to-event system

This guide walks through adding either of the two main eventing extensions:

- a **source adapter**, which turns an authenticated source payload into typed,
  normalized signals; or
- a **semantic projector**, which turns matching signals into versioned factual
  events.

You can add one or both, depending on what the source already provides.

First, one important naming point: an eventing extension is a compile-time
registered module. It is not a runtime-loaded plugin, and projection
configuration cannot introduce executable code.

The host decides which adapters and projectors are installed. An operator can
then activate installed projectors through bounded, durable projection
revisions.

The contracts in `@maple/eventing-core` are host-neutral. Hosted Maple and Maple
Local can install the same source and projector definitions while using
different authentication, persistence, transaction, and consumer
implementations.

## Where the extension fits

A factual occurrence moves through the system like this:

```text
authenticated input
    -> source adapter
    -> typed normalized signal
    -> registered field catalog and selector
    -> pure registered projector
    -> schema-validated CloudEvent
    -> host-owned durable outbox
    -> named consumer or hosted delivery path
```

The extension is responsible for:

- normalizing an authenticated source payload into bounded signals;
- defining stable source and occurrence identity;
- declaring the selectable field catalog and sensitivity policy;
- decoding projector configuration and output;
- translating a matching signal into factual event data; and
- owning the versioned event type and data-schema names.

The host is responsible for:

- authenticating the source or verifying its signature before normalization;
- decoding requests and enforcing input-size limits;
- storing projection revisions and activating compiled registries atomically;
- defining the warehouse or source-of-record commit boundary;
- staging events durably and detecting recovery collisions;
- checkpointing or providing equivalent hosted transactional persistence; and
- authorizing consumers, delivering events, retrying work, and performing side
  effects.

That last boundary matters: projectors never perform I/O. Sending a message,
calling a provider, mutating source state, or deciding what action to take
belongs to a consumer after the event has crossed the durable boundary.

## Do you need a new source adapter?

A useful rule of thumb is to reuse an installed source kind whenever it already
preserves the fact you need.

For example, when a semantic fact already arrives in an OTLP log, you will
usually need only:

1. a new projector; and
2. projection configuration that selects the relevant logs.

You do not need another OTLP decoder.

Add a source adapter when the source has its own authenticated payload, identity
contract, or field vocabulary. A provider webhook is the usual example.

A new adapter should not decode the same request a second time just for
eventing. The host should decode once, authenticate once, and pass the
already-decoded value to the adapter.

Before writing the implementation, settle the following contracts:

| Decision       | What to decide                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `sourceKind`   | A stable name for the normalized input contract.                                                                                            |
| `source`       | A stable URI identifying the logical producer or integration. Never include credentials.                                                    |
| `occurrenceId` | Prefer an ID issued by the source that remains stable across retries and rebatching. Document the collision limits of any derived identity. |
| Event time     | Use source time. Do not put a changing server receipt time into durable event bytes.                                                        |
| Fields         | Expose only the bounded scalar values needed for selection.                                                                                 |
| `data`         | Preserve only bounded, schema-validated projector input. Do not retain an unchecked raw request.                                            |
| Sensitivity    | Mark fields as sensitive when generic projection must not expose them by default.                                                           |
| Replay         | State whether each field can be reconstructed exactly, only through an explicit coercion, or not at all.                                    |

When the source provides no stable occurrence identity, say so through the
weaker identity quality. When it provides no stable source timestamp, do not
substitute a changing host receipt time. A host may decline durable projection
rather than pretend the source offers retry-safe identity or time.

## Complete example

The following example takes a build-system message that the host has already
authenticated and runtime-decoded, normalizes it, and projects successful builds
into a versioned factual event.

The example is deliberately provider-neutral.

### 1. Define the source and normalize its messages

```ts
import { defineSignalFields, type SignalSourceAdapter } from "@maple/eventing-core"

interface BuildMessage {
	readonly id: string
	readonly projectId: string
	readonly status: "running" | "success" | "failed"
	readonly occurredAt: string
}

interface BuildContext {
	readonly tenantId: string
	readonly integrationId: string
}

export const BUILD_SOURCE: SignalSourceAdapter<BuildMessage, BuildContext> = {
	definition: {
		sourceKind: "example.build",
		fields: [
			{
				field: { namespace: "signal", key: "event.name", type: "string" },
				operators: ["exists", "eq", "neq", "in"],
				sensitivity: "public",
				replay: "exact",
			},
			{
				field: { namespace: "attribute", key: "build.status", type: "string" },
				operators: ["exists", "eq", "neq", "in"],
				sensitivity: "public",
				replay: "exact",
			},
		],
	},
	normalize: (message, context) => [
		{
			sourceKind: "example.build",
			source: `urn:example:builds:${context.integrationId}`,
			tenantId: context.tenantId,
			occurrenceId: message.id,
			identityQuality: "source",
			occurredAt: message.occurredAt,
			// This provider has no separate, stable observation timestamp.
			// Use source time rather than a changing host receipt time.
			observedAt: message.occurredAt,
			subject: `projects/${message.projectId}/builds/${message.id}`,
			fields: defineSignalFields([
				{
					field: { namespace: "signal", key: "event.name", type: "string" },
					value: { type: "string", value: "build.status.changed" },
				},
				{
					field: { namespace: "attribute", key: "build.status", type: "string" },
					value: { type: "string", value: message.status },
				},
			]),
			data: {
				buildId: message.id,
				projectId: message.projectId,
				status: message.status,
			},
		},
	],
}
```

Authentication is intentionally absent from `normalize`. The host must verify
the message before calling the adapter.

Normalization must also be deterministic. Given the same source occurrence, it
should produce the same normalized signal. It must not call `Date.now()`,
generate a UUID, query a database, make a network request, or depend on mutable
host state.

### 2. Define the projector's runtime codecs

Projector configuration and projector output both cross trust boundaries, so
each needs a runtime decoder.

The output decoder is especially important: it makes `dataschema` an enforced
contract rather than a hopeful annotation.

```ts
import { type JsonValue, type SignalProjector } from "@maple/eventing-core"
import { Schema } from "effect"

const BuildData = Schema.Struct({
	buildId: Schema.String,
	projectId: Schema.String,
	status: Schema.Literals(["running", "success", "failed"]),
})

const BuildCompletedConfig = Schema.Struct({
	includeProject: Schema.Boolean,
})

const BuildCompletedData = Schema.Struct({
	build_id: Schema.String,
	project_id: Schema.optionalKey(Schema.String),
	status: Schema.Literal("success"),
})

const decodeBuildData = Schema.decodeUnknownSync(BuildData)
const decodeConfig = Schema.decodeUnknownSync(BuildCompletedConfig)
const decodeOutput = (value: unknown): JsonValue => Schema.decodeUnknownSync(BuildCompletedData)(value)

export const BUILD_COMPLETED_PROJECTOR: SignalProjector<Schema.Schema.Type<typeof BuildCompletedConfig>> = {
	id: "example.build-completed",
	version: 1,
	sourceKinds: ["example.build"],
	outputType: "dev.maple.example.build.completed.v1",
	dataSchema: "urn:maple:event-schema:example-build-completed:v1",
	decodeConfig,
	decodeOutput,
	project: (signal, config) => {
		const build = decodeBuildData(signal.data)
		if (build.status !== "success") {
			throw new Error("build-completed projector requires a successful build")
		}
		return {
			subject: signal.subject,
			time: signal.occurredAt,
			data: {
				build_id: build.buildId,
				...(config.includeProject ? { project_id: build.projectId } : {}),
				status: "success",
			},
		}
	},
}
```

The selector should normally stop incompatible statuses from reaching this
projector. The explicit check is still useful: if the projection configuration
and implementation ever drift apart, the projector fails closed instead of
emitting a misleading event.

### 3. Register the code and compile a projection

Registration installs trusted code. A projection revision selects that
installed code and supplies bounded data configuration.

That distinction is the core safety model: configuration chooses among
registered behavior, but it cannot introduce new executable behavior.

```ts
import {
	CompiledProjectionRegistry,
	ProjectorRegistry,
	SignalSourceRegistry,
	type SignalProjectionSpec,
} from "@maple/eventing-core"

const sources = new SignalSourceRegistry().register(BUILD_SOURCE.definition)
const projectors = new ProjectorRegistry().register(BUILD_COMPLETED_PROJECTOR)

const projection: SignalProjectionSpec = {
	id: "successful-builds",
	revision: 1,
	enabled: true,
	tenantId: "tenant-a",
	sourceKind: "example.build",
	selector: {
		op: "eq",
		field: { namespace: "attribute", key: "build.status", type: "string" },
		value: { type: "string", value: "success" },
	},
	projector: {
		id: "example.build-completed",
		version: 1,
		config: { includeProject: true },
	},
	activeFrom: "2026-08-21T00:00:00Z",
}

const compiled = CompiledProjectionRegistry.compile([projection], sources, projectors)
```

Compilation rejects:

- unknown source kinds;
- unknown projector IDs or versions;
- unsupported fields or operators;
- malformed projector configuration; and
- projectors that do not accept the selected source kind.

A host should replace its complete compiled registry snapshot atomically, and
only after compilation succeeds.

### 4. Evaluate at the host's commit boundary

```ts
const acceptedAt = "2026-08-21T12:00:01Z"
const [signal] = BUILD_SOURCE.normalize(
	{
		id: "build-42",
		projectId: "project-7",
		status: "success",
		occurredAt: "2026-08-21T12:00:00Z",
	},
	{
		tenantId: "tenant-a",
		integrationId: "integration-3",
	},
)

if (!signal) throw new Error("build adapter produced no signal")
const result = compiled.evaluate(signal, acceptedAt)
```

`acceptedAt` is host control metadata used for `activeFrom` gating. It is not
part of the source fact.

Do not put a changing acceptance timestamp into source identity, normalized
event content, or projector output. Otherwise, a retry could produce different
durable bytes for the same source occurrence.

`evaluate` is pure: it returns results but does not persist them.

The host must then:

1. stage every successfully projected event durably;
2. commit the original source occurrence to the warehouse or other source of
   record;
3. mark the staged events ready only after that commit succeeds; and
4. on retry, recover the original staged events rather than reevaluating the
   occurrence under a newer projection revision.

That last step is important. A projection may be edited or disabled between the
first attempt and a retry. Recovery must complete the original durable
obligation, not quietly replace it with whatever the current registry would
produce.

Maple Local implements this with its SQLite eventing control store and the chDB
commit seam. A hosted implementation may use a database transaction or another
durable outbox, as long as it provides the same ordering and recovery guarantees.

## Registering an extension in a host

### Maple Local

Maple Local already normalizes OTLP logs in `apps/cli/src/server/eventing`.

When the new fact is already carried by those logs, the usual path is:

1. register the projector in the `ProjectorRegistry` supplied to
   `LocalEventingRuntime`; and
2. activate a durable projection revision through the authenticated
   configuration boundary.

A genuinely new Local source requires a little more wiring:

1. authenticate and decode its ingest request;
2. pass the decoded value to a `SignalSourceAdapter`;
3. register the adapter definition in the Local composition root; and
4. preserve the existing stage → warehouse commit → ready ordering.

Do not bypass `LocalEventingRuntime` by writing directly to the outbox. That
would skip the shared identity, collision, activation, and recovery rules.

### Hosted Maple

A hosted source should:

1. verify and decode the request at the route boundary;
2. invoke its adapter once;
3. register the source and projector definitions in the service composition;
   and
4. persist the resulting events through the hosted durable boundary.

The PlanetScale webhook composition in
[`apps/api/src/services/integrations/planetscale/webhook-events.ts`](../apps/api/src/services/integrations/planetscale/webhook-events.ts)
is the current reference implementation. Provider verification stays outside
the projector, while the normalized fact uses the shared registry and
CloudEvent contracts.

A hosted implementation does not need to use Maple Local's SQLite store. It
does, however, need equivalent guarantees for:

- tenant isolation;
- idempotent staging;
- event and source-identity collision detection;
- durable recovery; and
- retries.

## Versioning without surprises

There are four separate kinds of versioning here. They solve different
problems, so do not collapse them into one number.

### Source kind

`sourceKind` identifies the normalized fields, identity rules, and source
contract.

Keep changes backward compatible. When you need an incompatible normalized
contract, introduce a new source kind.

### Projector version

Increment the projector version when its semantics or configuration
compatibility changes.

Never replace an old implementation under the same projector ID and version.
Existing durable projection revisions must continue to refer to the behavior
they originally selected.

### Event type and data-schema version

Change the event type or data-schema version when a consumer would observe an
incompatible payload contract.

Do not reuse an event type or schema URI for a differently shaped or differently
interpreted event.

### Projection revision

Create a new projection revision whenever you change:

- the selector;
- `activeFrom`;
- enabled or disabled state;
- the projector ID or version; or
- projector configuration.

Projection revisions are immutable and monotonic. A rollback is not an edit to
an older revision; it is a new revision that restores the earlier behavior.

## Schemas and fixtures

Every public or cross-runtime event contract should include the following:

1. A closed runtime decoder for projector output.
2. A matching, versioned JSON Schema in the package that owns the event.
3. Valid and invalid output fixtures.
4. A deterministic complete-event fixture with its expected canonical event ID.
5. Schema-generation and drift checks in the package test suite.

The shared schemas and fixtures in `packages/eventing-core` define the common
selector, envelope, and event-identity behavior.

Source-specific payload schemas should stay with the module that owns their
meaning.

## Required tests

An extension is not complete until its tests demonstrate all of the following:

- Authentication or signature verification happens before normalization.
- Normalization is bounded.
- Sensitive raw values are rejected or redacted according to the source policy.
- The same source occurrence normalizes deterministically.
- A retry under the same projection revision produces a byte-identical
  CloudEvent for the same source occurrence.
- Reusing a source ID with changed content is detected as a collision by the
  host.
- The field catalog accepts valid selector fields and operators.
- The field catalog rejects unknown or incompatible fields and operators.
- The projector configuration decoder rejects malformed configuration.
- The projector output decoder rejects malformed event data.
- One failing projector does not suppress successful sibling projections.
- Tenant mismatches and source-kind mismatches do not project.
- Event-size and string-size limits are enforced.
- A warehouse failure leaves the event staged.
- A retry promotes the original staged event exactly once.
- Checkpoint restore, or the hosted equivalent, preserves event and consumer
  state.

For pure contract examples, start with
[`packages/eventing-core/src/registry.test.ts`](../packages/eventing-core/src/registry.test.ts).

For durability examples, see the Local runtime and control-store tests under
[`apps/cli/test`](../apps/cli/test).

## Review checklist

Before registering an extension, reviewers should be able to answer yes to each
of these:

- Is the source authenticated before adapter code runs?
- Is occurrence identity stable across retries and rebatching?
- Are source time and host acceptance time kept separate?
- Are selectable fields typed, bounded, and classified for sensitivity?
- Is projector input bounded and schema validated?
- Are projector configuration and output decoded at runtime?
- Is the projector deterministic, pure, and free of I/O?
- Is ownership of the event type, data schema, and their versions explicit?
- Does the host preserve stage → source commit → ready ordering?
- Does retry recover the original staged event instead of reevaluating it under
  new configuration?
- Does the consumer use the immutable event ID as an idempotency key where the
  destination supports one?
- Are external side effects kept behind the durable event and consumer boundary?

For the underlying contracts and processing guarantees, see
[`signal-to-event-projection.md`](./signal-to-event-projection.md).

For Maple Local's consumer administration and lease semantics, see
[`local-event-consumers.md`](./local-event-consumers.md).
