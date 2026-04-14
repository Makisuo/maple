---
title: Event Source
description: How functions subscribe to streams of events from resources like DynamoDB, SQS, S3, SNS, and EventBridge.
sidebar:
  order: 4
---

An **Event Source** binds a resource that produces events to a function
that processes them. When records appear in a DynamoDB stream, messages
land in an SQS queue, or objects are created in an S3 bucket, your
function is invoked with a typed `Stream` of those records.

## The two-layer pattern

Event sources are split into two layers:

1. **Service-level abstraction** — declares "I want to process events
   from this resource" and provides a typed `Stream` of records. Lives
   in the service package (e.g. `AWS/DynamoDB/Stream.ts`,
   `AWS/SQS/QueueEventSource.ts`).

2. **Platform implementation** — wires the actual event source mapping,
   IAM policies, and any resource configuration (like enabling
   DynamoDB Streams). Provided as a Layer on the function
   (e.g. `Lambda.TableEventSource`).

This split means the same event source declaration works across
different runtimes. The service layer defines _what_ you want; the
platform layer handles _how_ it gets wired.

## DynamoDB Streams

Subscribe to change records from a DynamoDB table:

```typescript
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

Behind the scenes:

- `DynamoDB.stream()` calls `TableEventSource.bind(table, props, processFn)`
- At deploy time, `TableEventSourcePolicy` enables DynamoDB Streams
  on the table, grants stream read IAM permissions
  (`dynamodb:GetRecords`, `GetShardIterator`, `DescribeStream`,
  `ListStreams`), and creates a `Lambda.EventSourceMapping`
- At runtime, Lambda invokes the function with DynamoDB stream
  records. The event source Layer filters records by stream ARN and
  pipes them into the user's `Stream`

The Layer must be provided on the function:

```typescript
Effect.provide(
  Layer.mergeAll(
    Lambda.TableEventSource,
    // ...other layers
  ),
);
```

## SQS Messages

Subscribe to messages from an SQS queue:

```typescript
yield *
  SQS.messages(queue, {
    batchSize: 10,
  }).subscribe((stream) =>
    stream.pipe(
      Stream.mapEffect((record) => Effect.log(`Received: ${record.body}`)),
      Stream.runDrain,
    ),
  );
```

Same pattern: `SQS.messages()` is the service-level abstraction;
`Lambda.QueueEventSource` is the platform Layer that creates the
event source mapping and grants `sqs:ReceiveMessage`,
`sqs:DeleteMessage`, and `sqs:GetQueueAttributes` IAM.

## Other event sources

| Resource    | Helper                 | Platform Layer                  | Record type          |
| ----------- | ---------------------- | ------------------------------- | -------------------- |
| DynamoDB    | `DynamoDB.stream()`    | `Lambda.TableEventSource`       | `StreamRecord`       |
| SQS         | `SQS.messages()`       | `Lambda.QueueEventSource`       | `SQSRecord`          |
| S3          | `S3.notifications()`   | `Lambda.BucketEventSource`      | S3 event record      |
| SNS         | `SNS.notifications()`  | `Lambda.TopicEventSource`       | `TopicNotification`  |
| Kinesis     | `Kinesis.records()`    | `Lambda.StreamEventSource`      | `KinesisEventRecord` |
| EventBridge | `EventBridge.events()` | `Lambda.EventBridgeEventSource` | `EventRecord`        |

All follow the same two-layer pattern: a service-level helper that
takes a resource and returns `{ process() }` or `{ subscribe() }`,
and a platform Layer that handles the deployment wiring.

## See also

- [Binding](/concepts/binding) — the underlying mechanism that event
  sources build on
- [Sink](/concepts/sink) — the write-side counterpart for draining
  streams into queues, topics, or Kinesis streams
