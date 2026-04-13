# alchemy-effect

Alchemy Effect is an Infrastructure-as-Effects (IaE) framework that extends Infrastructure-as-Code (IaC) by combining business logic and infrastructure config into a single, type-safe program expressed as Effects.

It includes a core IaC engine built with Effect. Effect provides the foundation for type-safe, composable, and testable infrastructure programs. It brings errors into the type-system and provides declarative/composable retry logic that ensure proper and reliable handling of failures.

# Concepts

- **Cloud Provider** - a cloud provider that offers a set of Services, e.g. AWS, Azure, GCP, Cloudflare, Stripe, Planetscale, Neon, etc.
- **Service** - a collection of Resources, Functions, and Bindings offered by a Cloud Provider.
- **Resource** - a named entity that is configuted with "Input Properties" and produces "Output Attributes". May or may not have Binding Contract.
- **Input Properties** - the properties passed as input to configure a Resource. Otherwise known as the "desired state" of the Resource.
- **Output Attributes** - the attributes produced by a Resource. Otherwise known as the "current state" of the Resource.
- **Stable Properties** - properties that are not affected by an Update, e.g. the ID or ARN of a Resource.
- **Function** (aka. **Runtime**) - a special kind of Resource that includes a runtime implementation expressed as a Function producing an `Effect<A, Err, Req>`. The `Req` type captures runtime dependencies, from which Infrastructure Dependencies are inferred.
- **Resource Provider** (see [Provider](./alchemy-effect/src/Provider.ts))

A Resource Provider implements the following Lifecycle Operations:

- **Diff** - compares new props with old props and determines if the Resource needs to be updated or replaced. For updates, it can also specify a list of Stable Properties that will not be changed by the update.
- **Read** - reads the current state of a Resource and returns the current Output Attributes.
- **Pre-Create** - an optional operation that can be called to create a stub of a Resource before the actual create operation is called. This is useful for resolving circular dependencies since it allows for an empty resoruce to be created and then updated later with its dependencies (e.g. Function A and B depend on each other, so we can create a stub of Function A and then update it with the actual Function B later).
- **Create** - creates a new Resource. It must be designed as idempotent because it is always possible for state persistence to fail after the create operation is called. There are various techniques for resolving idempotency, such as deterministic physical name generation and resource tagging.
- **Update** - updates an existing Resource with new Input Properties.
- **Delete** - deletes an existing Resource. It must be designed as idempotent because it is always possible for state persistence to fail after the delete operation is called. If the resource doesn't exist during deletion, it should not be considered an error.
- **Capability** - a runtime requirement of a Function (e.g. require `SQS.SendMessage` on a `SQS.Queue`). Each Capability is split into two parts: a `Binding.Service` (runtime SDK wrapper) and a `Binding.Policy` (deploy-time IAM/binding attachment).
- **Binding.Service** - an Effect Service that wraps an SDK client and exposes a `.bind(resource)` method returning a typed callable for runtime use. Provided as a Layer on the **Function** Effect so it gets bundled into the Lambda/Worker. See [Binding](./alchemy-effect/src/Binding.ts).
- **Binding.Policy** - an Effect Service that runs only at deploy time to attach IAM policies (AWS) or bindings (Cloudflare) to a Function's role/config. At runtime, `Binding.Policy` uses `Effect.serviceOption` so it gracefully becomes a no-op when the layer is not provided. Policy layers are provided on the **Stack** via `AWS.providers()()`, not on the Function.
- **Binding** - data attached to a Resource via `resource.bind(data)`. A Binding is a `{ context: PolicyContext, data: BindingData }` tuple that is collected on the Stack during plan/deploy. Bindings enable circular references between Resources — the `Binding.Policy` calls `ctx.bind({ policyStatements: [...] })` on the target Function, which records the binding data on the Stack. The Resource Provider then receives the resolved binding data in its `create`/`update` lifecycle operations via the `bindings` parameter.
- **Binding Contract** - the shape of data a Resource accepts from Bindings. For example, a Lambda Function accepts `{ env?: Record<string, any>, policyStatements?: PolicyStatement[] }` because it needs environment variables and IAM policies. A Cloudflare Worker accepts `{ bindings: Worker.Binding[] }` for its native binding system. The Binding Contract is declared as the fourth type parameter on the `Resource` interface. See [Lambda Function](./alchemy-effect/src/AWS/Lambda/Function.ts) and [Cloudflare Worker](./alchemy-effect/src/Cloudflare/Workers/Worker.ts).
- **Dependency** - Resources depend on other Resources through two mechanisms:
  - Output Properties of one Resource passed as Input Properties to another Resource (non-circular, directed acyclic graph)
  - Bindings that attach data (IAM policies, env vars, Cloudflare bindings) from one Resource to another, enabling circular references between Resources.
