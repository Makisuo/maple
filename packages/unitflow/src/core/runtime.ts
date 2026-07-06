import type * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Event from "./event.js";
import * as Model from "./model.js";
import { type InstanceKey, instanceKey, Registry } from "./registry.js";
import * as Store from "./store.js";

/** The UI-facing state of a model instance: render each tag distinctly. */
export type ModelResult<A, E> = Data.TaggedEnum<{
  Building: {};
  Ready: { readonly model: A };
  Failed: { readonly cause: Cause.Cause<E> };
}>;

interface ModelResultDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: ModelResult<this["A"], this["B"]>;
}

export const ModelResult = Data.taggedEnum<ModelResultDefinition>();

/**
 * The bridge between the Unitflow runtime and a UI framework: synchronous
 * snapshots plus subscriptions, the shape `useSyncExternalStore` needs.
 * `Registry.layer` is provided automatically — pass the model and
 * service layers.
 */
export interface UnitflowRuntime<R, ER> {
  readonly runtime: ManagedRuntime.ManagedRuntime<R | Registry, ER>;
  readonly getStore: <A>(store: Store.Source<A>) => A;
  readonly subscribeStore: <A>(store: Store.Source<A>, listener: () => void) => () => void;
  readonly getModel: <M extends Model.AnyService>(
    model: M,
    key: Model.KeyOf<M>,
  ) => ModelResult<Model.PortsOf<M>, Model.ErrorOf<M>>;
  readonly subscribeModel: <M extends Model.AnyService>(
    model: M,
    key: Model.KeyOf<M>,
    listener: () => void,
  ) => () => void;
  readonly emit: <E extends Event.Sink<any>>(
    event: E,
    ...args: Event.EmitArgs<Event.PayloadOf<E>>
  ) => void;
  readonly dispose: () => Promise<void>;
}

interface StoreEntry {
  value: unknown;
  fiber: Fiber.Fiber<unknown, unknown> | undefined;
  readonly listeners: Set<() => void>;
}

interface ModelEntry {
  result: ModelResult<any, any>;
  readonly listeners: Set<() => void>;
}

const notify = (listeners: Set<() => void>): void => {
  for (const listener of listeners) listener();
};

