---
title: Sink
description: Bindings that provide batched write access to queues, topics, and streams via Effect's Sink type.
sidebar:
  order: 5
---

A **Sink** is a [binding](/concepts/binding) that provides an Effect
`Sink` for batched writes to a queue, topic, or stream. It composes
naturally with `Stream.run(sink)` to drain a stream of records into
the target resource.

## Using a Sink

Bind the sink in the init phase, then use it with `Stream.run`:

```typescript
const sink = yield * SQS.QueueSink.bind(queue);

// drain a stream into the SQS queue
yield *
  stream.pipe(
    Stream.map((record) => JSON.stringify(record)),
    Stream.run(sink),
  );
```

The sink handles batching automatically — `QueueSink` collects
messages and sends them via `SendMessageBatch`, so you get efficient
batch writes without manual chunking.

## Event Source + Sink

Sinks pair naturally with [event sources](/concepts/event-source).
A common pattern is to subscribe to change events from one resource
and pipe them into another:

```typescript
// subscribe to DynamoDB changes, forward to SQS
const sink = yield * SQS.QueueSink.bind(queue);

yield *
  DynamoDB.stream(table, {
    streamViewType: "NEW_AND_OLD_IMAGES",
    startingPosition: "LATEST",
    batchSize: 10,
  }).process((stream) =>
    stream.pipe(
      Stream.map((record) =>
        JSON.stringify({
          eventName: record.eventName,
          keys: record.dynamodb.Keys,
          newImage: record.dynamodb.NewImage,
        }),
      ),
      Stream.run(sink),
    ),
  );
```

## Available sinks

| Sink                 | Target         | Batch API          |
| -------------------- | -------------- | ------------------ |
| `SQS.QueueSink`      | SQS Queue      | `SendMessageBatch` |
| `SNS.TopicSink`      | SNS Topic      | `PublishBatch`     |
| `Kinesis.StreamSink` | Kinesis Stream | `PutRecords`       |

Each sink accepts strings (SQS, SNS) or structured records (Kinesis)
and handles batching and IAM automatically.

## How it works

Sinks follow the same `Binding.Service` + `Binding.Policy` pattern
as all [bindings](/concepts/binding):

- **`Binding.Service`** (e.g. `QueueSink`) — returns an Effect `Sink`
  built with `Sink.forEachArray` over the batch API. Bundled into
  the function.
- **`Binding.Policy`** (e.g. `QueueSinkPolicy`) — grants the batch
  write IAM permission (e.g. `sqs:SendMessageBatch`). Runs at
  deploy time only.

The Layer wiring mirrors capabilities:

```typescript
// Function-level: sink binding layer
Effect.provide(
  Layer.mergeAll(
    SQS.QueueSinkLive,
    // ...
  ),
);

// Stack-level: policy (handled by AWS.providers())
```

## See also

- [Binding](/concepts/binding) — the underlying mechanism
- [Event Source](/concepts/event-source) — the read-side counterpart
  for subscribing to streams of events
