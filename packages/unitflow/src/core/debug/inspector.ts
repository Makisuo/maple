import * as Effect from "effect/Effect";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  type DebugSink,
  type InstanceKey,
  leaseCount,
  Registry,
  type RegistryService,
} from "../registry.js";
import * as Store from "../store.js";

/**
 * One recorded runtime occurrence. `cause` is the `seq` of the publication
 * whose synchronous dispatch this one happened inside — emits and writes open
 * a causality window for the duration of their synchronous fan-out, so a
 * handler's writes point back at the emit that ran it. Work done after an
 * asynchronous suspension records no cause.
 */
export interface DebugEvent {
  readonly seq: number;
  readonly time: number;
  readonly type: "write" | "emit" | "instance-created" | "instance-disposed";
  /** The port name — resolved retroactively: a descriptor named after the
   * event was recorded (ports are named when construction finishes) still
   * reads back with its final name. Falls back to the raw id. */
  readonly name: string;
  readonly id: string;
  /** The written value / emitted payload, by reference — no cloning. */
  readonly value?: unknown;
  readonly cause?: number;
}

export interface InstanceInfo {
  readonly model: string;
  readonly key: unknown;
  readonly leases: number;
}

export interface StoreInfo {
  readonly id: string;
  readonly name?: string;
  readonly value: unknown;
  /** True for computed stores (combined/flattened) evaluated from their
   * sources; false for plain materialized stores. */
  readonly derived: boolean;
}

export interface Snapshot {
  readonly instances: ReadonlyArray<InstanceInfo>;
  readonly stores: ReadonlyArray<StoreInfo>;
}

export interface Inspector {
  /** The recorded events, oldest first, optionally only those after `seq`. */
  readonly events: (sinceSeq?: number) => ReadonlyArray<DebugEvent>;
  /** The live registry state: model instances with lease counts, every
   * materialized store, and every derived store the port walk discovered —
   * evaluated on demand. */
  readonly snapshot: () => Snapshot;
  readonly clear: () => void;
  /** Removes the sink from the registry; recording stops immediately. */
  readonly detach: () => void;
}

export interface AttachOptions {
  /** Ring-buffer capacity; the oldest events are dropped past it. */
  readonly capacity?: number;
}

const instanceLabel = (key: InstanceKey): string =>
  key.key === undefined
    ? key.model
    : typeof key.key === "string"
      ? `${key.model}(${key.key})`
      : `${key.model}(${JSON.stringify(key.key)})`;

/**
 * Installs a debug sink on the ambient registry and returns the inspector
 * over it. Attach BEFORE constructing models: the port directory (names for
 * the log, derived stores for snapshots) is populated at instance
 * construction. One inspector per registry: attaching again replaces the
 * previous sink.
 */
export const attach = (
  options?: AttachOptions,
): Effect.Effect<Inspector, never, Registry> =>
  Effect.map(Registry, (registry) => attachTo(registry, options));

export const attachTo = (registry: RegistryService, options?: AttachOptions): Inspector => {
  const capacity = options?.capacity ?? 2_000;
  let buffer: Array<DebugEvent> = [];
  let seq = 0;
  /** The causality stack: the top is the publication whose synchronous
   * dispatch is currently running. */
  const window: Array<number> = [];
  /** Latest known name per descriptor id — filled by the port walk and by
   * every named publication, read back when the log is queried. */
  const names = new Map<string, string>();
  /** Every descriptor the port walk touched, for snapshot evaluation. */
  const ports = new Map<string, { readonly id: string; readonly name?: string }>();

  const record = (
    type: DebugEvent["type"],
    id: string,
    name: string,
    value?: unknown,
  ): DebugEvent => {
    const event: DebugEvent = {
      seq: ++seq,
      time: Date.now(),
      type,
      name,
      id,
      ...(value === undefined ? {} : { value }),
      ...(window.length === 0 ? {} : { cause: window[window.length - 1] }),
    };
    buffer.push(event);
    if (buffer.length > capacity) buffer = buffer.slice(buffer.length - capacity);
    return event;
  };

  const publication =
    (type: "write" | "emit") =>
    (port: { readonly id: string; readonly name?: string }, value: unknown): (() => void) => {
      if (port.name !== undefined) names.set(port.id, port.name);
      const event = record(type, port.id, port.name ?? port.id, value);
      window.push(event.seq);
      return () => {
        // Windows close strictly LIFO — dispatch is synchronous nesting.
        if (window[window.length - 1] === event.seq) window.pop();
      };
    };

  const sink: DebugSink = {
    write: publication("write"),
    emit: publication("emit"),
    instance: (key, phase) => {
      record(
        phase === "created" ? "instance-created" : "instance-disposed",
        instanceLabel(key),
        instanceLabel(key),
      );
    },
    port: (port) => {
      ports.set(port.id, port);
      if (port.name !== undefined) names.set(port.id, port.name);
    },
  };
  registry.debug = sink;

  const resolveName = (event: DebugEvent): DebugEvent => {
    const latest = names.get(event.id);
    return latest === undefined || latest === event.name ? event : { ...event, name: latest };
  };

  return {
    events: (sinceSeq) =>
      (sinceSeq === undefined ? buffer : buffer.filter((event) => event.seq > sinceSeq)).map(
        resolveName,
      ),
    snapshot: () => {
      const instances: Array<InstanceInfo> = [];
      MutableHashMap.forEach(registry.instanceScopes, (_scope, key) => {
        instances.push({ model: key.model, key: key.key, leases: leaseCount(registry, key) });
      });
      const stores: Array<StoreInfo> = [];
      const covered = new Set<string>();
      // The port directory first: it knows names and can evaluate derived
      // stores (combined/flattened) that have no backing ref of their own.
      for (const [id, port] of ports) {
        if (!Store.isStore(port)) continue;
        const value = Store.evalForDebug(registry, port);
        if (Option.isNone(value)) continue;
        covered.add(id);
        const name = names.get(id);
        stores.push({
          id,
          ...(name === undefined ? {} : { name }),
          value: value.value,
          derived: Store.isCombined(port),
        });
      }
      // Then every materialized ref the walk never saw (module-level stores,
      // internals of models constructed before attach).
      for (const [id, ref] of registry.stores) {
        if (covered.has(id)) continue;
        const name = names.get(id);
        stores.push({
          id,
          ...(name === undefined ? {} : { name }),
          value: SubscriptionRef.getUnsafe(ref),
          derived: false,
        });
      }
      return { instances, stores };
    },
    clear: () => {
      buffer = [];
    },
    detach: () => {
      if (registry.debug === sink) registry.debug = undefined;
    },
  };
};
