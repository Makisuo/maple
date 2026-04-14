---
title: What is Alchemy?
description: Learn about alchemy-effect, an Infrastructure-as-Effects framework built on Effect.
---

Alchemy Effect is an Infrastructure-as-Effects (IaE) framework that extends Infrastructure-as-Code (IaC) by combining business logic and infrastructure config into a single, type-safe program expressed as Effects.

## Why Effect?

Effect provides the foundation for type-safe, composable, and testable infrastructure programs. It brings errors into the type system and provides declarative, composable retry logic that ensures proper and reliable handling of failures.

## Key ideas

- **Infrastructure and application logic live together.** No more separate config files and application code — your infrastructure is part of your program.
- **Type-safe errors.** Effect brings errors into the type system so you catch wiring mistakes at compile time, not after a five-minute deploy.
- **Declarative retries.** Cloud APIs are eventually consistent. Effect's retry combinators let you express retry policies declaratively instead of hand-rolling backoff loops.
- **Local emulation.** Run your full stack locally with `alchemy dev` for instant feedback during development.

## How it works

You write a program using Effect generators that yield Resources. Each Resource is a named entity configured with Input Properties that produces Output Attributes.

```typescript
import { Bucket } from "alchemy-effect/AWS/S3";
import { Function } from "alchemy-effect/AWS/Lambda";

const bucket =
  yield *
  Bucket("my-bucket", {
    forceDestroy: true,
  });

const fn =
  yield *
  Function("my-function", {
    handler: myHandler,
  });
```

Resources are deployed, updated, or deleted by the Alchemy engine based on the difference between desired state and current state.
