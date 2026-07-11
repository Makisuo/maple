import { assert, describe, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import { Model, Registry, Store } from "../src/core/index.js";

class PrimitiveKeyModel extends Model.Service<PrimitiveKeyModel>()(
  "/test/test/PrimitiveKeyModel",
)<string>()({
  make: (key) =>
    Effect.sync(() => {
      const labelStore = Store.make(`item:${key}`);

      return {
        inputs: {},
        outputs: {},
        ui: {
          labelStore,
        },
      };
    }),
}) {}

interface RecordKey {
  readonly owner: string;
  readonly id: number;
}

class RecordKeyModel extends Model.Service<RecordKeyModel>()(
  "/test/test/RecordKeyModel",
)<RecordKey>()({
  make: (key) =>
    Effect.sync(() => {
      const labelStore = Store.make(`${key.owner}:${key.id}`);

      return {
        inputs: {},
        outputs: {},
        ui: {
          labelStore,
        },
      };
    }),
}) {}

type SessionKey = Data.TaggedEnum<{
  readonly Route: {};
  readonly Custom: { readonly id: string };
}>;

const SessionKey = Data.taggedEnum<SessionKey>();

class SessionKeyModel extends Model.Service<SessionKeyModel>()(
  "/test/test/SessionKeyModel",
)<SessionKey>()({
  make: (key) =>
    Effect.sync(() => {
      const tagStore = Store.make(key._tag);

      return {
        inputs: {},
        outputs: {},
        ui: {
          tagStore,
        },
      };
    }),
}) {}

interface OwnerKeyArgs {
  readonly scope: string;
}

class OwnerKey extends Data.Class<OwnerKeyArgs> {}

class OwnerKeyModel extends Model.Service<OwnerKeyModel>()(
  "/test/test/OwnerKeyModel",
)<OwnerKey>()({
  make: (key) =>
    Effect.sync(() => {
      const scopeStore = Store.make(key.scope);

      return {
        inputs: {},
        outputs: {},
        ui: {
          scopeStore,
        },
      };
    }),
}) {}

interface NestedKey {
  readonly project: { readonly id: string };
}

class NestedKeyModel extends Model.Service<NestedKeyModel>()(
  "/test/test/NestedKeyModel",
)<NestedKey>()({
  make: (key) =>
    Effect.sync(() => {
      const idStore = Store.make(key.project.id);

      return {
        inputs: {},
        outputs: {},
        ui: {
          idStore,
        },
      };
    }),
}) {}

class KeySingletonModel extends Model.Service<KeySingletonModel>()(
  "/test/test/KeySingletonModel",
)({
  make: () =>
    Effect.sync(() => {
      const labelStore = Store.make("singleton");

      return {
        inputs: {},
        outputs: {},
        ui: {
          labelStore,
        },
      };
    }),
}) {}

describe("model keys", () => {
  it.effect("a primitive key resolves one memoized instance", () =>
    Effect.gen(function* () {
      const registry = yield* Registry;
      const first = yield* Model.get(PrimitiveKeyModel, "a");
      const second = yield* Model.get(PrimitiveKeyModel, "a");
      const other = yield* Model.get(PrimitiveKeyModel, "b");

      assert.strictEqual(first.ui.labelStore, second.ui.labelStore);
      assert.notStrictEqual(first.ui.labelStore, other.ui.labelStore);
      assert.strictEqual([...(yield* RcMap.keys(registry.instances))].length, 2);
    }).pipe(Effect.provide(PrimitiveKeyModel.layer.pipe(Layer.provideMerge(Registry.layer)))),
  );

  it.effect("structurally equal record literals resolve one memoized instance", () =>
    Effect.gen(function* () {
      const registry = yield* Registry;
      const left: RecordKey = { owner: "o", id: 1 };
      const right: RecordKey = { owner: "o", id: 1 };

      // v4 plain records carry deep structural Equal/Hash natively; the
      // registry's instance map resolves them to one instance without any
      // serialization.
      assert.isTrue(Equal.equals(left, right));

      const first = yield* Model.get(RecordKeyModel, left);
      const second = yield* Model.get(RecordKeyModel, right);
      const inline = yield* Model.get(RecordKeyModel, { owner: "o", id: 1 });

      assert.strictEqual(first.ui.labelStore, second.ui.labelStore);
      assert.strictEqual(first.ui.labelStore, inline.ui.labelStore);
      assert.strictEqual([...(yield* RcMap.keys(registry.instances))].length, 1);
    }).pipe(Effect.provide(RecordKeyModel.layer.pipe(Layer.provideMerge(Registry.layer)))),
  );

  it.effect("a tagged-enum key is Equal-interoperable with a plain literal of the same shape", () =>
    Effect.gen(function* () {
      const registry = yield* Registry;
      const constructed = SessionKey.Custom({ id: "s1" });
      // `Data.taggedEnum` constructors return plain objects, so a raw literal
      // with the same fields is the SAME key.
      assert.isTrue(Equal.equals(constructed, { _tag: "Custom", id: "s1" }));

      const viaEnum = yield* Model.get(SessionKeyModel, constructed);
      const viaLiteral = yield* Model.get(SessionKeyModel, { _tag: "Custom", id: "s1" });

      assert.strictEqual(viaEnum.ui.tagStore, viaLiteral.ui.tagStore);
      assert.strictEqual([...(yield* RcMap.keys(registry.instances))].length, 1);
    }).pipe(Effect.provide(SessionKeyModel.layer.pipe(Layer.provideMerge(Registry.layer)))),
  );

  it.effect("a Data.Class key works, but is NOT Equal to a plain literal", () =>
    Effect.gen(function* () {
      const registry = yield* Registry;
      const left = new OwnerKey({ scope: "root" });
      const right = new OwnerKey({ scope: "root" });

      assert.isTrue(Equal.equals(left, right));
      // CRITICAL v4 semantics: structural comparison of a non-plain object
      // includes its prototype keys (`pipe` from `Pipeable.Class`), so a
      // `Data.Class` instance never equals a plain literal with the same
      // fields. Keys of one model must therefore live in ONE world — this
      // codebase standardizes on plain flat literals.
      assert.isFalse(Equal.equals(left, { scope: "root" }));

      const first = yield* Model.get(OwnerKeyModel, left);
      const second = yield* Model.get(OwnerKeyModel, right);

      assert.strictEqual(first.ui.scopeStore, second.ui.scopeStore);
      assert.strictEqual([...(yield* RcMap.keys(registry.instances))].length, 1);
    }).pipe(Effect.provide(OwnerKeyModel.layer.pipe(Layer.provideMerge(Registry.layer)))),
  );

  it("rejects nested and missing keys at the entry points (compile-level)", () => {
    const check = Effect.fnUntraced(function* () {
      // @ts-expect-error a model key must be FLAT — a nested record is not a valid key input
      const nested = yield* Model.get(NestedKeyModel, { project: { id: "p1" } });
      // @ts-expect-error a keyed model requires its key
      const missing = yield* Model.get(RecordKeyModel);
      const singleton = yield* Model.get(KeySingletonModel);
      const valid = yield* Model.get(RecordKeyModel, { owner: "o", id: 1 });

      const list = yield* Model.list(NestedKeyModel);
      // @ts-expect-error a list child key must be FLAT as well
      yield* list.push({ project: { id: "p1" } });

      return { nested, missing, singleton, valid };
    });
    assert.isFunction(check);
  });
});
