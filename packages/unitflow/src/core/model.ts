import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { Equal } from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import type { Pipeable } from "effect/Pipeable";
import * as RcMap from "effect/RcMap";
import * as Scope from "effect/Scope";
import { namePorts } from "./debug/naming.js";
import * as Event from "./event.js";
import * as Flatten from "./internals.js";
import {
  defaultIdleTimeToLive,
  type InstanceKey,
  InstanceScope,
  instanceKey,
  leaseCount,
  Registry,
  releaseLease,
  trackLease,
} from "./registry.js";
import * as Store from "./store.js";

type SinkPort = Store.Sink<any> | Event.Sink<any>;

type SourcePort = Store.Source<any> | Event.Source<any>;

/** Nested unit ports republished in `ui` for the View to hand to child Views. */
export interface UnitPorts {
  readonly inputs: Record<string, unknown>;
  readonly outputs: Record<string, unknown>;
  readonly ui: Record<string, unknown>;
}

/**
 * What a model's `make` must return at minimum: `inputs` hold only
 * sink-capable ports, `outputs` only source-capable ones (a full `Event`
 * qualifies — it is both, and the `ui` narrowing turns it into a `Sink` for
 * the View to fire). A bare `Sink` cannot be republished in `outputs`, and a
 * source-only port (e.g. a combined store) cannot be an input. `ui`
 * additionally accepts event sinks (a mutation's `run` is typed sink-only):
 * the View fires them exactly like events. Store sinks stay rejected
 * everywhere but `inputs`.
 *
 * `ui` is optional: a headless model — a service other models resolve — has
 * no View surface and returns only `inputs`/`outputs`. `View.make` requires a
 * {@link Viewable} model, so binding a headless model to a View fails to
 * compile.
 *
 * Beyond the base sections, a shape may carry any number of EXTRA sections
 * (named by audience, e.g. `analytics`): read-only observation surfaces held
 * to the same rule as `outputs` (see {@link Sections}) and invisible to the
 * View — only other models resolving the unit see them.
 */
export interface Shape {
  readonly inputs: Record<string, SinkPort>;
  readonly outputs: Record<string, SourcePort>;
  readonly ui?: Record<string, SourcePort | Event.Sink<any> | UnitPorts>;
}

/**
 * The capability rule of one shape section, by name: `inputs` accept sinks,
 * `ui` the View surface, and every other section — `outputs` and any extra
 * observation section alike — source-capable ports only.
 */
type Section<K> = Record<
  string,
  K extends "inputs"
    ? SinkPort
    : K extends "ui"
      ? SourcePort | Event.Sink<any> | UnitPorts
      : SourcePort
>;

/** Holds EVERY section of a make-return shape — extras included — to its
 * {@link Section} rule; {@link Shape} (the `make` constraint proper) keeps
 * the three base sections required. */
type Sections<A> = { readonly [K in keyof A]: Section<K> };

export interface Accessor<Key, A extends Shape, E> {
  readonly get: (...args: KeyArgs<Key>) => Effect.Effect<A, E>;
  readonly dispose: (...args: KeyArgs<Key>) => Effect.Effect<void>;
}

export interface Type<Key, A extends Shape, E, R> {
  readonly key: () => Key;
  readonly shape: () => A;
  readonly error: () => E;
  readonly services: () => R;
}

/** Primitives that may key a model directly or appear as a record key's fields. */
type KeyPrimitive = string | number | boolean;

/**
 * Validates a key wherever one enters the system — `Model.get`/`dispose` (via
 * {@link KeyArgs}) and a {@link List}'s `push`/`insert`/`get`/`remove`: a
 * primitive, an already-`Equal` key object (or a
 * `Data.Class` instance — `Pipeable` is its v4 type-level marker), or a FLAT
 * record of primitives (tagged-enum members qualify). Anything else — notably
 * a record with a nested object field — collapses to `never`, so the call
 * fails to compile: keys are identifiers, flat by contract. In v4 plain
 * records natively carry deep structural `Equal`/`Hash` semantics, so a raw
 * flat literal keys an instance directly; keys must not be mutated after use
 * (`Equal` caches comparisons per object pair).
 */