export const make = <R, ER>(
  layer: Layer.Layer<R, ER, Registry>,
  options?: {
    /** Share a `Layer.MemoMap` with another runtime (e.g. an atom runtime) so
     * layers common to both build once and resolve the same service
     * instances. */
    readonly memoMap?: Layer.MemoMap | undefined;
  },
): UnitflowRuntime<R, ER> => {
  const runtime = ManagedRuntime.make(layer.pipe(Layer.provideMerge(Registry.layer)), options);
  const storeEntries = new Map<string, StoreEntry>();
  // Structural keying, mirroring the registry's own instance map.
  const modelEntries = MutableHashMap.empty<InstanceKey, ModelEntry>();

  const storeEntry = <A>(store: Store.Source<A>): StoreEntry => {
    const existing = storeEntries.get(store.id);
    if (existing !== undefined) return existing;

    // The registry may already hold a newer value than `store.initial` (a
    // pipeline wrote before the UI subscribed); prefer it when the runtime
    // can answer synchronously.
    const snapshot = runtime.runSyncExit(Store.get(store));
    const entry: StoreEntry = {
      value: Exit.isSuccess(snapshot) ? snapshot.value : store.initial,
      fiber: undefined,
      listeners: new Set(),
    };
    storeEntries.set(store.id, entry);
    return entry;
  };

  const getStore = <A>(store: Store.Source<A>): A => {
    // The entry's value is only ever written from `Store.stream(store)`.
    // eslint-disable-next-line revizo/no-type-assertion
    return storeEntry(store).value as A;
  };

  const subscribeStore = <A>(store: Store.Source<A>, listener: () => void): (() => void) => {
    const entry = storeEntry(store);
    entry.listeners.add(listener);
    if (entry.fiber === undefined) {
      entry.fiber = runtime.runFork(
        Store.stream(store).pipe(
          Stream.runForEach((value) =>
            Effect.sync(() => {
              entry.value = value;
              notify(entry.listeners);
            }),
          ),
        ),
      );
    }
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0 && entry.fiber !== undefined) {
        runtime.runFork(Fiber.interrupt(entry.fiber));
        entry.fiber = undefined;
      }
    };
  };

  const modelEntry = <M extends Model.AnyService>(model: M, key: Model.KeyOf<M>): ModelEntry => {
    const entryKey = instanceKey(model.modelKey, key);
    const existing = MutableHashMap.get(modelEntries, entryKey);
    if (Option.isSome(existing)) return existing.value;

    const entry: ModelEntry = { result: ModelResult.Building(), listeners: new Set() };
    MutableHashMap.set(modelEntries, entryKey, entry);
    return entry;
  };

  const getModel = <M extends Model.AnyService>(
    model: M,
    key: Model.KeyOf<M>,
  ): ModelResult<Model.PortsOf<M>, Model.ErrorOf<M>> => modelEntry(model, key).result;

  const subscribeModel = <M extends Model.AnyService>(
    model: M,
    key: Model.KeyOf<M>,
    listener: () => void,
  ): (() => void) => {
    const entryKey = instanceKey(model.modelKey, key);
    const entry = modelEntry(model, key);
    entry.listeners.add(listener);
    // One lease per subscription, held in a binding scope that opens with the
    // subscription and closes on unsubscribe. Concurrent mounted Views of one
    // (model, key) hold independent leases on the shared instance; after the
    // last one releases, the model's idle TTL keeps the instance (and its
    // state) alive across quick remounts — StrictMode included.
    const bindingScope = Scope.makeUnsafe();
    // `KeyArgs` is conditional over the key type; the runtime call shape is
    // always a single key argument.
    // eslint-disable-next-line revizo/no-type-assertion
    const keyArgs = [key] as Model.KeyArgs<Model.KeyOf<M>>;
    // The model's service identifier cannot be tied to the runtime's `R`
    // statically — the runtime layer must include the model's layer.
    // eslint-disable-next-line revizo/no-type-assertion
    const load = Model.get(model, ...keyArgs) as Effect.Effect<Model.PortsOf<M>, Model.ErrorOf<M>>;
    runtime.runFork(
      load.pipe(
        Scope.provide(bindingScope),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const next: ModelResult<Model.PortsOf<M>, Model.ErrorOf<M>> = Exit.isSuccess(exit)
              ? ModelResult.Ready({ model: exit.value })
              : ModelResult.Failed({ cause: exit.cause });
            // Re-resolving the same live instance keeps the snapshot
            // reference stable (`useSyncExternalStore` compares by identity)
            // — and its death-watch finalizer from the first resolve is
            // already in place.
            if (
              entry.result._tag === "Ready" &&
              next._tag === "Ready" &&
              entry.result.model === next.model
            ) {
              return;
            }
            entry.result = next;
            notify(entry.listeners);
            if (!Exit.isSuccess(exit)) return;

            // Death watch: the cached Ready must never outlive its instance.
            // When the instance scope closes (idle TTL, Model.dispose, list
            // removal, registry teardown), reset the snapshot to Building so
            // a remount renders fresh construction instead of disposed ports.
            const registry = yield* Registry;
            const scope = MutableHashMap.get(registry.instanceScopes, entryKey);
            const resetStale = (): void => {
              if (entry.result._tag === "Ready" && entry.result.model === exit.value) {
                entry.result = ModelResult.Building();
                notify(entry.listeners);
              }
            };
            if (Option.isSome(scope)) {
              // Adding to an already-closing scope runs the finalizer at
              // once — the guard above makes that a safe no-op or reset.
              yield* Scope.addFinalizer(scope.value, Effect.sync(resetStale));
            } else {
              // The instance died between resolve and watch registration.
              resetStale();
            }
          }),
        ),
      ),
    );
    return () => {
      entry.listeners.delete(listener);
      runtime.runFork(Scope.close(bindingScope, Exit.void));
    };
  };

  const emit = <E extends Event.Sink<any>>(
    event: E,
    ...args: Event.EmitArgs<Event.PayloadOf<E>>
  ): void => {
    runtime.runFork(Event.emit(event, ...args));
  };

  return {
    runtime,
    getStore,
    subscribeStore,
    getModel,
    subscribeModel,
    emit,
    dispose: () => runtime.dispose(),
  };
};
