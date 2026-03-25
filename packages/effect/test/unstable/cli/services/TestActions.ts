import { Array as Arr, Effect, Layer, Ref, ServiceMap } from "effect"

export interface TestAction {
  readonly command: string
  readonly details: Record<string, unknown>
}

export class TestActions extends ServiceMap.Service<TestActions, {
  readonly log: (action: TestAction) => Effect.Effect<void>
  readonly getActions: Effect.Effect<ReadonlyArray<TestAction>>
}>()("TestActions") {}

const make = Effect.gen(function*() {
  const actions = yield* Ref.make<ReadonlyArray<TestAction>>([])
  return TestActions.of({
    getActions: Ref.get(actions),
    log: (action) => Ref.update(actions, Arr.append(action))
  })
})

export const layer = Layer.effect(TestActions, make)

export const logAction = (
  command: string,
  details: Record<string, unknown> = {}
): Effect.Effect<void, never, TestActions> =>
  Effect.flatMap(
    TestActions.asEffect(),
    (actions) => actions.log({ command, details })
  )

export const getActions: Effect.Effect<
  ReadonlyArray<TestAction>,
  never,
  TestActions
> = Effect.flatMap(TestActions.asEffect(), (actions) => actions.getActions)