- **Output** - a reference to (or derived from) a Resource's "Output Attributes". E.g. Bucket.bucketArn
- **Stack** - a collection of Resources, Functions, and Bindings that are deployed together.
- **Stack Name** - the name of a Stack, e.g. `my-stack`
- **Stage** - the stage of a Stack, e.g. `dev`, `prod`, `dev-sam`
- **Stack Instance** - a deployed instance of a Stack+Stage
- **Resource Type** - the type of a Resource, e.g. `Bucket`, `Instance`
- **Physical Name** - a unique name for a Resource, e.g. `my-bucket-1234567890`. It is usually best to generate them using the built-in createPhysicalName utility function which generates
- **Logical ID** - the logical ID identifying a resource within a Stack, e.g. `my-bucket`. It is stable across creates, updates, deletes and replaces.
- **Instance ID** - a unique identifier for an instance of a Resource. It is stable across creates, updates and deletes. It changes when a resource is replaced. It is truncated and used as the suffix of the Physical Name.
- **Event Source** - a special kind of Binding between a Function and a Resource that produces events that invoke the Function, e.g. `SQS.QueueEventSource`. Event Sources are implemented as Binding.Service + Binding.Policy pairs, where the attach logic creates/updates the event source mapping via the cloud provider API.
- **Replacement** - the process of replacing a Resource with a new one. A new one is created, downstream dependencies are updated with the new reference, and then the old one is deleted. Or, the old one is deleted first and then the new one is created.
- **Dependency Violation** - an error that some APIs call when an operation cannot be performed because a dependency is not met. E.g. you cannot delete an EIP until the NAT Gateway it is attached to is deleted. Lifecycle operations typically retry Dependency Violations.
- **Eventual Consistency** - create/update/delete operations can be eventually consistent leading to a variety of failure modes. For example, a Resource may be created but not yet available for use, or a Resource may be deleted but still appear in the console. Errors caused by eventual consistency should be retried, and lifecycle operations/tests should be carefully designed to wait for consistency before proceeding.
- **Retryable Error** - an error that can be retried. E.g. a Dependency Violation, Eventual Consistency Error, Transient Failure, etc.
- **Non-Retryable Error** - an error that cannot be retried. E.g. a Validation Error, Authorization Error, etc.
- **Retry Policy** - a policy for retrying errors. E.g. a fixed delay, exponential backoff, max retries, while some condition is true, or until some condition is true/false, etc.

# File System Conventions

Each Service's Resources follow the same pattern. Resource contract and provider are co-located in the same file. Capabilities (Binding.Service + Binding.Policy) are in separate files named after the capability.

```sh
# source files
alchemy-effect/src/{Cloud}/{Service}/index.ts         # re-exports all resources and capabilities
alchemy-effect/src/{Cloud}/{Service}/{Resource}.ts     # resource contract + resource provider
alchemy-effect/src/{Cloud}/{Service}/{Capability}.ts   # Binding.Service + Binding.Policy for a capability
# test files
alchemy-effect/test/{Cloud}/{Service}/{Resource}.test.ts
# docs (auto-generated from source code - do not manually edit)
alchemy-effect/docs/{Cloud}/{Service}/{Resource}.md    # API reference, auto-generated from JSDoc comments
```