export type KeyInput<Key> = [Key] extends [KeyPrimitive]
  ? Key
  : [Key] extends [Equal | Pipeable]
    ? Key
    : // The `object` guard keeps non-object keys (notably a singleton's `void`)
      // out of the flat-record check: a homomorphic mapped type over a
      // non-object generic resolves to the type itself, which would make the
      // check vacuously true.
      Key extends object
      ? Key extends { readonly [P in keyof Key]: KeyPrimitive }
        ? Key
        : never
      : never;

export interface ServiceClass<
  Self,
  Id extends string,
  Key,
  A extends Shape,
  E,
  R,
> extends Context.ServiceClass<Self, Id, Accessor<Key, A, E>> {
  readonly layer: Layer.Layer<Self, E, Exclude<R, InstanceScope | Scope.Scope> | Registry>;
  readonly modelKey: Id;
  readonly modelMake: (key: Key) => Effect.Effect<A, E, R>;
  readonly modelType: Type<Key, A, E, R>;
}

export type AnyService = Context.Service<any, any> & {
  readonly modelKey: string;
  readonly modelType: Type<any, Shape, any, any>;
};

/** A {@link Shape} whose `ui` section is present: what a View can bind. */
export interface ViewableShape extends Shape {
  readonly ui: Record<string, SourcePort | Event.Sink<any> | UnitPorts>;
}

/** A model whose shape exposes a `ui` section — the bound `View.make`
 * requires. Headless models (`inputs`/`outputs` only) do not satisfy it. */
export type Viewable = AnyService & {
  readonly modelType: Type<any, ViewableShape, any, any>;
};

type AnyEffect = Effect.Effect<Shape, unknown, unknown>;

/** A key argument list validated by {@link KeyInput}: singleton models take
 * no key, keyed models require one of a valid flat shape. */
export type KeyArgs<Key> = [Key] extends [void]
  ? readonly [key?: void]
  : readonly [key: KeyInput<Key>];

/**
 * How long an instance outlives its last lease. `{ idleTimeToLive }` starts
 * an idle clock when the last holder releases the instance — a re-`get`
 * within the window reuses it (state survives), the clock running out
 * disposes it. `"keepAlive"` never collects: the instance lives until
 * `Model.dispose` or registry shutdown. Defaults: keyed models idle out
 * after 10 minutes, singletons are keepAlive.
 */
export type Lifetime = "keepAlive" | { readonly idleTimeToLive: Duration.Input };

const lifetimeDuration = (
  lifetime: Lifetime | undefined,
  fallback: Duration.Duration,
): Duration.Duration => {
  if (lifetime === undefined) return fallback;
  if (lifetime === "keepAlive") return Duration.infinity;
  return Duration.fromInputUnsafe(lifetime.idleTimeToLive);
};

/** The second signature `make` must satisfy: `Make`'s own bound (via
 * {@link AnyEffect}) keeps the three base sections required, this one holds
 * every section the returned shape actually has — extras included — to its
 * capability rule. */
type ValidatedShape<Ret extends AnyEffect> = Effect.Effect<
  Sections<Effect.Success<Ret>>,
  unknown,
  unknown
>;

type SingletonOptions<Make extends () => AnyEffect> = {
  readonly make: Make & (() => ValidatedShape<ReturnType<Make>>);
  readonly lifetime?: Lifetime;
};

type KeyedOptions<Key, Make extends (key: Key) => AnyEffect> = {
  readonly make: Make & ((key: Key) => ValidatedShape<ReturnType<Make>>);
  readonly lifetime?: Lifetime;
};

type SingletonService<Self, Id extends string, Make extends () => AnyEffect> = ServiceClass<
  Self,
  Id,
  void,
  Effect.Success<ReturnType<Make>>,
  Effect.Error<ReturnType<Make>>,
  Effect.Services<ReturnType<Make>>
>;

type KeyedService<
  Self,
  Id extends string,
  Key,
  Make extends (key: Key) => AnyEffect,
> = ServiceClass<
  Self,
  Id,
  Key,
  Effect.Success<ReturnType<Make>>,
  Effect.Error<ReturnType<Make>>,
  Effect.Services<ReturnType<Make>>
>;

export interface Builder<Self, Id extends string> {
  <Make extends () => AnyEffect>(options: SingletonOptions<Make>): SingletonService<Self, Id, Make>;
  <Key>(): <Make extends (key: Key) => AnyEffect>(
    options: KeyedOptions<Key, Make>,
  ) => KeyedService<Self, Id, Key, Make>;
}

