---
title: Platform
description: How Alchemy deploys Workers, Durable Objects, and Containers — async, effect, and layer styles.
sidebar:
  order: 2
---

Workers, Durable Objects, and Containers all share a common `Platform` base. Every Platform follows a two-phase pattern:

```typescript
Effect.gen(function* () {
  // Phase 1 (deploy time): bind resources, resolve dependencies
  const kv = yield* Cloudflare.KVNamespace.bind(MyKV);

  return {
    // Phase 2 (runtime): handlers that run on each request
    fetch: Effect.gen(function* () {
      const value = yield* kv.get("key");
      return HttpServerResponse.text(value ?? "not found");
    }),
  };
});
```

There are three ways to define a Platform resource, from simplest to most flexible:

1. **Async** — plain `async fetch` handler. No Effect runtime in the bundle.
2. **Effect** — Effect implementation passed directly as an argument.
3. **Layer** — class and `.make()` in a single file; Rolldown tree-shakes `.make()` from consumers.

## Async Style

Write a plain async handler and let Alchemy provision and deploy it. Your runtime code is vanilla TypeScript — no Effect runtime is included in the bundle. You still get full IaC for resource provisioning and bindings.

### Defining the resource in your stack

```typescript
// alchemy.run.ts
export const DB = Cloudflare.D1Database("DB");
export const Bucket = Cloudflare.R2Bucket("Bucket");

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export const Worker = Cloudflare.Worker("Worker", {
  main: "./src/worker.ts",
  bindings: {
    DB,
    Bucket,
  },
});
```

The `bindings` prop declares which resources are available to the Worker at runtime. `Cloudflare.InferEnv` extracts the typed `env` object from the bindings so your handler gets full type safety.

### Writing the async handler

```typescript
// src/worker.ts
import type { WorkerEnv } from "../alchemy.run.ts";

export default {
  async fetch(request: Request, env: WorkerEnv) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      const object = await env.Bucket.get(url.pathname);
      return new Response(object?.body ?? null);
    }
    return new Response("Not Found", { status: 404 });
  },
};
```

The same pattern works for AWS Lambda — yield a `Function` resource with `main` pointing at a plain handler file and no Effect implementation.

## Worker Effect

Pass the Effect implementation directly when defining the class. This is the simplest Effect-based approach — everything lives in one file. Alchemy generates a wrapper that sets up the full Effect runtime, wiring up Layers, ConfigProvider, logging, and platform services so your Effect code runs correctly inside the platform.

Use a Worker Effect when the service is standalone or only consumed in one direction (nothing else needs to import it without pulling in its runtime code).

### Worker Effect

```typescript
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.path },
  Effect.gen(function* () {
    // init: bind resources
    const kv = yield* Cloudflare.KVNamespace.bind(MyKV);

    return {
      // runtime: use them
      fetch: Effect.gen(function* () {
        const value = yield* kv.get("key");
        return HttpServerResponse.text(value ?? "not found");
      }),
    };
  }),
) {}
```

### Durable Object Effect

```typescript
export default class Counter extends Cloudflare.DurableObjectNamespace<Counter>()(
  "Counter",
  Effect.gen(function* () {
    // init: bind resources
    const db = yield* Cloudflare.D1Connection.bind(MyDB);

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const count = (yield* state.storage.get<number>("count")) ?? 0;

      return {
        // runtime: use them
        increment: () =>
          Effect.gen(function* () {
            const next = count + 1;
            yield* state.storage.put("count", next);
            return next;
          }),
      };
    });
  }),
) {}
```

### Worker Effect (function call)

You can also skip the class entirely and use a plain function call. This returns an Effect instead of a class — useful for quick prototypes, but you lose the ability to reference it from other Workers or DOs.

```typescript
export const Api = Cloudflare.Worker(
  "Api",
  { main: import.meta.filename },
  Effect.gen(function* () {
    // init: bind resources
    const kv = yield* Cloudflare.KVNamespace.bind(MyKV);

    return {
      // runtime: use them
      fetch: Effect.gen(function* () {
        const value = yield* kv.get("key");
        return HttpServerResponse.text(value ?? "not found");
      }),
    };
  }),
);
```

## Worker Layer

Define the class separately from its `.make()` call in the same file. The class is a lightweight identifier; `.make()` is an `export default` that provides the runtime implementation.

