---
title: Resource
description: The fundamental building block of alchemy-effect — a named entity with input properties and output attributes.
sidebar:
  order: 1
---

A **Resource** is the fundamental building block of alchemy-effect. It
represents a named cloud entity — an S3 Bucket, a DynamoDB Table, a
Cloudflare Worker, etc. — that is configured with **Input Properties**
and produces **Output Attributes**.

## Creating a Resource

Resources are created by yielding them inside an `Effect.gen` block:

```typescript
const bucket =
  yield *
  S3.Bucket("my-bucket", {
    forceDestroy: true,
  });

// bucket.bucketName, bucket.bucketArn, etc. are Output Attributes
```

The first argument is the **Logical ID** — a stable name that
identifies this resource within your Stack. It doesn't change across
creates, updates, or deletes. The second argument is the Input
Properties.

## Lifecycle

Each Resource has a Provider that implements lifecycle operations:

- **Create** — provisions the resource in the cloud provider
- **Update** — applies changes to an existing resource
- **Delete** — removes the resource
- **Diff** — compares new props with old props to determine if an
  update or replacement is needed
- **Read** — refreshes the current state from the cloud provider

All lifecycle operations are designed to be **idempotent** — they can
be safely retried after failures.

## Output Attributes

After a Resource is created or updated, it produces Output Attributes
that you can pass as Input Properties to other Resources:

```typescript
const bucket = yield * S3.Bucket("my-bucket", {});
const fn =
  yield *
  Lambda.Function("my-function", {
    main: "./src/handler.ts",
    // pass an output attribute as an input property
    environment: { BUCKET_NAME: bucket.bucketName },
  });
```

This creates a dependency between the resources — the function depends
on the bucket, so the bucket is created first.

## Physical Names

Resources have a **Physical Name** (e.g. `my-app-prod-my-bucket-abc123`)
that is deterministically generated from the app name, stage, and
logical ID. This ensures idempotent creates — if a create fails
partway through, retrying will find the existing resource by name.

## Tags

Resources that support tags are automatically branded with internal
Alchemy tags (app, stage, logical ID) so the engine can identify
resources it created.