export type KeyOf<M extends AnyService> = ReturnType<M["modelType"]["key"]>;

export type ShapeOf<M extends AnyService> = ReturnType<M["modelType"]["shape"]>;

export type ErrorOf<M extends AnyService> = ReturnType<M["modelType"]["error"]>;

export type ServicesOf<M extends AnyService> = ReturnType<M["modelType"]["services"]>;

type NarrowInput<T> =
  T extends Store.Store<infer A>
    ? Store.Sink<A>
    : T extends Event.Event<infer A>
      ? Event.Sink<A>
      : T;

type NarrowOutput<T> =
  T extends Store.Store<infer A>
    ? Store.Source<A>
    : T extends Event.Event<infer A>
      ? Event.Source<A>
      : T;

type NarrowUi<T> =
  T extends Store.Store<infer A>
    ? Store.Source<A>
    : T extends Event.Event<infer A>
      ? Event.Sink<A>
      : T;

/**
 * What everyone but the owning model sees: `inputs` are write-only sinks,
 * `ui` is read state + fire events, and every other section — `outputs` and
 * any extra observation section — read-only sources. The full descriptors
 * stay private in the model's `make` closure — the port system is a type
 * guarantee, not a lint rule.
 */
export type Ports<A extends Shape> = {
  readonly [S in keyof A]: S extends "inputs"
    ? { readonly [K in keyof A[S]]: NarrowInput<A[S][K]> }
    : S extends "ui"
      ? { readonly [K in keyof A[S]]: NarrowUi<A[S][K]> }
      : { readonly [K in keyof A[S]]: NarrowOutput<A[S][K]> };
};

export type PortsOf<M extends AnyService> = Ports<ShapeOf<M>>;

export type ListItem<M extends AnyService> = PortsOf<M> & {
  readonly key: KeyInput<KeyOf<M>>;
};

const typeWitness = <A>(): A => {
  throw new Error("Unitflow type witness should never be called.");
};

/** Eagerly materialize every store/event the shape exposes so their registry
 * entries are owned by the instance scope and are removed on dispose. Combined
 * stores/events have no state of their own — their sources are materialized
 * instead (a private store exposed only through a combined port still belongs
 * to the instance). */
const materializeValue = (value: unknown): Effect.Effect<void, never, Registry | InstanceScope> => {
  if (Store.isCombined(value)) {
    return Effect.forEach(Store.sourcesOf(value), materializeValue, { discard: true });
  }
  if (Flatten.isFlatten(value)) return materializeValue(Flatten.stateOf(value).source);
  if (Event.isCombined(value)) {
    return Effect.forEach(Event.sourcesOf(value), materializeValue, { discard: true });
  }
  if (Event.isSetter(value)) return materializeValue(Event.targetOf(value));
  if (Store.isStore(value)) return Effect.asVoid(Store.ref(value));
  if (Event.isEvent(value)) return Effect.asVoid(Event.pubsub(value));
  return Effect.void;
};

const materialize = (shape: Shape): Effect.Effect<void, never, Registry | InstanceScope> =>
  Effect.forEach(
    // Every section, extras included: an extra section's ports must belong to
    // the instance scope exactly like `outputs`.
    Object.values(shape).flatMap((section) => Object.values(section)),
    materializeValue,
    { discard: true },
  );

