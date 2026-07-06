import type * as Cause from "effect/Cause";
import * as React from "react";
import { Event, Model, Store } from "../core/index.js";
import { ModelResult, type UnitflowRuntime } from "../core/runtime.js";

const RuntimeContext = React.createContext<UnitflowRuntime<any, any> | null>(null);

const useUnitflowRuntime = (): UnitflowRuntime<any, any> => {
  const runtime = React.useContext(RuntimeContext);
  if (runtime === null) {
    throw new Error("Unitflow hooks require a <Unitflow> root above them.");
  }
  return runtime;
};

/** Subscribe to a store's current value. */
export const useStore = <A,>(store: Store.Source<A>): A => {
  const runtime = useUnitflowRuntime();
  const subscribe = React.useCallback(
    (listener: () => void) => runtime.subscribeStore(store, listener),
    [runtime, store],
  );
  const getSnapshot = React.useCallback(() => runtime.getStore(store), [runtime, store]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/** A stable callback that emits the event through the runtime. */
export const useEvent = <A,>(event: Event.Sink<A>): ((...args: Event.EmitArgs<A>) => void) => {
  const runtime = useUnitflowRuntime();
  return React.useCallback(
    (...args: Event.EmitArgs<A>) => runtime.emit(event, ...args),
    [runtime, event],
  );
};

/** Leases the root model and re-renders on its construction state. */
const useRootUnit = <M extends Model.Viewable>(
  runtime: UnitflowRuntime<any, any>,
  rootModel: M,
): ModelResult<Model.PortsOf<M>, Model.ErrorOf<M>> => {
  // The root model is a singleton, whose key is `void`.
  // eslint-disable-next-line revizo/no-type-assertion
  const key = undefined as Model.KeyOf<M>;
  const subscribe = React.useCallback(
    (listener: () => void) => runtime.subscribeModel(rootModel, key, listener),
    [runtime, rootModel, key],
  );
  const getSnapshot = React.useCallback(
    () => runtime.getModel(rootModel, key),
    [runtime, rootModel, key],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

const RootUnit = <M extends Model.Viewable>({
  runtime,
  rootModel,
  building,
  failed,
  children,
}: UnitflowProps<M>): React.ReactNode => {
  const resolved = useRootUnit(runtime, rootModel);
  return ModelResult.$match(resolved, {
    Ready: ({ model }) => children(model),
    Failed: ({ cause }) => failed?.(cause) ?? null,
    Building: () => building ?? null,
  });
};

export interface UnitflowProps<M extends Model.Viewable> {
  readonly runtime: UnitflowRuntime<any, any>;
  /** The singleton model whose unit bootstraps the tree. */
  readonly rootModel: M;
  /** Rendered while the root unit is constructing (async `make` or layer
   * build). */
  readonly building?: React.ReactNode;
  /** Rendered when the root construction failed. Defaults to nothing —
   * construction failures are configuration bugs, not UI states. */
  readonly failed?: (cause: Cause.Cause<Model.ErrorOf<M>>) => React.ReactNode;
  readonly children: (unit: Model.PortsOf<M>) => React.ReactNode;
}

/**
 * The single meeting point of React and the Unitflow runtime: provides the
 * runtime to every hook below and leases the root model, handing its unit to
 * `children`. All other units flow down from here — a parent model owns its
 * children and republishes their ports through `ui`; a View can never summon
 * an instance from JSX.
 */
export const Unitflow = <M extends Model.Viewable>(props: UnitflowProps<M>): React.ReactNode => (
  <RuntimeContext.Provider value={props.runtime}>
    <RootUnit {...props} />
  </RuntimeContext.Provider>
);

/** Every View renders a unit handed to it — by its parent View (from the
 * owning model's `ui`) or, for the root, by `Unitflow`. */
export interface ViewProps<M extends Model.AnyService> {
  readonly unit: Model.PortsOf<M>;
}

/** A `ui` record bound for rendering: store sources arrive as their current
 * values, event sinks as fire callbacks, everything else (nested child units)
 * untouched. */
export type BoundUi<Ui> = {
  readonly [K in keyof Ui]: Ui[K] extends Store.Source<infer A>
    ? A
    : Ui[K] extends Event.Sink<infer A>
      ? (...args: Event.EmitArgs<A>) => void
      : Ui[K];
};

let nextBoundId = 0;
const boundIds = new WeakMap<object, number>();

/** A stable identity per unit object — the `key` that remounts `Bound` when
 * the View switches to another instance. */
const boundId = (unit: object): number => {
  const existing = boundIds.get(unit);
  if (existing !== undefined) return existing;
  const id = ++nextBoundId;
  boundIds.set(unit, id);
  return id;
};

const makeView = <M extends Model.Viewable, P extends object = Record<never, never>>(
  model: M,
  render: (units: BoundUi<Model.PortsOf<M>["ui"]>, props: P) => React.ReactNode,
): React.FC<ViewProps<M> & P> => {
  // Keyed by the ports object, so a Bound instance always sees one and the
  // same ui record: it is created once in `make` and never mutated, hence the
  // per-entry hooks below keep a fixed order for the component's lifetime.
  const Bound = ({
    ui,
    extra,
  }: {
    readonly ui: Record<string, unknown>;
    readonly extra: P;
  }): React.ReactNode => {
    const units: Record<string, unknown> = {};
    for (const [key, port] of Object.entries(ui)) {
      if (Store.isStore(port)) {
        units[key] = useStore(port);
      } else if (Event.isEvent(port) && "~sink" in port) {
        units[key] = useEvent(port);
      } else {
        units[key] = port;
      }
    }
    // Built entry by entry from the same record the mapped type describes.
    // eslint-disable-next-line revizo/no-type-assertion
    return render(units as BoundUi<Model.PortsOf<M>["ui"]>, extra);
  };

  const Component = (props: ViewProps<M> & P): React.ReactNode => {
    const { unit, ...extra } = props;
    // eslint-disable-next-line revizo/no-type-assertion
    return <Bound key={boundId(unit)} ui={unit.ui} extra={extra as P} />;
  };
  Component.displayName = `View(${model.modelKey})`;
  return Component;
};

/**
 * Pairs a model with its View: a pure projection of the unit it receives.
 * The render callback gets the model's `ui` already bound as `units`: store
 * sources arrive as current values, event sinks as fire callbacks, and nested
 * child units pass through unchanged. No hooks needed in the callback — and
 * `inputs`/`outputs` stay invisible to JSX.
 */
export const View = { make: makeView };
