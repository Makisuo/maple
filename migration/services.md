# Services: `Context.Tag` → `ServiceMap.Service`

In v3, services were defined using `Context.Tag`, `Context.GenericTag`,
`Effect.Tag`, or `Effect.Service`. In v4, all of these have been replaced by
`ServiceMap.Service`.

The underlying data structure has also changed: `Context` has been replaced by
`ServiceMap` — a typed map from service identifiers to their implementations.

## Defining Services

**v3: `Context.GenericTag`**

```ts
import { Context } from "effect"

interface Database {
  readonly query: (sql: string) => string
}

const Database = Context.GenericTag<Database>("Database")
```

**v4: `ServiceMap.Service` (function syntax)**

```ts
import { ServiceMap } from "effect"

interface Database {
  readonly query: (sql: string) => string
}

const Database = ServiceMap.Service<Database>("Database")
```

## Class-Based Services

**v3: `Context.Tag` class syntax**

```ts
import { Context } from "effect"

class Database extends Context.Tag("Database")<Database, {
  readonly query: (sql: string) => string
}>() {}
```

**v4: `ServiceMap.Service` class syntax**

```ts
import { ServiceMap } from "effect"

class Database extends ServiceMap.Service<Database, {
  readonly query: (sql: string) => string
}>()("Database") {}
```

Note the difference in argument order: in v3, the identifier string is passed to
`Context.Tag(id)` before the type parameters. In v4, the type parameters come
first via `ServiceMap.Service<Self, Shape>()` and the identifier string is
passed to the returned constructor `(id)`.

## `Effect.Tag` Accessors → `ServiceMap.Service` with `use`

v3's `Effect.Tag` provided proxy access to service methods as static properties
on the tag class (accessors). This allowed calling service methods directly
without first yielding the service:

```ts
// v3 — static accessor proxy
const program = Notifications.notify("hello")
```

This pattern had significant limitations. The proxy was implemented via mapped
types over the service shape, which meant **generic methods lost their type
parameters**. A service method like `get<T>(key: string): Effect<T>` would
have its generic erased when accessed through the proxy, collapsing to
`get(key: string): Effect<unknown>`. For the same reason, overloaded signatures
were not preserved.

In v4, accessors are removed. The most direct replacement is `Service.use`,
which receives the service instance and runs a callback:

**v3**

```ts
import { Effect } from "effect"

class Notifications extends Effect.Tag("Notifications")<Notifications, {
  readonly notify: (message: string) => Effect.Effect<void>
}>() {}

// Static proxy access
const program = Notifications.notify("hello")
```

**v4 — `use`**

```ts
import { Effect, ServiceMap } from "effect"

class Notifications extends ServiceMap.Service<Notifications, {
  readonly notify: (message: string) => Effect.Effect<void>
}>()("Notifications") {}

// use: access the service and call a method in one step
const program = Notifications.use((n) => n.notify("hello"))
```

`use` takes an effectful callback `(service: Shape) => Effect<A, E, R>` and
returns an `Effect<A, E, R | Identifier>`. `useSync` takes a pure callback
`(service: Shape) => A` and returns an `Effect<A, never, Identifier>`. Both
return Effects — `useSync` just allows the accessor function itself to be
synchronous:

```ts
//      ┌─── Effect<void, never, Notifications>
//      ▼
const program = Notifications.use((n) => n.notify("hello"))

//      ┌─── Effect<number, never, Config>
//      ▼
const port = Config.useSync((c) => c.port)
```

**Prefer `yield*` over `use` in most cases.** While `use` is a convenient
one-liner, it makes it easy to accidentally leak service dependencies into
return values. When you call `use`, the service is available inside the
callback but the dependency is not visible at the call site — making it harder
to track which services your code depends on. Using `yield*` in a generator
makes dependencies explicit and keeps service access co-located with the rest
of your effect logic:

```ts
const program = Effect.gen(function*() {
  const notifications = yield* Notifications
  yield* notifications.notify("hello")
  yield* notifications.notify("world")
})
```

## `Effect.Service` → `ServiceMap.Service` with `make`

v3's `Effect.Service` allowed defining a service with an effectful constructor
and dependencies inline. In v4, use `ServiceMap.Service` with a `make` option.

**v3**

In v3, `Effect.Service` automatically generated a `.Default` layer from the
provided constructor, and wired `dependencies` into it:

```ts
import { Effect, Layer } from "effect"

class Logger extends Effect.Service<Logger>()("Logger", {
  effect: Effect.gen(function*() {
    const config = yield* Config
    return { log: (msg: string) => Effect.log(`[${config.prefix}] ${msg}`) }
  }),
  dependencies: [Config.Default]
}) {}

// Logger.Default is auto-generated: Layer<Logger, never, never>
// (dependencies are already wired in)
const program = Effect.gen(function*() {
  const logger = yield* Logger
  yield* logger.log("hello")
}).pipe(Effect.provide(Logger.Default))
```

**v4**

In v4, `ServiceMap.Service` with `make` stores the constructor effect on the
class but does **not** auto-generate a layer. Define layers explicitly using
`Layer.effect`:

```ts
import { Effect, Layer, ServiceMap } from "effect"

class Logger extends ServiceMap.Service<Logger>()("Logger", {
  make: Effect.gen(function*() {
    const config = yield* Config
    return { log: (msg: string) => Effect.log(`[${config.prefix}] ${msg}`) }
  })
}) {
  // Build the layer yourself from the make effect
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Config.layer)
  )
}
```

The `dependencies` option no longer exists. Wire dependencies via
`Layer.provide` as shown above.

Note: v4 adopts the convention of naming layers with `layer` (e.g.
`Logger.layer`) instead of v3's `Default` or `Live`. Use `layer`
for the primary layer and descriptive suffixes for variants (e.g.
`layerTest`, `layerConfig`).

## References (Services with Defaults)

**v3: `Context.Reference`**

```ts
import { Context } from "effect"

class LogLevel extends Context.Reference<LogLevel>()("LogLevel", {
  defaultValue: () => "info" as const
}) {}
```

**v4: `ServiceMap.Reference`**

```ts
import { ServiceMap } from "effect"

const LogLevel = ServiceMap.Reference<"info" | "warn" | "error">("LogLevel", {
  defaultValue: () => "info" as const
})
```

## Quick Reference

| v3                                    | v4                                         |
| ------------------------------------- | ------------------------------------------ |
| `Context.GenericTag<T>(id)`           | `ServiceMap.Service<T>(id)`                |
| `Context.Tag(id)<Self, Shape>()`      | `ServiceMap.Service<Self, Shape>()(id)`    |
| `Effect.Tag(id)<Self, Shape>()`       | `ServiceMap.Service<Self, Shape>()(id)`    |
| `Effect.Service<Self>()(id, opts)`    | `ServiceMap.Service<Self>()(id, { make })` |
| `Context.Reference<Self>()(id, opts)` | `ServiceMap.Reference<T>(id, opts)`        |
| `Context.make(tag, impl)`             | `ServiceMap.make(tag, impl)`               |
| `Context.get(ctx, tag)`               | `ServiceMap.get(map, tag)`                 |
| `Context.add(ctx, tag, impl)`         | `ServiceMap.add(map, tag, impl)`           |
| `Context.mergeAll(...)`               | `ServiceMap.mergeAll(...)`                 |
