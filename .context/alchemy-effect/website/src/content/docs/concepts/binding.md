---
title: Binding
description: How resources are connected at deploy time and used at runtime — from Cloudflare's coarse bindings to AWS's granular IAM policies.
sidebar:
  order: 3
---

A **Binding** connects a resource to a runtime host (Worker, Durable
Object, Lambda Function) so it can be used at runtime. Every binding
has two halves:

1. **Binding.Policy** — runs at deploy time to configure the host
   (attach an IAM policy to a Lambda role, or add a binding to a
   Worker's config). Never bundled into the function.
2. **Binding.Service** — provides a typed runtime wrapper that you use
   in your request handlers. Bundled into the function.

You don't interact with these directly — `.bind()` handles both.

## Cloudflare: coarse-grained bindings

On Cloudflare, a single `.bind()` gives you the full resource API.
The policy attaches a native Cloudflare binding (KV, R2, D1, etc.)
to the Worker's config. One binding = full access to every operation
on that resource.

```typescript
const kv = yield * Cloudflare.KVNamespace.bind(MyKV);
// kv has get, put, list, delete, getWithMetadata ...

const bucket = yield * Cloudflare.R2Bucket.bind(MyBucket);
// bucket has get, put, delete, list, head, createMultipartUpload ...

const db = yield * Cloudflare.D1Connection.bind(MyDB);
// db has prepare, batch, dump, exec ...
```

Durable Objects and Containers use the same pattern but with
different entry points:

```typescript
// Durable Object — yield the class to get a namespace handle
const counters = yield * Counter;
const counter = counters.getByName("user-123");
yield * counter.increment();

// Worker-to-Worker RPC
const other = yield * Cloudflare.Worker.bind(OtherWorker);
yield * other.someRpcMethod();

// Container
const sandbox = yield * Cloudflare.Container.bind(Sandbox);
const container = yield * Cloudflare.start(sandbox);
yield * container.exec("echo hi");
```

## AWS: granular IAM-scoped bindings

On AWS, each capability is a separate binding with its own IAM policy
statement. You compose exactly the permissions your function needs —
nothing more.

```typescript
// each .bind() grants one IAM action on one resource
const getItem = yield * DynamoDB.GetItem.bind(table);
const putItem = yield * DynamoDB.PutItem.bind(table);

// use them at runtime
const item = yield * getItem({ Key: { id: { S: "123" } } });
yield * putItem({ Item: { id: { S: "456" }, name: { S: "Alice" } } });
```

Behind the scenes, `GetItem.bind(table)` does two things:

- **Deploy time:** `GetItemPolicy` calls `host.bind` to attach
  `{ Effect: "Allow", Action: "dynamodb:GetItem", Resource: table.tableArn }`
  to the Lambda Function's IAM role
- **Runtime:** `GetItem` service resolves the table name and returns
  a typed function `(request) => Effect<GetItemOutput, GetItemError>`

The same pattern applies across all AWS services:

```typescript
// S3
const getObject = yield * S3.GetObject.bind(bucket);
const putObject = yield * S3.PutObject.bind(bucket);

// SQS
const sendMessage = yield * SQS.SendMessage.bind(queue);

// Kinesis
const putRecord = yield * Kinesis.PutRecord.bind(stream);

// SNS
const publish = yield * SNS.Publish.bind(topic);
```

## Layer wiring

Binding Layers are provided at two levels:

- **`*Live` layers** (e.g. `DynamoDB.GetItemLive`, `S3.PutObjectLive`)
  are provided on the Function's Effect via `Effect.provide`. They
  supply the runtime SDK wrapper and get bundled into the function.
- **`*PolicyLive` layers** (e.g. `GetItemPolicyLive`, `PutObjectPolicyLive`)
  are provided on the Stack via `AWS.providers()`. They run at deploy
  time to attach IAM policies and are never bundled.

```typescript
// Function-level: runtime binding layers
Effect.gen(function* () {
  const getItem = yield* DynamoDB.GetItem.bind(table);
  // ...
}).pipe(
  Effect.provide(Layer.mergeAll(DynamoDB.GetItemLive, DynamoDB.PutItemLive)),
);

// Stack-level: policy layers (handled by AWS.providers())
Alchemy.Stack(
  "MyApp",
  {
    providers: AWS.providers(),
  },
  effect,
);
```

## Circular bindings

Bindings support circular references between resources. Worker A can
bind Worker B and Worker B can bind Worker A. This works because
bindings attach data (policies, env vars) to the host via the Stack —
they don't create direct import dependencies.

To keep bundles small with circular bindings, use the
[modular pattern](/concepts/platform#modular-style) so each
Worker only imports the other's lightweight class, not its full
implementation.

## See also

- [Event Source](/concepts/event-source) — bindings that subscribe a
  function to a stream of events from a resource
- [Sink](/concepts/sink) — bindings that provide batched write access
  to a queue, topic, or stream
