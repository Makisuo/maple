# Writing a signal-to-event extension

This guide shows how to add a reusable signal source or semantic event projector
to Maple's eventing architecture.

An eventing extension is a **compile-time registered module**. It is not a
dynamically loaded plugin and it cannot add executable code through projection
configuration. A host chooses which adapters and projectors to install, while an
operator chooses which installed projector to activate with a bounded, durable
projection revision.

The contracts in `@maple/eventing-core` are host-neutral. Hosted Maple and Maple
Local can install the same source and projector definitions while supplying
different authentication, persistence, transaction, and consumer adapters.

## The extension boundary

One factual occurrence follows this path:

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

The extension owns:

- normalization of one authenticated source payload into bounded signals;
- stable source and occurrence identity;
- the selectable field catalog and sensitivity policy;
- projector configuration and output codecs;
- pure translation from a matching signal to factual event data; and
- versioned event type and data-schema names.

The host owns:

- authentication and signature verification before normalization;
- request decoding and input-size limits;
- projection revision storage and atomic registry activation;
- the warehouse commit boundary;
- durable event staging, recovery, and collision detection;
- checkpoints or hosted transactional persistence; and
- consumer authorization, delivery, retries, and side effects.

Projectors never perform I/O. Sending a message, calling a provider, mutating
source state, or deciding an action belongs to a consumer after the durable
event boundary.

## Decide whether a new source is needed

Use an installed source kind when it already preserves the fact you need. For
example, a semantic fact carried by an OTLP log usually needs only a new
projector and projection configuration; it does not need another OTLP decoder.

Add a source adapter when the source has a distinct authenticated payload,
identity contract, or field vocabulary, such as a provider webhook. A new
adapter must not decode the same request a second time merely for eventing.

Before writing code, record:

| Decision       | Requirement                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `sourceKind`   | Stable name for the normalized input contract.                                                       |
| `source`       | Stable URI for the logical producer or integration; never include credentials.                       |
| `occurrenceId` | Prefer a source-issued retry-stable ID. Document any derived identity and its collision limitations. |
| event time     | Use source time. Do not use a changing receipt time in durable event bytes.                          |
| fields         | Expose only bounded scalar values needed for selection.                                              |
| `data`         | Preserve only bounded, schema-validated projector input. Do not retain an unchecked raw request.     |
| sensitivity    | Mark fields sensitive when generic projection must not expose them by default.                       |
| replay         | Declare whether each field can be reconstructed exactly, only after coercion, or not at all.         |

If no stable source timestamp or occurrence identity exists, the adapter must
state the weaker identity quality. A host may decline durable projection rather
than pretend a retry-safe identity exists.

## Complete example

The following module adapts a verified build-system message and projects
successful builds into a versioned factual event. The example is intentionally
provider-neutral.