Examples of actual paths:

```sh
alchemy-effect/src/AWS/S3/Bucket.ts          # S3 Bucket resource + provider
alchemy-effect/src/AWS/S3/GetObject.ts       # S3 GetObject Binding.Service + Binding.Policy
alchemy-effect/src/AWS/S3/PutObject.ts       # S3 PutObject Binding.Service + Binding.Policy
alchemy-effect/src/AWS/SQS/Queue.ts          # SQS Queue resource + provider
alchemy-effect/src/AWS/SQS/SendMessage.ts    # SQS SendMessage capability
alchemy-effect/src/AWS/Kinesis/Stream.ts     # Kinesis Stream resource + provider
alchemy-effect/src/AWS/Kinesis/PutRecord.ts  # Kinesis PutRecord capability
alchemy-effect/src/AWS/Lambda/Function.ts    # Lambda Function resource + provider
alchemy-effect/src/AWS/DynamoDB/Table.ts     # DynamoDB Table resource + provider
alchemy-effect/src/AWS/DynamoDB/GetItem.ts   # DynamoDB GetItem capability
alchemy-effect/src/AWS/EC2/Vpc.ts            # VPC resource + provider
alchemy-effect/src/AWS/EC2/Subnet.ts         # Subnet resource + provider
```

# Documentation Generation

**Source of truth:** The source code is the single source of truth for all API documentation. JSDoc comments in the source files are extracted and used to generate markdown documentation.

**How to generate docs:**

```sh
bun run generate:docs
# or directly:
bun scripts/generate-docs.ts
```

This script:

1. Discovers all resource files in `alchemy-effect/src/{cloud}/{service}/`
2. Parses TypeScript using the TypeScript Compiler API
3. Extracts JSDoc comments from Props and Attrs interfaces
4. Extracts capabilities and event sources for each resource
5. Generates one markdown file per resource at `alchemy-effect/docs/{cloud}/{service}/{resource}.md`

**Writing good documentation:** When adding or updating a resource, ensure all Props and Attrs have JSDoc comments:

```typescript
export interface BucketProps {
  /**
   * Name of the bucket. If omitted, a unique name will be generated.
   * Must be lowercase and between 3-63 characters.
   */
  bucketName?: string;

  /**
   * Whether to delete all objects when the bucket is destroyed.
   * @default false
   */
  forceDestroy?: boolean;
}
```

The `@default` tag is used to document default values and will appear in the generated documentation.

### Examples and Sections (IMPORTANT)

**Examples are critical for documentation.** Every resource should have examples demonstrating common use cases. Use `@section` and `@example` JSDoc tags on the main Resource export to organize examples into a navigable table of contents.

**Format:**

- `@section <Section Title>` - Creates a heading in the Examples section and adds an entry to the Quick Reference table of contents
- `@example <Example Title>` - Creates a subheading for a specific code example (must follow a `@section`)
- Code blocks inside examples use standard markdown fenced code blocks (` `)

**Example:**

````typescript
/**
 * An S3 bucket for storing objects.
 *
 * @section Creating a Bucket
 * @example Basic Bucket
 * ```typescript
 * const bucket = yield* Bucket("my-bucket", {});
 * ```
 *
 * @example Bucket with Force Destroy
 * ```typescript
 * const bucket = yield* Bucket("my-bucket", {
 *   forceDestroy: true,
 * });
 * ```
 *
 * @section Reading Objects
 * @example Get Object from Bucket
 * ```typescript
 * const response = yield* getObject(bucket, { key: "my-key" });
 * const body = yield* Effect.tryPromise(() => response.Body?.transformToString());
 * ```
 *
 * @section Writing Objects
 * @example Put Object to Bucket
 * ```typescript
 * yield* putObject(bucket, {
 *   key: "hello.txt",
 *   body: "Hello, World!",
 *   contentType: "text/plain",
 * });
 * ```
 */