const makeAccessor = <Key, A extends Shape, E, R>(
  modelKey: string,
  make: (key: Key) => Effect.Effect<A, E, R>,
  context: Context.Context<R | Registry>,
  lifetime: Duration.Duration,
): Accessor<Key, A, E> => {
  const registry = Context.get(context, Registry);

  // `KeyArgs<Key>` is conditional: singleton models allow no key while keyed
  // models require one. The runtime representation is still always args[0].
  // eslint-disable-next-line revizo/no-type-assertion
  const keyOf = (args: KeyArgs<Key>): Key => args[0] as Key;

  const construct = (mapKey: InstanceKey, key: Key): Effect.Effect<A, E, Scope.Scope> =>
    Effect.gen(function* () {
      // The ambient scope here is the RcMap entry's scope: closed when the
      // last lease is released (after the model's idle TTL) or when the
      // registry shuts down. The instance scope proper is forked from it so
      // `dispose` can close it deterministically even while leases are still
      // outstanding.
      const entryScope = yield* Effect.scope;
      const scope = Scope.forkUnsafe(entryScope);
      MutableHashMap.set(registry.instanceScopes, mapKey, scope);
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          const current = MutableHashMap.get(registry.instanceScopes, mapKey);
          if (Option.isSome(current) && current.value === scope) {
            MutableHashMap.remove(registry.instanceScopes, mapKey);
          }
        }),
      );
      // `InstanceScope` keys pipelines and store/event cleanup to the
      // instance; providing it as the plain `Scope` too makes it the AMBIENT
      // scope of `make` — `Model.get` there leases the child in the parent's
      // scope, and `Effect.addFinalizer`/`acquireRelease` register
      // instance-lifetime cleanup.
      const instanceContext = Context.add(
        Context.add(context, InstanceScope, scope),
        Scope.Scope,
        scope,
      );
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => registry.debug?.instance(mapKey, "disposed")),
      );
      return yield* make(key).pipe(
        Effect.tap((shape) =>
          Effect.sync(() => {
            namePorts(shape, modelKey, key, registry.debug);
            registry.debug?.instance(mapKey, "created");
          }),
        ),
        Effect.tap(materialize),
        Effect.provideContext(instanceContext),
        // Failures are not cached: drop the entry BEFORE waiters wake — a
        // later `get` retries the construction — and release whatever the
        // partial make created.
        Effect.onError((cause) =>
          Effect.flatMap(RcMap.invalidate(registry.instances, mapKey), () =>
            Scope.close(scope, Exit.failCause(cause)),
          ),
        ),
      );
    });

  registry.lifetimes.set(modelKey, lifetime);
  // The instance map's key carries the model id plus the key this accessor's
  // `get` stored there; the constructor re-narrows it.
  // eslint-disable-next-line revizo/no-type-assertion
  registry.constructors.set(modelKey, (mapKey) => construct(mapKey, mapKey.key as Key));

  const get: Accessor<Key, A, E>["get"] = (...args) =>
    Effect.flatMap(Effect.serviceOption(Scope.Scope), (ambient) =>
      Effect.suspend(() => {
        const mapKey = instanceKey(modelKey, keyOf(args));
        // The lease lives in the caller's ambient scope — a resolving parent's
        // instance scope, a React binding's scope, a test's `it.effect` scope —
        // and falls back to the registry scope (an app-lifetime lease) when
        // none exists. The RcMap inserts the entry synchronously under an
        // uninterruptible mask, so concurrent `get`s of one key converge on a
        // single construction, which runs on its own fiber in the entry scope:
        // an interrupted caller does not interrupt the shared instance.
        return Scope.provide(
          RcMap.get(registry.instances, mapKey).pipe(
            // Mirror the lease in the registry's counter (the RcMap exposes
            // no refcounts): count in now, count out when the leasing scope
            // closes. `Model.list` consults the count on removal to dispose
            // a child only when this was its last holder.
            Effect.tap(() =>
              Effect.uninterruptible(
                Effect.flatMap(
                  Effect.sync(() => trackLease(registry, mapKey)),
                  () =>
                    Effect.addFinalizer(() => Effect.sync(() => releaseLease(registry, mapKey))),
                ),
              ),
            ),
          ),
          Option.getOrElse(ambient, () => registry.scope),
        );
      }),
    );

  const dispose: Accessor<Key, A, E>["dispose"] = (...args) =>
    Effect.suspend(() => {
      const mapKey = instanceKey(modelKey, keyOf(args));
      const scope = MutableHashMap.get(registry.instanceScopes, mapKey);
      // Invalidate first so a concurrent `get` already constructs a fresh
      // instance, then force-close the instance scope: dispose is
      // deterministic even while other holders still lease the instance
      // (their ports simply go inert, releasing later is a no-op).
      return Effect.flatMap(RcMap.invalidate(registry.instances, mapKey), () =>
        Option.isSome(scope) ? Scope.close(scope.value, Exit.void) : Effect.void,
      );
    });

  return { get, dispose };
};