### 1. Define and normalize the source

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
			// This source has no separate stable observation timestamp.
			observedAt: message.occurredAt,
			subject: `projects/${message.projectId}/builds/${message.id}`,
			fields: defineSignalFields([
				{
					field: { namespace: "signal", key: "event.name", type: "string" },
					value: { type: "string", value: "build.completed" },
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

Authentication is deliberately absent from `normalize`. The host must verify
the message before calling the adapter. Normalization must be deterministic for
the same source occurrence and must not call `Date.now()`, generate UUIDs, or
perform network or database I/O.

### 2. Define projector codecs and implementation

Both projector configuration and projector output cross trust boundaries. Give
each one a runtime decoder. The output decoder is what makes `dataschema` an
enforced contract rather than an annotation.

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
		if (build.status !== "success")
			throw new Error("build-completed projector requires a successful build")
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

The selector should normally prevent incompatible statuses from reaching this
projector. The explicit check still makes the semantic precondition fail closed
if configuration and implementation drift apart.

### 3. Register code and compile configuration

Registration installs code. A projection revision selects installed code and
supplies bounded data configuration.

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

Compilation rejects unknown sources or projectors, unsupported fields or
operators, invalid projector configuration, and contradictory source kinds.
Hosts atomically replace an entire compiled registry snapshot only after this
step succeeds.

### 4. Evaluate at the host commit boundary

```ts
const acceptedAt = "2026-08-21T12:00:01Z"
const [signal] = BUILD_SOURCE.normalize(
	{
		id: "build-42",
		projectId: "project-7",
		status: "success",
		occurredAt: "2026-08-21T12:00:00Z",
	},
	{ tenantId: "tenant-a", integrationId: "integration-3" },
)

if (!signal) throw new Error("build adapter produced no signal")
const result = compiled.evaluate(signal, acceptedAt)
```

`acceptedAt` is host control metadata used for `activeFrom` gating. Do not put a
changing acceptance timestamp into source identity or projector output.

`evaluate` is pure and does not persist its result. The host must:

1. stage every successful event durably;
2. commit the original source occurrence to its warehouse or source-of-record;
3. mark the staged event ready only after that commit succeeds; and
4. recover the original staged identity on retry rather than evaluating the
   occurrence against a newer projection revision.

Maple Local implements this with its SQLite eventing control store and chDB
commit seam. A hosted adapter may provide the same guarantee with a database
transaction or another durable outbox implementation.

## Host registration patterns

### Maple Local

Maple Local already normalizes OTLP logs in `apps/cli/src/server/eventing`. If a
new fact is carried by those logs, register only the projector in the
`ProjectorRegistry` supplied to `LocalEventingRuntime`, then activate a durable
projection revision through the authenticated configuration boundary.

A genuinely new Local source also requires wiring its authenticated ingest path
to a `SignalSourceAdapter`, registering the adapter definition in the Local
composition root, and preserving the existing stage → warehouse commit → ready
ordering. Do not bypass `LocalEventingRuntime` by writing directly to the outbox.

### Hosted Maple

A hosted source verifies and decodes its request at the route boundary, invokes
its adapter once, and registers source and projector definitions in its service
composition. The PlanetScale webhook composition in
`apps/api/src/services/integrations/planetscale/webhook-events.ts` is the current
reference: provider verification remains outside the projector, while the
normalized fact uses the shared registry and CloudEvent contract.

Hosted persistence does not need to use the Local SQLite store. It must still
provide equivalent tenant isolation, idempotent event staging, collision
detection, and retry behavior.

## Versioning rules

Four versions have different meanings:

- **Source kind** identifies the normalized field and identity contract. Keep
  changes backward compatible or introduce a new source kind.
- **Projector version** changes when projector semantics or configuration
  compatibility changes.
- **Event type and data-schema version** change when consumers would observe an
  incompatible payload contract.
- **Projection revision** changes for every selector, activation, enabled state,
  projector reference, or projector configuration edit. Revisions are immutable
  and monotonic; rollback is a new revision.

Do not rewrite an old projector implementation under the same ID and version.
Do not reuse an event type or schema URI for an incompatible payload.

## Schema and fixture checklist

For each public or cross-runtime event contract:

1. Define a closed runtime output decoder.
2. Publish or generate the matching versioned JSON Schema in the owning package.
3. Add valid and invalid output fixtures.
4. Add a deterministic event fixture with the expected canonical event ID.
5. Keep schema generation and drift checks in the package test suite.

The shared schemas and fixtures under `packages/eventing-core` define the common
selector, envelope, and identity behavior. Source-specific payload schemas stay
with the module that owns their semantics.

## Required tests

An extension is not complete until its tests prove:

- authentication happens before normalization;
- normalization is bounded and rejects or redacts sensitive raw values;
- the same source occurrence normalizes deterministically;
- source retries produce byte-identical CloudEvents;
- a reused source ID with changed content is detected by the host as a collision;
- catalog types and operators accept valid selectors and reject invalid ones;
- projector configuration and output codecs reject malformed values;
- one failing projector does not suppress successful sibling projections;
- tenant and source-kind mismatches do not project;
- event and string-size limits are enforced;
- a warehouse failure leaves events staged, and a retry promotes the original
  staged event exactly once; and
- checkpoint or hosted restore paths preserve event and consumer state.

Use the registry tests in `packages/eventing-core/src/registry.test.ts` for pure
contract examples and the Local runtime/control-store tests in `apps/cli/test`
for durability examples.

## Review checklist

Before registering an extension, reviewers should be able to answer yes to all
of the following:

- Is the source authenticated before adapter code runs?
- Is occurrence identity stable across retries and rebatching?
- Are source time and acceptance time kept distinct?
- Are selectable fields typed, bounded, and classified for sensitivity?
- Is projector input bounded and schema validated?
- Are projector configuration and output decoded at runtime?
- Is the projector deterministic, pure, and free of I/O?
- Are event type, schema, and version ownership explicit?
- Does the host preserve stage → source commit → ready ordering?
- Can a consumer retry without duplicating a factual event or side effect?

For the underlying contracts and processing guarantees, see
[`signal-to-event-projection.md`](./signal-to-event-projection.md). For Maple
Local consumer administration and lease semantics, see
[`local-event-consumers.md`](./local-event-consumers.md).
