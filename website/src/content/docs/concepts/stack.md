---
title: Stack
description: The top-level unit of deployment — a named collection of resources deployed together.
sidebar:
  order: 0
---

A **Stack** is the top-level unit of deployment in alchemy-effect. It
groups resources together, provides cloud provider credentials, and
manages the lifecycle of everything inside it.

## Defining a Stack

Every alchemy-effect project has an `alchemy.run.ts` file that exports
a default Stack:

```typescript
import * as Alchemy from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MyApp",
  { providers: Cloudflare.providers() },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2Bucket("Bucket");
    return { url: "https://example.com" };
  }),
);
```

`Alchemy.Stack` takes three arguments:

1. **Name** — a unique identifier for this stack (e.g. `"MyApp"`)
2. **Options** — provider configuration (`providers`)
3. **Effect** — the body of the stack where you create resources

## Stage

Each stack is deployed to a **stage** — an isolated instance like
`dev`, `prod`, or `dev-sam`. The stage is set via the `STAGE`
environment variable or defaults to `dev-{username}`.

Resources are namespaced by stage, so `dev` and `prod` deployments
don't interfere with each other. Physical names include the stage
(e.g. `myapp-dev-bucket-abc123`).

## Providers

The `providers` option configures which cloud providers are available
inside the stack. Each provider supplies credentials, regions, and
resource lifecycle implementations.

```typescript
// Cloudflare only
{ providers: Cloudflare.providers() }

// AWS only
{ providers: AWS.providers()() }

// Both
{
  providers: Layer.mergeAll(
    Cloudflare.providers(),
    AWS.providers()(),
  ),
}
```

## Stack outputs

The value returned from the `Effect.gen` block becomes the stack's
output. It's printed to the console after a successful deploy and can
be used by other tools.

```typescript
Effect.gen(function* () {
  const api = yield* Api;
  const bucket = yield* Cloudflare.R2Bucket("Bucket");

  return {
    url: api.url,
    bucketName: bucket.bucketName,
  };
});
```

## State

Alchemy persists resource state between deploys so it can diff the
desired state against the current state and apply only the necessary
changes. By default, state is stored locally in the `.alchemy/`
directory. For team use, configure a remote state store.

## Commands

| Command                  | Description                       |
| ------------------------ | --------------------------------- |
| `alchemy-effect deploy`  | Create or update all resources    |
| `alchemy-effect destroy` | Delete all resources in the stack |
| `alchemy-effect dev`     | Start local development mode      |
