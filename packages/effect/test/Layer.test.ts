import { assert, describe, it } from "@effect/vitest"
import { Context, Fiber, Stream } from "effect"
import * as Cause from "effect/Cause"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"

describe("Layer", () => {
  it.effect("layers can be acquired in parallel", () =>
    Effect.gen(function*() {
      const BoolTag = Context.Service<boolean>("boolean")
      const latch = Latch.makeUnsafe()
      const layer1 = Layer.effectContext<never, never, never>(Effect.never)
      const layer2 = Layer.effectContext(
        Effect.acquireRelease(
          latch.open.pipe(
            Effect.map((bool) => Context.make(BoolTag, bool))
          ),
          () => Effect.void
        )
      )
      const env = layer1.pipe(Layer.merge(layer2), Layer.build)
      const fiber = yield* Effect.forkDetach(Effect.scoped(env))
      yield* latch.await
      const result = yield* Fiber.interrupt(fiber)
      assert.isUndefined(result)
    }))

  it.effect("sharing with merge", () =>
    Effect.gen(function*() {
      const array: Array<string> = []
      const layer = makeLayer1(array)
      const env = layer.pipe(Layer.merge(layer), Layer.build)
      yield* Effect.scoped(env)
      assert.deepStrictEqual(array, [acquire1, release1])
    }))

  it.effect("sharing itself with merge", () =>
    Effect.gen(function*() {
      const service1 = new Service1()
      const layer = Layer.succeed(Service1Tag)(service1)
      const env = layer.pipe(Layer.merge(layer), Layer.merge(layer), Layer.build)
      const result = yield* env.pipe(
        Effect.map((context) => Context.get(context, Service1Tag))
      )
      assert.strictEqual(result, service1)
    }))

  it.effect("suspend is lazy", () =>
    Effect.gen(function*() {
      let evaluated = 0
      const layer = Layer.suspend(() => {
        evaluated++
        return Layer.succeed(Service1Tag)(new Service1())
      })

      assert.strictEqual(evaluated, 0)
      yield* Effect.scoped(Layer.build(layer))
      assert.strictEqual(evaluated, 1)
      yield* Effect.scoped(Layer.build(layer))
      assert.strictEqual(evaluated, 2)
    }))

  it.effect("suspend preserves sharing", () =>
    Effect.gen(function*() {
      const array: Array<string> = []
      let evaluated = 0
      const layer = Layer.suspend(() => {
        evaluated++
        return makeLayer1(array)
      })

      yield* Effect.scoped(layer.pipe(Layer.merge(layer), Layer.build))

      assert.strictEqual(evaluated, 1)
      assert.deepStrictEqual(array, [acquire1, release1])
    }))

  it.effect("finalizers", () =>
    Effect.gen(function*() {
      const arr: Array<string> = []
      const layer1 = makeLayer1(arr)
      const layer2 = makeLayer2(arr)
      const env = layer1.pipe(Layer.merge(layer2), Layer.build)
      yield* Effect.scoped(env)
      assert.isDefined(arr.slice(0, 2).find((s) => s === acquire1))
      assert.isDefined(arr.slice(0, 2).find((s) => s === acquire2))
      assert.isDefined(arr.slice(2, 4).find((s) => s === release1))
      assert.isDefined(arr.slice(2, 4).find((s) => s === release2))
    }))

  it.effect("catch - uses an alternative layer", () =>
    Effect.gen(function*() {
      const arr: Array<string> = []
      const layer1 = makeLayer1(arr)
      const layer2 = makeLayer2(arr)
      const env = Layer.effectDiscard(Effect.fail("failed!")).pipe(
        Layer.provideMerge(layer1),
        Layer.catch(() => layer2),
        Layer.build
      )
      yield* Effect.scoped(env)
      assert.deepStrictEqual(arr, [acquire1, release1, acquire2, release2])
    }))

  it.effect("catchTag - uses an alternative layer", () =>
    Effect.gen(function*() {
      class LayerError extends Data.TaggedError("LayerError") {}
      const arr: Array<string> = []
      const layer1 = makeLayer1(arr)
      const layer2 = makeLayer2(arr)
      const env = Layer.effectDiscard(Effect.fail(new LayerError())).pipe(
        Layer.provideMerge(layer1),
        Layer.catchTag("LayerError", () => layer2),
        Layer.build
      )
      yield* Effect.scoped(env)
      assert.deepStrictEqual(arr, [acquire1, release1, acquire2, release2])
    }))

  it.effect("tap - executes effect with success services and preserves output", () =>
    Effect.gen(function*() {
      const arr: Array<string> = []
      const env = makeLayer1(arr).pipe(
        Layer.tap((context) =>
          Effect.sync(() => {
            arr.push(`tap:${Context.get(context, Service1Tag).constructor.name}`)
          })
        ),
        Layer.build
      )
      const context = yield* Effect.scoped(env)
      const service = Context.get(context, Service1Tag)
      assert.strictEqual(yield* service.one(), 1)
      assert.deepStrictEqual(arr, [acquire1, "tap:Service1", release1])
    }))

  it.effect("tapError - executes effect and preserves original error", () =>
    Effect.gen(function*() {
      const arr: Array<string> = []
      const error = yield* Layer.effectDiscard(Effect.fail("failed!")).pipe(
        Layer.tapError((e) =>
          Effect.sync(() => {
            arr.push(`tapError:${e}`)
          })
        ),
        Layer.build,
        Effect.scoped,
        Effect.flip
      )
      assert.strictEqual(error, "failed!")
      assert.deepStrictEqual(arr, ["tapError:failed!"])
    }))

  it.effect("tapCause - executes effect and preserves original cause", () =>
    Effect.gen(function*() {
      const arr: Array<string> = []
      const exit = yield* Layer.effectDiscard(Effect.die("boom")).pipe(
        Layer.tapCause((cause) =>
          Effect.sync(() => {
            arr.push(`tapCause:${Cause.hasDies(cause)}`)
          })
        ),
        Layer.build,
        Effect.scoped,
        Effect.exit
      )
      assert.strictEqual(exit._tag, "Failure")
      if (exit._tag === "Failure") {
        assert.isTrue(Cause.hasDies(exit.cause))
      }
      assert.deepStrictEqual(arr, ["tapCause:true"])
    }))

  it.effect("fresh with merge", () =>
    Effect.gen(function*() {
      const arr: Array<string> = []
      const layer = makeLayer1(arr)
      const env = layer.pipe(Layer.merge(Layer.fresh(layer)), Layer.build)
      yield* Effect.scoped(env)
      assert.deepStrictEqual(arr, [acquire1, acquire1, release1, release1])
    }))

  it.effect("fresh with provide", () =>
    Effect.gen(function*() {
      const arr: Array<string> = []
      const layer = makeLayer1(arr)
      const env = Layer.fresh(layer).pipe(
        Layer.provide(layer),
        Layer.build
      )
      yield* Effect.scoped(env)
      assert.deepStrictEqual(arr, [acquire1, acquire1, release1, release1])
    }))

  it.effect("with multiple layers", () =>
    Effect.gen(function*() {
      const arr: Array<string> = []
      const layer = makeLayer1(arr)
      const env = layer.pipe(
        Layer.merge(layer),
        Layer.merge(layer.pipe(Layer.merge(layer), Layer.fresh)),
        Layer.build
      )
      yield* Effect.scoped(env)
      assert.deepStrictEqual(arr, [acquire1, acquire1, release1, release1])
    }))
  it.effect("with identical fresh layers", () =>
    Effect.gen(function*() {
      const arr: Array<string> = []
      const layer1 = makeLayer1(arr)
      const layer2 = makeLayer2(arr)
      const layer3 = makeLayer3(arr)
      const env = layer2.pipe(
        Layer.merge(
          layer3.pipe(
            Layer.provide(layer1),
            Layer.fresh
          )
        ),
        Layer.provide(Layer.fresh(layer1)),
        Layer.build
      )
      yield* Effect.scoped(env)
      assert.deepStrictEqual(arr, [
        acquire1,
        acquire2,
        acquire1,
        acquire3,
        release3,
        release1,
        release2,
        release1
      ])
    }))
  it.effect("interruption with merge", () =>
    Effect.gen(function*() {
      const arr: Array<string> = []
      const layer1 = makeLayer1(arr)
      const layer2 = makeLayer2(arr)
      const env = layer1.pipe(Layer.merge(layer2), Layer.build)
      const fiber = yield* Effect.forkChild(Effect.scoped(env))
      yield* Fiber.interrupt(fiber)
      if (arr.find((s) => s === acquire1) !== undefined) {
        assert.isTrue(arr.some((s) => s === release1))
      }
      if (arr.find((s) => s === acquire2) !== undefined) {
        assert.isTrue(arr.some((s) => s === release2))
      }
    }))
  it.effect("interruption with provide", () =>
    Effect.gen(function*() {
      const arr: Array<string> = []
      const layer1 = makeLayer1(arr)
      const layer2 = makeLayer2(arr)
      const env = layer2.pipe(Layer.provide(layer1), Layer.build)
      const fiber = yield* Effect.forkChild(Effect.scoped(env))
      yield* Fiber.interrupt(fiber)
      if (arr.find((s) => s === acquire1) !== undefined) {
        assert.isTrue(arr.some((s) => s === release1))
      }
      if (arr.find((s) => s === acquire2) !== undefined) {
        assert.isTrue(arr.some((s) => s === release2))
      }
    }))
  it.effect("interruption with multiple layers", () =>
    Effect.gen(function*() {
      const arr: Array<string> = []
      const layer1 = makeLayer1(arr)
      const layer2 = makeLayer2(arr)
      const layer3 = makeLayer3(arr)
      const env = layer3.pipe(
        Layer.provide(layer1),
        Layer.merge(layer2),
        Layer.provide(layer1),
        Layer.build
      )
      const fiber = yield* Effect.forkChild(Effect.scoped(env))
      yield* Fiber.interrupt(fiber)
      if (arr.find((s) => s === acquire1) !== undefined) {
        assert.isTrue(arr.some((s) => s === release1))
      }
      if (arr.find((s) => s === acquire2) !== undefined) {
        assert.isTrue(arr.some((s) => s === release2))
      }
      if (arr.find((s) => s === acquire3) !== undefined) {
        assert.isTrue(arr.some((s) => s === release3))
      }
    }))

  it.effect("finalizers with provide", () =>
    Effect.gen(function*() {
      const arr: Array<string> = []
      const layer1 = makeLayer1(arr)
      const layer2 = makeLayer2(arr)
      const env = layer2.pipe(Layer.provide(layer1), Layer.build)
      yield* Effect.scoped(env)
      assert.deepStrictEqual(arr, [acquire1, acquire2, release2, release1])
    }))

  it.effect("finalizers with multiple layers with provideTo", () =>
    Effect.gen(function*() {
      const arr: Array<string> = []
      const layer1 = makeLayer1(arr)
      const layer2 = makeLayer2(arr)
      const layer3 = makeLayer3(arr)
      const env = layer3.pipe(Layer.provide(layer2), Layer.provide(layer1), Layer.build)
      yield* Effect.scoped(env)
      assert.deepStrictEqual(arr, [acquire1, acquire2, acquire3, release3, release2, release1])
    }))

  it.effect("orDie does not interfere with sharing", () =>
    Effect.gen(function*() {
      const arr: Array<string> = []
      const layer1 = makeLayer1(arr)
      const layer2 = makeLayer2(arr)
      const layer3 = makeLayer3(arr)
      const env = layer3.pipe(
        Layer.provide(layer1),
        Layer.provide(layer2),
        Layer.provide(Layer.orDie(layer1)),
        Layer.build
      )
      yield* Effect.scoped(env)
      assert.strictEqual(arr[0], acquire1)
      assert.isTrue(arr.slice(1, 3).some((s) => s === acquire2))
      assert.isTrue(arr.slice(1, 3).some((s) => s === acquire3))
      assert.isTrue(arr.slice(3, 5).some((s) => s === release3))
      assert.isTrue(arr.slice(3, 5).some((s) => s === release2))
      assert.strictEqual(arr[5], release1)
    }))

  describe("mock", () => {
    it.effect("allows passing partial service", () =>
      Effect.gen(function*() {
        class Service1 extends Context.Service<Service1, {
          one: Effect.Effect<number>
          two(): Effect.Effect<number>
          three: Stream.Stream<number>
        }>()("Service1") {}
        yield* Effect.gen(function*() {
          const service = yield* Service1
          assert.strictEqual(yield* service.one, 123)
          yield* service.two().pipe(
            Effect.catchDefect(Effect.fail),
            Effect.flip
          )
          yield* service.three.pipe(
            Stream.catchCause(Stream.fail),
            Stream.runDrain,
            Effect.flip
          )
        }).pipe(
          Effect.provide(
            Layer.mock(Service1)({
              one: Effect.succeed(123)
            })
          )
        )
      }))

    it.effect("allows passing partial service in dual form", () =>
      Effect.gen(function*() {
        class Service1 extends Context.Service<Service1, {
          one: Effect.Effect<number>
          two(): Effect.Effect<number>
        }>()("Service1") {}
        yield* Effect.gen(function*() {
          const service = yield* Service1
          assert.strictEqual(yield* service.one, 123)
          yield* service.two().pipe(
            Effect.catchDefect(Effect.fail),
            Effect.flip
          )
        }).pipe(
          Effect.provide(
            Layer.mock(Service1, {
              one: Effect.succeed(123)
            })
          )
        )
      }))
  })

  describe("MemoMap", () => {
    it.effect("memoizes suspend across builds", () =>
      Effect.gen(function*() {
        const arr: Array<string> = []
        let evaluated = 0
        const layer = Layer.suspend(() => {
          evaluated++
          return makeLayer1(arr)
        })
        const memoMap = Layer.makeMemoMapUnsafe()
        const scope1 = yield* Scope.make()
        const scope2 = yield* Scope.make()

        yield* Layer.buildWithMemoMap(layer, memoMap, scope1)
        yield* Layer.buildWithMemoMap(layer, memoMap, scope2)
        yield* Scope.close(scope2, Exit.void)

        assert.strictEqual(evaluated, 1)
        assert.deepStrictEqual(arr, [acquire1])

        yield* Scope.close(scope1, Exit.void)

        assert.deepStrictEqual(arr, [acquire1, release1])
      }))

    it.effect("memoizes layer across builds", () =>
      Effect.gen(function*() {
        const arr: Array<string> = []
        const layer1 = makeLayer1(arr)
        const layer2 = makeLayer2(arr).pipe(
          Layer.provide(layer1)
        )
        const memoMap = Layer.makeMemoMapUnsafe()
        const scope1 = yield* Scope.make()
        const scope2 = yield* Scope.make()

        yield* Layer.buildWithMemoMap(layer1, memoMap, scope1)
        yield* Layer.buildWithMemoMap(layer2, memoMap, scope2)
        yield* Scope.close(scope2, Exit.void)
        yield* Layer.buildWithMemoMap(layer2, memoMap, scope1)
        yield* Scope.close(scope1, Exit.void)

        assert.deepStrictEqual(arr, [acquire1, acquire2, release2, acquire2, release2, release1])
      }))

    it.effect("layers are not released early", () =>
      Effect.gen(function*() {
        const arr: Array<string> = []
        const layer1 = makeLayer1(arr)
        const layer2 = makeLayer2(arr).pipe(
          Layer.provide(layer1)
        )
        const memoMap = Layer.makeMemoMapUnsafe()
        const scope1 = yield* Scope.make()
        const scope2 = yield* Scope.make()

        yield* Layer.buildWithMemoMap(layer1, memoMap, scope1)
        yield* Layer.buildWithMemoMap(layer2, memoMap, scope2)
        yield* Scope.close(scope1, Exit.void)
        yield* Scope.close(scope2, Exit.void)

        assert.deepStrictEqual(arr, [acquire1, acquire2, release2, release1])
      }))
  })
})