const define = <Self, Id extends string, Key, A extends Shape, E, R>(
  id: Id,
  make: (key: Key) => Effect.Effect<A, E, R>,
  lifetime: Duration.Duration,
): ServiceClass<Self, Id, Key, A, E, R> => {
  const service = Context.Service<Self, Accessor<Key, A, E>>()(id);

  return Object.assign(service, {
    layer: Layer.effect(
      service,
      Effect.context<Exclude<R, InstanceScope | Scope.Scope> | Registry>().pipe(
        Effect.map((context) =>
          // `construct` adds `InstanceScope` and the ambient `Scope` to the
          // context before running `make`, so a make that uses them (directly
          // or via `Model.list`/`Effect.addFinalizer`) must not surface them
          // as layer requirements.
          // eslint-disable-next-line revizo/no-type-assertion
          makeAccessor(id, make, context as Context.Context<R | Registry>, lifetime),
        ),
      ),
    ),
    modelKey: id,
    modelMake: make,
    modelType: {
      key: typeWitness<Key>,
      shape: typeWitness<A>,
      error: typeWitness<E>,
      services: typeWitness<R>,
    },
  });
};

export const Service =
  <Self>() =>
  <const Id extends string>(id: Id): Builder<Self, Id> => {
    // The runtime builder has two call shapes: singleton options directly, or
    // `<Key>()(options)` for keyed models. TypeScript can't express that
    // implementation without one boundary cast.
    // eslint-disable-next-line revizo/no-type-assertion
    const builder = ((options?: SingletonOptions<() => AnyEffect>) => {
      if (options === undefined) {
        return <Key, Make extends (key: Key) => AnyEffect>(keyedOptions: KeyedOptions<Key, Make>) =>
          define(
            id,
            keyedOptions.make,
            lifetimeDuration(keyedOptions.lifetime, defaultIdleTimeToLive),
          );
      }

      return define<
        Self,
        Id,
        void,
        Effect.Success<ReturnType<typeof options.make>>,
        Effect.Error<ReturnType<typeof options.make>>,
        Effect.Services<ReturnType<typeof options.make>>
      >(id, () => options.make(), lifetimeDuration(options.lifetime, Duration.infinity));
    }) as Builder<Self, Id>;

    return builder;
  };

/** Resolve a model instance's public ports, LEASING the instance in the
 * caller's ambient `Scope` — a resolving parent's instance scope inside
 * `make`, a React binding's scope, a test's `it.effect` scope (the registry
 * scope when no ambient scope exists). The instance is shared by all holders
 * and constructed once; when the last lease is released, the model's
 * `lifetime` policy decides how long it survives before disposal. */
export const get = <M extends AnyService>(
  model: M,
  ...args: KeyArgs<KeyOf<M>>
): Effect.Effect<PortsOf<M>, ErrorOf<M>, Context.Service.Identifier<M>> =>
  // Narrowing the shape to capability ports is a type-level operation over
  // the same runtime value; TypeScript cannot reduce `Ports<A>` for an
  // unresolved generic `A`, hence the one boundary cast.
  // eslint-disable-next-line revizo/no-type-assertion
  Effect.flatMap(model, (accessor) => accessor.get(...args)) as Effect.Effect<
    PortsOf<M>,
    ErrorOf<M>,
    Context.Service.Identifier<M>
  >;

/** The manual override over the lease machinery: close a model instance NOW —
 * interrupt its pipelines and remove its stores, events, and the instance
 * itself from the registry, even while other holders still lease it (their
 * ports go inert). A later `get` with the same key constructs a fresh
 * instance. */
export const dispose = <M extends AnyService>(
  model: M,
  ...args: KeyArgs<KeyOf<M>>
): Effect.Effect<void, never, Context.Service.Identifier<M>> =>
  Effect.flatMap(model, (accessor) => accessor.dispose(...args));

