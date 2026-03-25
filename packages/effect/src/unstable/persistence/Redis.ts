/**
 * @since 4.0.0
 */
import * as Cache from "../../Cache.ts"
import * as Effect from "../../Effect.ts"
import * as Equal from "../../Equal.ts"
import { constant, identity } from "../../Function.ts"
import * as Hash from "../../Hash.ts"
import * as Schema from "../../Schema.ts"
import * as ServiceMap from "../../ServiceMap.ts"

/**
 * @since 4.0.0
 * @category Service
 */
export class Redis extends ServiceMap.Service<Redis, {
  readonly send: <A = unknown>(command: string, ...args: ReadonlyArray<string>) => Effect.Effect<A, RedisError>

  readonly eval: <
    Config extends {
      readonly params: ReadonlyArray<unknown>
      readonly result: unknown
    }
  >(script: Script<Config>) => (...params: Config["params"]) => Effect.Effect<Config["result"], RedisError>
}>()("effect/persistence/Redis") {}

/**
 * @since 4.0.0
 * @category Constructors
 */
export const make = Effect.fnUntraced(function*(
  options: {
    readonly send: <A = unknown>(command: string, ...args: ReadonlyArray<string>) => Effect.Effect<A, RedisError>
  }
) {
  const scriptCache = yield* Cache.make({
    lookup: (script: Script<any>) => options.send<string>("SCRIPT", "LOAD", script.lua),
    capacity: Number.POSITIVE_INFINITY
  })

  const eval_ = <
    Config extends {
      readonly params: ReadonlyArray<unknown>
      readonly result: unknown
    }
  >(
    script: Script<Config>
  ) =>
  (...params: Config["params"]): Effect.Effect<Config["result"], RedisError> =>
    Effect.flatMap(Cache.get(scriptCache, script), (sha) =>
      options.send<Config["result"]>(
        "EVALSHA",
        sha,
        script.numberOfKeys(...params).toString(),
        ...script.params(...params).map((param) => String(param))
      ))

  return identity<Redis["Service"]>({
    send: options.send,
    eval: eval_
  })
})

type ErrorTypeId = "~effect/persistence/Redis/RedisError"
const ErrorTypeId: ErrorTypeId = "~effect/persistence/Redis/RedisError"

/**
 * @since 4.0.0
 * @category Errors
 */
export class RedisError extends Schema.ErrorClass<RedisError>(ErrorTypeId)({
  _tag: Schema.tag("RedisError"),
  cause: Schema.Defect
}) {
  /**
   * @since 4.0.0
   */
  readonly [ErrorTypeId]: ErrorTypeId = ErrorTypeId
}

type ScriptTypeId = "~effect/persistence/Redis/Script"
const ScriptTypeId: ScriptTypeId = "~effect/persistence/Redis/Script"

/**
 * @since 4.0.0
 * @category Scripting
 */
export interface Script<
  Config extends {
    readonly params: ReadonlyArray<unknown>
    readonly result: unknown
  }
> {
  readonly [ScriptTypeId]: {
    readonly params: Config["params"]
    readonly result: Config["result"]
  }
  readonly lua: string
  readonly params: (...params: Config["params"]) => ReadonlyArray<unknown>
  readonly numberOfKeys: (...params: Config["params"]) => number

  /**
   * Set the return type of the script.
   */
  withReturnType<Result>(): Script<{
    params: Config["params"]
    result: Result
  }>
}

const ScriptProto = {
  [ScriptTypeId]: {
    params: identity,
    result: identity
  },
  withReturnType() {
    return this
  },
  [Equal.symbol](that: unknown): boolean {
    return this === that
  },
  [Hash.symbol](): number {
    return Hash.random(this)
  }
}

/**
 * @since 4.0.0
 * @category Scripting
 */
export const script = <Params extends ReadonlyArray<any>>(
  f: (...params: Params) => ReadonlyArray<unknown>,
  options: {
    readonly lua: string
    readonly numberOfKeys: number | ((...params: Params) => number)
  }
): Script<{
  params: Params
  result: void
}> =>
  Object.assign(Object.create(ScriptProto), {
    ...options,
    params: f,
    numberOfKeys: typeof options.numberOfKeys === "number" ? constant(options.numberOfKeys) : options.numberOfKeys
  })