const acquire1 = "Acquiring Module 1"
const acquire2 = "Acquiring Module 2"
const acquire3 = "Acquiring Module 3"
const release1 = "Releasing Module 1"
const release2 = "Releasing Module 2"
const release3 = "Releasing Module 3"

export class Service1 {
  one(): Effect.Effect<number> {
    return Effect.succeed(1)
  }
}
const Service1Tag = Context.Service<Service1>("Service1")
const makeLayer1 = (array: Array<string>): Layer.Layer<Service1> => {
  return Layer.effect(Service1Tag)(
    Effect.acquireRelease(
      Effect.sync(() => {
        array.push(acquire1)
        return new Service1()
      }),
      () => Effect.sync(() => array.push(release1))
    )
  )
}
class Service2 {
  two(): Effect.Effect<number> {
    return Effect.succeed(2)
  }
}
const Service2Tag = Context.Service<Service2>("Service2")
const makeLayer2 = (array: Array<string>): Layer.Layer<Service2> => {
  return Layer.effect(Service2Tag)(
    Effect.acquireRelease(
      Effect.sync(() => {
        array.push(acquire2)
        return new Service2()
      }),
      () => Effect.sync(() => array.push(release2))
    )
  )
}
class Service3 {
  three(): Effect.Effect<number> {
    return Effect.succeed(3)
  }
}
const Service3Tag = Context.Service<Service3>("Service3")
const makeLayer3 = (array: Array<string>): Layer.Layer<Service3> => {
  return Layer.effect(Service3Tag)(
    Effect.acquireRelease(
      Effect.sync(() => {
        array.push(acquire3)
        return new Service3()
      }),
      () => Effect.sync(() => array.push(release3))
    )
  )
}
