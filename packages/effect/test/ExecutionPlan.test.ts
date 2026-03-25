import { describe, it } from "@effect/vitest"
import { assertTrue, deepStrictEqual } from "@effect/vitest/utils"
import { Array, Effect, ExecutionPlan, Exit, Layer, ServiceMap, Stream } from "effect"

describe("ExecutionPlan", () => {
  class Service extends ServiceMap.Service<Service>()("Service", {
    make: Effect.succeed({
      stream: Stream.fail("A") as Stream.Stream<number, string>
    })
  }) {
    static A = Layer.effect(this, this.make)

    static B = Layer.succeed(
      Service,
      Service.of({
        stream: Stream.fail("B")
      })
    )
    static C = Layer.succeed(
      Service,
      Service.of({
        stream: Stream.make(1, 2, 3)
      })
    )
  }

  const Plan = ExecutionPlan.make({
    provide: Service.A
  }, {
    provide: Service.B
  }, {
    provide: Service.C
  })

  const PlanPartial = ExecutionPlan.make({
    provide: Layer.succeed(
      Service,
      Service.of({
        stream: Stream.make(1, 2, 3).pipe(
          Stream.concat(Stream.fail("Partial"))
        )
      })
    )
  }, {
    provide: Service.C
  })

  describe("Stream.withExecutionPlan", () => {
    it.effect("fallback", () =>
      Effect.gen(function*() {
        const stream = Stream.unwrap(Effect.map(Service.asEffect(), (_) => _.stream))
        const items = Array.empty<number>()
        const metadata = Array.empty<ExecutionPlan.Metadata>()
        const result = yield* stream.pipe(
          Stream.onStart(ExecutionPlan.CurrentMetadata.use((meta) => {
            metadata.push(meta)
            return Effect.void
          })),
          Stream.withExecutionPlan(Plan),
          Stream.runForEach((n) =>
            Effect.sync(() => {
              items.push(n)
            })
          ),
          Effect.exit
        )
        deepStrictEqual(items, [1, 2, 3])
        deepStrictEqual(metadata, [{
          attempt: 1,
          stepIndex: 0
        }, {
          attempt: 2,
          stepIndex: 1
        }, {
          attempt: 3,
          stepIndex: 2
        }])
        assertTrue(Exit.isSuccess(result))
      }))

    it.effect("fallback from partial stream", () =>
      Effect.gen(function*() {
        const stream = Stream.unwrap(Effect.map(Service.asEffect(), (_) => _.stream))
        const items = Array.empty<number>()
        const result = yield* stream.pipe(
          Stream.withExecutionPlan(PlanPartial),
          Stream.runForEach((n) =>
            Effect.sync(() => {
              items.push(n)
            })
          ),
          Effect.exit
        )
        deepStrictEqual(items, [1, 2, 3, 1, 2, 3])
        assertTrue(Exit.isSuccess(result))
      }))

    it.effect("preventFallbackOnPartialStream", () =>
      Effect.gen(function*() {
        const stream = Stream.unwrap(Effect.map(Service.asEffect(), (_) => _.stream))
        const items = Array.empty<number>()
        const result = yield* stream.pipe(
          Stream.withExecutionPlan(PlanPartial, {
            preventFallbackOnPartialStream: true
          }),
          Stream.runForEach((n) =>
            Effect.sync(() => {
              items.push(n)
            })
          ),
          Effect.exit
        )
        deepStrictEqual(items, [1, 2, 3])
        deepStrictEqual(result, Exit.fail("Partial"))
      }))
  })
})
