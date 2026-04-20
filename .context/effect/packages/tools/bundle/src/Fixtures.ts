/**
 * @since 1.0.0
 */
import * as Array from "effect/Array"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Order from "effect/Order"
import * as Glob from "glob"

/**
 * @since 1.0.0
 * @category services
 */
export class Fixtures extends Context.Service<Fixtures>()(
  "@effect/bundle/Fixtures",
  {
    make: Effect.gen(function*() {
      const fixturesDir = new URL("../fixtures/", import.meta.url).pathname

      const fixtures = yield* Effect.promise(() => Glob.glob("*.ts", { cwd: fixturesDir })).pipe(
        Effect.map(Array.sort(Order.String)),
        Effect.orDie
      )

      return {
        fixtures,
        fixturesDir
      } as const
    })
  }
) {
  static readonly layer = Layer.effect(this, this.make)
}
