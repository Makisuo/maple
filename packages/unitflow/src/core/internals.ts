import { type Pipeable, pipeArguments } from "effect/Pipeable";
import type { Source } from "./store.js";

/**
 * INTERNAL. The flattened read-only store behind `Model.list(...).select`: an
 * outer source of items plus a `pick` projecting each item to an inner source.
 * `get` resolves outer-then-inners synchronously through the registry;
 * `stream` re-subscribes to the picked inner sources whenever the outer
 * composition changes (see `Store.stream`). Not exported from the package
 * index — models reach it only through `Model.list`.
 */

/** The same runtime brand `store.ts` puts on its descriptors — `Symbol.for`
 * returns the one global symbol, so `isStore` recognizes flattened sources. */
const StoreTypeId = Symbol.for("@unitflow/core/Store");

const FlattenTypeId = Symbol.for("@unitflow/core/FlattenStore");

/** The shared `.pipe(...)` implementation, mirroring the other descriptors. */
const PipeableProto: Pipeable = {
  pipe() {
    return pipeArguments(this, arguments);
  },
};

interface FlattenState {
  readonly source: Source<ReadonlyArray<any>>;
  readonly pick: (item: any) => Source<any>;
}

/** A flattened read-only store: no state of its own — `get` computes from the
 * outer source's current items and their picked inner sources. */
export interface Flatten<A> extends Source<ReadonlyArray<A>> {
  readonly [FlattenTypeId]: FlattenState;
}

export const isFlatten = (value: unknown): value is Flatten<any> =>
  typeof value === "object" && value !== null && FlattenTypeId in value;

export const stateOf = (store: Flatten<any>): FlattenState => store[FlattenTypeId];

let nextFlattenId = 0;

export const make = <Item, A>(
  source: Source<ReadonlyArray<Item>>,
  pick: (item: Item) => Source<A>,
): Flatten<A> =>
  // The store brand is the same global symbol `store.ts` declares, but
  // TypeScript cannot unify the two unique-symbol declarations across modules.
  // eslint-disable-next-line revizo/no-type-assertion
  ({
    ...PipeableProto,
    [StoreTypeId]: StoreTypeId,
    [FlattenTypeId]: { source, pick },
    id: `store:flatten:${++nextFlattenId}`,
    // Mirrors the outer source's initial so pre-subscription snapshots (the
    // React binding) stay consistent with `get`.
    initial: source.initial.map((item) => pick(item).initial),
    "~source": true,
  }) as unknown as Flatten<A>;