/** A dynamic owned collection of keyed child model instances — see {@link list}. */
export interface List<M extends AnyService> {
  /** The children's public ports, paired with their list keys, in list order. */
  readonly items: Store.Source<ReadonlyArray<ListItem<M>>>;
  /** One inner store picked per child, collapsed into ONE store whose value
   * is the array of their current values: recomputes and re-subscribes when
   * the composition changes, re-emits when any picked store changes, and
   * never re-emits for a removed child's stores. An empty list is `[]`. */
  readonly select: <A>(
    pick: (item: ListItem<M>) => Store.Source<A>,
  ) => Store.Source<ReadonlyArray<A>>;
  /** Look up an existing child by key. */
  readonly get: (
    key: KeyInput<KeyOf<M>>,
  ) => Effect.Effect<Option.Option<PortsOf<M>>, never, Registry>;
  /** Construct the child (if new) and append it; pushing an existing key
   * returns its ports without moving it. */
  readonly push: (key: KeyInput<KeyOf<M>>) => Effect.Effect<PortsOf<M>, ErrorOf<M>, Registry>;
  /** {@link push} at an index instead of the end — same idempotency rule. */
  readonly insert: (
    index: number,
    key: KeyInput<KeyOf<M>>,
  ) => Effect.Effect<PortsOf<M>, ErrorOf<M>, Registry>;
  /** Drop the child from the list and release THIS list's ownership of it:
   * the child is disposed immediately when the list was its last holder,
   * and lives on untouched for any remaining holder. No-op if absent. */
  readonly remove: (key: KeyInput<KeyOf<M>>) => Effect.Effect<void, never, Registry>;
  /** {@link remove} every child, leaving the list empty. */
  readonly clear: Effect.Effect<void, never, Registry>;
}

interface ListEntry<M extends AnyService> {
  readonly key: KeyInput<KeyOf<M>>;
  readonly ports: PortsOf<M>;
  readonly item: ListItem<M>;
  /** The child's lease sub-scope, forked from the list's instance scope:
   * closing it releases this list's ownership of the child. */
  readonly scope: Scope.Closeable;
}

/**
 * A dynamic owned collection of keyed child model instances, yieldable inside
 * a model's `make`:
 *
 * ```ts
 * const photos = yield* Model.list(PendingPhotoModel);
 * ```
 *
 * The list owns its children's LEASES, each held in a dedicated sub-scope
 * forked from the list's instance scope: `remove`/`clear` (and the parent
 * instance's disposal, which closes every sub-scope) release this list's
 * ownership, disposing a child immediately — TTL notwithstanding — only when
 * no other holder remains. Key collisions across owners are therefore safe
 * sharing: another list (or an outside `Model.get` lease) keeps the child
 * fully alive. Construction goes through the child model's accessor, so
 * children share the registry's memoization and cleanup machinery — a
 * construction failure fails `push`/`insert` and leaves the list unchanged.
 */