export const Bucket = Resource<...>("AWS.S3.Bucket");
````

This generates:

1. A "Quick Reference" section with links to each `@section`
2. An "Examples" section with organized code examples under each section heading

**Best practices for examples:**

- Start with the simplest use case and progress to more complex ones
- Include examples for all major capabilities (GetObject, PutObject, etc.)
- Show real-world patterns like error handling, combining with other resources
- Use descriptive titles that explain what the example demonstrates

# Workflow

Development of Alchemy-Effect Resources is heavily pattern based. Each Service has many Resources that each have 0 oor more Capabilities and Event Sources. When working on a new Service, the following steps should be followed.

1. Research the AWS Service and identify its Resources, Identifier Types, Structs, Capabilities, and Event Sources. Refer to the corresponding Terraform Provider, Pulumi Provider, and CloudFormation docs for that service (use the provided tools specifically for searching these docs for services and resources).

Example (abbreviated):

Service: S3

Resources:

- Bucket
- BucketPolicy
- etc.

Bucket Capabilities:

- GetObject
- PutObject
- DeleteObject

Identifier Types:

- Bucket Name
- Bucket ARN

Structs:

- CorsRule
- LifecycleConfiguration

2. Document each of the Resource interfaces

Include the following information:

- ResourceName, e.g. Bucket, Instance, Queue
- Input Properties (for each property: Name, Type, Description, Default Value, Required, Constraints, Replaces: true/false)
- Output Attributes (for each attribute: Name, Type, Description)

3. Document each of the Capabilities and Bindings

Include the following information:

- Capability Name, e.g. `GetObject`, `PutObject` (it maps 1:1 with an AWS API)
- Constraints (e.g. `Key`)
- IAM Policies (how the capability maps to an IAM Policy, e.g. Effect: Allow, Action: s3:GetObject, Resource: `arn:aws:s3:::${bucketName}/${Key}`)
- Environment Variables (what environment variables should be added to a Lambda Function so that it can access the capability, e.g. `BUCKET_NAME`, `BUCKET_ARN`, `QUEUE_URL`, `QUEUE_ARN`, etc.)

4. Research and design each of the Lifecycle Operations

- **Diff** - identify which properties are always stable across any update, which properties change conditionally depending on new and old values, which properties trigger a replacement. This is usually just a distinct list, but can sometimes require if-this-then-that logic. Document it explicitly and exhaustively. Cross-reference with AWS CloudFormation, Terraform Provider and Pulumi Provider docs.

:::warning
You should almost never use `no-op` in the Diff. No-op should be explicitly designed as a way to say "i know this property changed, but i don't want it to trigger an update". This is an edge-case and not the norm. Usually you want diff to return `undefined` or `void` to let the engine apply the default update logic. Diff is usually just use as an optimization or to identify replacement instead of update.
:::