```typescript
// src/WorkerB.ts
export default class WorkerB extends Cloudflare.Worker<
  WorkerB,
  {
    greet: (name: string) => Effect.Effect<string>;
  }
>()("WorkerB", {
  main: import.meta.path,
}) {}

export default WorkerB.make(
  Effect.gen(function* () {
    // init: bind resources
    const kv = yield* Cloudflare.KVNamespace.bind(MyKV);

    return {
      // runtime: use them
      greet: (name: string) =>
        Effect.gen(function* () {
          yield* kv.put("last-greeted", name);
          return `Hello ${name}`;
        }),
    };
  }),
);
```

The second type parameter on the class declares the shape of the RPC methods. This gives callers a fully typed stub without needing to import the implementation.

:::tip
Rolldown treats `.make()` as pure (side-effect-free). When another Worker imports this file to bind it, the bundler removes `.make()` and all its dependencies from the consumer's bundle — so you can keep the class and `.make()` in a single file with no penalty.
:::

### Why this matters: tree-shaking

When WorkerA binds WorkerB, it imports WorkerB's class but never calls `.make()`. Rolldown sees the `.make()` call as pure (side-effect-free) and removes it — along with every dependency it references — from WorkerA's bundle.

This matters most for:

- **Bi-directional bindings** — WorkerA ↔ WorkerB (each calls the other)
- **Shared services** — multiple Workers or DOs bind the same service
- **Heavy runtimes** — Containers with large dependencies (process spawners, ML models, etc.)

### Durable Object Layer

```typescript
// src/Counter.ts
export default class Counter extends Cloudflare.DurableObjectNamespace<Counter>()(
  "Counter",
) {}

export default Counter.make(
  Effect.gen(function* () {
    // init: bind resources
    const db = yield* Cloudflare.D1Connection.bind(MyDB);

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const count = (yield* state.storage.get<number>("count")) ?? 0;

      return {
        // runtime: use them
        increment: () =>
          Effect.gen(function* () {
            const next = count + 1;
            yield* state.storage.put("count", next);
            yield* db
              .prepare("INSERT INTO logs (count) VALUES (?)")
              .bind(next)
              .run();
            return next;
          }),
      };
    });
  }),
);
```

### Container Layer

Containers are the one exception where the class and `.make()` must live in separate files. A Container must be bound to a Durable Object, and the DO imports the class to get a typed handle. If they shared a file, the DO's bundle would pull in all of the container's runtime dependencies (process spawners, Node APIs, SDKs, etc.), bloating the bundle and likely breaking the Workers runtime.

```typescript
// src/Sandbox.ts — class (runs in the DO's bundle)
export class Sandbox extends Cloudflare.Container<
  Sandbox,
  {
    exec: (cmd: string) => Effect.Effect<{ stdout: string }>;
  }
>()("Sandbox", { main: import.meta.filename }) {}
```

```typescript
// src/Sandbox.runtime.ts — .make() (runs inside the container process)
export default Sandbox.make(
  Effect.gen(function* () {
    const cp = yield* ChildProcessSpawner;
    return Sandbox.of({
      exec: (cmd) =>
        cp.spawn(ChildProcess.make(cmd, { shell: true })).pipe(
          Effect.map(({ stdout }) => ({ stdout })),
          Effect.scoped,
        ),
    });
  }),
);
```

## Binding a Layer

The caller imports the class. The bundler tree-shakes `.make()` and its dependencies away.

```typescript
// src/WorkerA.ts
import WorkerB from "./WorkerB.ts";

export default class WorkerA extends Cloudflare.Worker<WorkerA>()(
  "WorkerA",
  { main: import.meta.path },
  Effect.gen(function* () {
    const b = yield* Cloudflare.Worker.bind(WorkerB);

    return {
      fetch: Effect.gen(function* () {
        const greeting = yield* b.greet("world");
        return HttpServerResponse.text(greeting);
      }),
    };
  }),
) {}
```

The same pattern works for Durable Objects and Containers:

```typescript
// Binding a DO
const counters = yield * Counter;
const counter = counters.getByName("user-123");
yield * counter.increment();

// Binding a Container
const sandbox = yield * Cloudflare.Container.bind(Sandbox);
const container = yield * Cloudflare.start(sandbox);
yield * container.exec("echo hi");
```

## When to Use Which

| Scenario                               | Style                                 |
| -------------------------------------- | ------------------------------------- |
| Plain async handler, no Effect runtime | Async                                 |
| Quick prototype or script              | Effect (function call)                |
| Standalone Worker, nothing imports it  | Effect                                |
| Worker → DO (one direction)            | Either works; Effect is simpler       |
| WorkerA ↔ WorkerB (bi-directional)     | Layer (bundler tree-shakes `.make()`) |
| Multiple Workers bind the same DO      | Layer (shared class, one `.make()`)   |
| Container (always separate process)    | Layer (required by design)            |