export const list = <M extends AnyService>(
  model: M,
): Effect.Effect<List<M>, never, Registry | InstanceScope | Context.Service.Identifier<M>> =>
  Effect.gen(function* () {
    const accessor: Accessor<KeyOf<M>, ShapeOf<M>, ErrorOf<M>> = yield* model;
    const registry = yield* Registry;
    const instanceScope = yield* InstanceScope;

    const items = Store.make<ReadonlyArray<ListItem<M>>>([]);
    // The backing ref must belong to the parent instance even when no port
    // republishes `items` — materialize it while the instance scope is in
    // context.
    yield* Store.ref(items);

    /** Insertion order; `items` is always published from this snapshot. */
    let entries: ReadonlyArray<ListEntry<M>> = [];
    /** Structural child lookup — the same keying discipline as the registry's
     * instance map, so a raw flat literal addresses an existing child. */
    const byKey = MutableHashMap.empty<KeyInput<KeyOf<M>>, ListEntry<M>>();

    // `KeyArgs<Key>` is conditional over the key type; the runtime call shape
    // is always a single key argument (see `makeAccessor`).
    // eslint-disable-next-line revizo/no-type-assertion
    const keyArgsOf = (key: KeyInput<KeyOf<M>>): KeyArgs<KeyOf<M>> => [key] as KeyArgs<KeyOf<M>>;

    const construct = (key: KeyInput<KeyOf<M>>): Effect.Effect<ListEntry<M>, ErrorOf<M>> =>
      Effect.suspend(() => {
        // The child's lease lives in a DEDICATED sub-scope forked from the
        // list's instance scope, regardless of which fiber pushed it — the
        // parent-dispose cascade still closes every sub-scope, while `remove`
        // and `clear` can release just this child's lease.
        const scope = Scope.forkUnsafe(instanceScope);
        const mapKey = instanceKey(model.modelKey, key);
        // Sole-owner cleanup, run AFTER the sub-scope released the lease
        // (finalizers close in reverse order): a child no other holder leases
        // is disposed immediately — removal and parent-dispose stay
        // deterministic, no idle TTL lingering — while a shared child lives
        // on for its remaining holders.
        return Scope.addFinalizer(
          scope,
          Effect.suspend(() =>
            leaseCount(registry, mapKey) === 0 ? accessor.dispose(...keyArgsOf(key)) : Effect.void,
          ),
        ).pipe(
          Effect.flatMap(
            () =>
              // Narrowing the shape to capability ports is a type-level
              // operation over the same runtime value (see `Model.get`).
              // eslint-disable-next-line revizo/no-type-assertion
              Scope.provide(accessor.get(...keyArgsOf(key)), scope) as Effect.Effect<
                PortsOf<M>,
                ErrorOf<M>
              >,
          ),
          Effect.map((ports): ListEntry<M> => ({
            key,
            ports,
            item: { ...ports, key },
            scope,
          })),
          // A failed construction releases the sub-scope so nothing dangles
          // off the instance scope (the accessor already invalidated the
          // entry before failing).
          Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
        );
      });

    const publish = (): Effect.Effect<void, never, Registry> =>
      Store.set(
        items,
        entries.map((entry) => entry.item),
      );

    const insertAt = (
      index: number,
      key: KeyInput<KeyOf<M>>,
    ): Effect.Effect<PortsOf<M>, ErrorOf<M>, Registry> =>
      // Uninterruptible so the entry map and `items` always update as one.
      Effect.uninterruptible(
        Effect.suspend(() => {
          const existing = MutableHashMap.get(byKey, key);
          if (Option.isSome(existing)) return Effect.succeed(existing.value.ports);
          return construct(key).pipe(
            Effect.flatMap((entry) =>
              Effect.suspend(() => {
                // A concurrent push of the same key raced us to the entry
                // (construction converges on one instance): keep its position
                // and release our redundant second lease — the raced entry's
                // own lease keeps the child alive through the sub-scope's
                // sole-owner check.
                const raced = MutableHashMap.get(byKey, key);
                if (Option.isSome(raced)) {
                  return Effect.as(Scope.close(entry.scope, Exit.void), raced.value.ports);
                }
                MutableHashMap.set(byKey, key, entry);
                const at = Math.max(0, Math.min(index, entries.length));
                entries = [...entries.slice(0, at), entry, ...entries.slice(at)];
                return Effect.as(publish(), entry.ports);
              }),
            ),
          );
        }),
      );

    const remove = (key: KeyInput<KeyOf<M>>): Effect.Effect<void, never, Registry> =>
      Effect.uninterruptible(
        Effect.suspend(() => {
          const entry = MutableHashMap.get(byKey, key);
          if (Option.isNone(entry)) return Effect.void;
          MutableHashMap.remove(byKey, key);
          entries = entries.filter((current) => current !== entry.value);
          // Publish the new composition first so `select` pipelines switch
          // away before a sole-owned child's stores are shut down. Closing
          // the sub-scope releases this list's lease; the sub-scope's
          // finalizer then disposes the child only if no holder remains.
          return Effect.flatMap(publish(), () => Scope.close(entry.value.scope, Exit.void));
        }),
      );

    const clear: Effect.Effect<void, never, Registry> = Effect.uninterruptible(
      Effect.suspend(() => {
        const removed = entries;
        MutableHashMap.clear(byKey);
        entries = [];
        return Effect.flatMap(publish(), () =>
          Effect.forEach(removed, (entry) => Scope.close(entry.scope, Exit.void), {
            discard: true,
          }),
        );
      }),
    );

    // No explicit parent-dispose finalizer: every child's sub-scope is forked
    // from the list's instance scope, so disposing the parent closes them all
    // — releasing the leases and immediately disposing sole-owned children
    // via each sub-scope's own finalizer.

    return {
      items,
      select: <A>(pick: (item: ListItem<M>) => Store.Source<A>): Store.Source<ReadonlyArray<A>> =>
        Flatten.make(items, pick),
      get: (key: KeyInput<KeyOf<M>>) =>
        Effect.sync(() => Option.map(MutableHashMap.get(byKey, key), (entry) => entry.ports)),
      push: (key: KeyInput<KeyOf<M>>) => Effect.suspend(() => insertAt(entries.length, key)),
      insert: insertAt,
      remove,
      clear,
    };
  });

export const layerValue = <M extends AnyService>(
  model: M,
  value: PortsOf<M>,
): Layer.Layer<Context.Service.Identifier<M>> =>
  Layer.succeed(model, model.of({ get: () => Effect.succeed(value), dispose: () => Effect.void }));