- **Read** - determine which API calls are required to read the Output Attributes of a Resource from the Cloud Provider state (otherwise known as refresh or synchronize resource state). This is usually a single Get{Resource} API call, but can be a complex set of calls depending on the Service. Read can also be called without the current Output Attributes because of past state persistence failures. These cases are handled by computing the deterministic Physical Name and looking it up or by searching for Resources using tags (if the Cloud Provider supports it).
- **Pre-Create** - determine if the Resource needs a pre-create operation. This is usually only the case for the special Function/Runtime Resources like AWS Lambda Functions. If it is required, then document which API call(s) should be called and what the empty (unit) input properties are. E.g. a Lambda Function takes a simple script that exports a no-op handler function.
- **Create** - determine which APIs calls are required to create a new instance of a Resource. This can be one or more API calls in a sequence. Include a section dedicated to idempotency and error handling. Does the resource accept a physical name that we can predict to idempotently create a new resource and recover gracefully if it already exists? Or does the resource generate its own ID, in which case we need to use tags to find it? Document the procedure using if-this-then-that logic. Each API call can return errors that should
- **Update** - determine which APIs should be called and in what order to update an existing Resource. Document the procedure using if-this-then-that logic. Each API call can return errors that may need to be retried with a specific Retry Policy. The procedure should be defined conditionally in terms of new Input Properties, old Input Properties and the current Output Attributes.
- **Delete** - determine which APIs should be called and in what order to delete an existing Resource. Delete should be idempotent so that if the resource has already been deleted, it is not considered an error. It is common for deletions to fail because of Dependency Violations or Eventual Consistency Errors. These are not always called Dependency Violations in the API docs, so attention should be paid to investigating each API's possible error codes and how they should be handled by the Delete operation. Should we retry for a period of time, indefinitely, or fail immediately?

5. Research and design the test cases for each resource. Test cases can be single or multi-step. Single-step test cases are just testing a single create success or failure mode. Multi-step cases are testing a sequence of operations, starting with create and then updating or replacing the resource multiple times. Test cases should be designed to be exhaustive and cover all possible success and failure modes, starting from simple happy paths to long, complicated aggregate (including other resources) smoke tests.
6. Implement the Resource contract and Provider in `alchemy-effect/src/{Cloud}/{Service}/{Resource}.ts`.

The Resource contract (Props, Attributes, Binding Contract) and the Resource Provider (lifecycle operations) are co-located in the same file.

Read through the established examples to understand the pattern:

- [S3 Bucket](./alchemy-effect/src/AWS/S3/Bucket.ts)
- [SQS Queue](./alchemy-effect/src/AWS/SQS/Queue.ts)
- [DynamoDB Table](./alchemy-effect/src/AWS/DynamoDB/Table.ts)
- [Kinesis Stream](./alchemy-effect/src/AWS/Kinesis/Stream.ts)
- [Lambda Function](./alchemy-effect/src/AWS/Lambda/Function.ts)
- [VPC](./alchemy-effect/src/AWS/EC2/Vpc.ts)
- [Subnet](./alchemy-effect/src/AWS/EC2/Subnet.ts)

The Resource interface takes four type parameters: `Resource<Type, Props, Attributes, BindingContract>`.

```ts
export interface Stream extends Resource<
  "AWS.Kinesis.Stream",
  StreamProps,
  {
    streamName: string;
    streamArn: string;
    streamStatus: StreamStatus;
  }
> {}

export const Stream = Resource<Stream>("AWS.Kinesis.Stream");
```

For Resources that accept Bindings (like Lambda Function), include a fourth type parameter for the Binding Contract:

```ts
export interface Function extends Resource<
  "AWS.Lambda.Function",
  FunctionProps,
  {
    functionArn: string;
    functionName: string;
    functionUrl: string | undefined;
    roleName: string;
    roleArn: string;
  },
  {
    env?: Record<string, any>;
    policyStatements?: PolicyStatement[];
  }
> {}
```

:::tip
Some Input Property types are wrapped in an `Input<T>`, but not all are. Only properties that may need to be references to another resource's Output Attribute. E.g. common use-cases are `Input<VpcId>`, `Input<QueueUrl>`, `Tags: Record<string, Input<string>>`.
:::

:::warning
For fields like `name: string`, `bucketName: string`, `bucketPrefix: string`, you should not use `Input<string>` because these properties need to be statically knowable in the `diff` function.
:::

7. Implement the Capabilities as `Binding.Service` + `Binding.Policy` pairs in `alchemy-effect/src/{Cloud}/{Service}/{Capability}.ts`.

Each capability has two parts:

- **`Binding.Service`** — runtime SDK wrapper, provided on the Function Effect (bundled into Lambda/Worker)
- **`Binding.Policy`** — deploy-time IAM policy attachment, provided on the Stack via `AWS.providers()()` (never bundled)

Read through the established capabilities to understand the pattern:

- [S3 GetObject](./alchemy-effect/src/AWS/S3/GetObject.ts) — `Binding.Service` + `Binding.Policy`
- [S3 PutObject](./alchemy-effect/src/AWS/S3/PutObject.ts) — `Binding.Service` + `Binding.Policy`
- [SQS SendMessage](./alchemy-effect/src/AWS/SQS/SendMessage.ts) — `Binding.Service` + `Binding.Policy`
- [DynamoDB GetItem](./alchemy-effect/src/AWS/DynamoDB/GetItem.ts) — `Binding.Service` + `Binding.Policy`
- [Kinesis PutRecord](./alchemy-effect/src/AWS/Kinesis/PutRecord.ts) — `Binding.Service` + `Binding.Policy`
- [Lambda InvokeFunction](./alchemy-effect/src/AWS/Lambda/InvokeFunction.ts) — `Binding.Service` + `Binding.Policy`

For Event Sources, see:

- [SQS QueueEventSource](./alchemy-effect/src/AWS/SQS/QueueEventSource.ts)
- [S3 BucketEventSource](./alchemy-effect/src/AWS/S3/BucketEventSource.ts)

The `Binding.Policy` implementation calls `ctx.bind({ policyStatements: [...] })` on the target Function, which records binding data on the Stack. The `Binding.Service` implementation resolves the Policy via `yield* Policy(resource)`, then returns a typed callable that wraps the SDK client. At runtime, the Policy is not provided and becomes a no-op.

Each capability exports four things:

```ts
// 1. The Binding.Service class
export class PutRecord extends Binding.Service<...>()("AWS.Kinesis.PutRecord") {}

// 2. The Binding.Service Live layer (provided on Function Effect)
export const PutRecordLive = Layer.effect(PutRecord, ...);

// 3. The Binding.Policy class
export class PutRecordPolicy extends Binding.Policy<...>()("AWS.Kinesis.PutRecord") {}

// 4. The Binding.Policy Live layer (provided on Stack via AWS.providers()())
export const PutRecordPolicyLive = Layer.effect(PutRecordPolicy, ...);
```

After implementing, register the Policy in `AWS.providers()()`:

- Add the `*PolicyLive` layer to `bindings()` in [Providers.ts](./alchemy-effect/src/AWS/Providers.ts)
- Re-export from the service's `index.ts`

:::tip
If you need to know what AWS region or account ID the resource is being created/updated in, you can use this inside any of the lifecycle operations.

```ts
const region = yield * Region;
const account = yield * Account;
```

:::

:::warning
You should favor getting the region/account INSIDE the lifecycle operations instead of inside the Layer effect like this because then it's scoped to the resource isntead of the resource provider:

```ts
create: Effect.fn(function* ({ id, news, session }) {
  const region = yield* Region;
  const accountId = yield* Account;
});
```

:::

:::warning
Do not use `Effect.orDie` in the lifecycle operations since this will crash the whole IaC engine.
:::

:::tip
If a Resource supports tags, you should always include the internal Alchemy tags to brand the resource with the app, stage and logical ID so that we can "know" that we created it and are responsible for it.

```ts
create: Effect.fn(function* ({ id, news, session }) {
  const internalTags = yield* createInternalTags(id);
  const userTags = news.tags ?? {};
  const allTags = { ...internalTags, ...userTags };
});
```

:::

:::warning
Do not roll your own tag diffing logic, always use diffTags from [Tags.ts](./alchemy-effect/src/Tags.ts)

```ts
update: Effect.fn(function* ({ id, news, olds, output, session }) {
  const internalTags = yield* createInternalTags(id);
  const newTags = { ...news.tags, ...internalTags };
  const oldTags = { ...olds.tags, ...internalTags };
  // Option 1. use `upsert` if the API expects you to create/update tags in one call
  const { removed, upsert } = diffTags(oldTags, newTags);
  // Option 2. use `added` and `updated` if the API expects you to create/update tags in separate calls
  const { removed, added, updated } = diffTags(oldTags, newTags);
  // Option 3. use `upsert` only if the API doesn't expect you to remove tags (only PUT/UPDATe)
  const { upsert } = diffTags(oldTags, newTags);
```

:::

9. Implement the test cases in `alchemy-effect/test/{Cloud}/{Service}/{Resource}.test.ts`.

Read through the established test cases before continuing so that you understand the pattern and structure of the test cases.

- [S3 Bucket Test Cases](./alchemy-effect/test/AWS/S3/Bucket.test.ts)
- [SQS Queue Test Cases](./alchemy-effect/test/AWS/SQS/Queue.test.ts)
- [Lambda Function Test Cases](./alchemy-effect/test/AWS/Lambda/Function.test.ts)
- [Kinesis Stream Test Cases](./alchemy-effect/test/AWS/Kinesis/Stream.test.ts)
- [DynamoDB Table Test Cases](./alchemy-effect/test/AWS/DynamoDB/Table.test.ts)
- [VPC Test Cases](./alchemy-effect/test/AWS/EC2/Vpc.test.ts)
- [Subnet Test Cases](./alchemy-effect/test/AWS/EC2/Subnet.test.ts)

:::warning
Never use `Date.now()` when constructing the physical name of a resource. You should either:

1. Do not proide a name and rely on the resource provider to generate a unique name for you from the app, stage and logical ID.
2. Construct a deterministic one unique to each test case. But it should be the same on each subsequent run of the test case.
   :::

3. Consider implementing an aggregate Smoke test that brings together multiple resources that are often used together.

See the [VPC Smoke Test](./alchemy-effect/test/AWS/EC2/Vpc.smoke.test.ts) for an example.

11. Write the usage patterns for the Resource in `alchemy-effect/docs/{Cloud}/{Service}/${Resource}.md`.
12. Write the index for the Service in `alchemy-effect/docs/{Cloud}/{Service}/index.md`.

# Spec-Driven Service Bring-Up

Use @processes/AWS.md as the source of truth for bringing a single AWS service from zero to full coverage.

That process covers:

- deriving resources, bindings, event sources, and helpers from distilled
- the audit-driven implementation loop
- deterministic checks for registration and binding test coverage
- Lambda fixture testing conventions
- learned conventions like no auto-marshalling and one `describe("<BindingName>")` block per binding

Keep `AGENTS.md` high-level and update @processes/AWS.md when the process evolves.

When a canonical resource needs mutable event-source configuration and there is any chance of circularity, prefer a resource binding contract over a plain input prop. DynamoDB Streams is the reference case: `Table` owns the actual stream state, while `streams(table)` injects that state via bindings and the runtime-specific layer handles the subscription mechanics. See @processes/AWS.md for the DynamoDB Streams case study.

# Build and Type Checking

Always run type checking before committing changes:

```bash
bun tsc -b
```

This runs the TypeScript compiler in build mode, which checks all projects in the workspace. This is critical because CI will fail if there are type errors.

## Build Commands

| Command           | Description                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `bun tsc -b`      | Type check all projects (always run before committing)                                       |
| `bun run build`   | Clean, type check, and build the alchemy-effect package                                      |
| `bun build:clean` | Full clean rebuild: cleans all artifacts, reinstalls dependencies, builds, and downloads env |

Use `bun build:clean` when you encounter stale build artifacts or dependency issues. It runs:

1. `bun clean .` - Removes all untracked files except .env
2. `bun i` - Reinstalls dependencies
3. `bun run build` - Builds the project
4. `bun download:env` - Downloads environment files
