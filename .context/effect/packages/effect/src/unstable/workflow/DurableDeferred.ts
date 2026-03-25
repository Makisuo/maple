/**
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import type * as Brand from "../../Brand.ts"
import type * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import * as Encoding from "../../Encoding.ts"
import * as Exit from "../../Exit.ts"
import { dual } from "../../Function.ts"
import * as Option from "../../Option.ts"
import * as Schema from "../../Schema.ts"
import * as Getter from "../../SchemaGetter.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type * as Activity from "./Activity.ts"
import * as Workflow from "./Workflow.ts"
import type { WorkflowEngine, WorkflowInstance } from "./WorkflowEngine.ts"

const TypeId = "~effect/workflow/DurableDeferred"

/**
 * @since 4.0.0
 * @category Models
 */
export interface DurableDeferred<
  Success extends Schema.Top,
  Error extends Schema.Top = Schema.Never
> {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly successSchema: Success
  readonly errorSchema: Error
  readonly exitSchema: Schema.Exit<Schema.Top, Schema.Top, Schema.Top>
  readonly withActivityAttempt: Effect.Effect<DurableDeferred<Success, Error>>
}

/**
 * @since 4.0.0
 * @category Models
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
  readonly name: string
}

/**
 * @since 4.0.0
 * @category Models
 */
export interface AnyWithProps {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly exitSchema: Schema.Exit<any, any, any>
}

/**
 * @since 4.0.0
 * @category Constructors
 */
export const make = <
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never
>(
  name: string,
  options?: {
    readonly success?: Success | undefined
    readonly error?: Error | undefined
  }
): DurableDeferred<Success, Error> => {
  const successSchema = options?.success ?? (Schema.Void as any as Success)
  const errorSchema = options?.error ?? (Schema.Never as any as Error)
  return {
    [TypeId]: TypeId as typeof TypeId,
    name,
    successSchema,
    errorSchema,
    exitSchema: Schema.Exit(
      Schema.toCodecJson(successSchema),
      Schema.toCodecJson(errorSchema),
      Schema.toCodecJson(Schema.Defect)
    ) as any,
    withActivityAttempt: Effect.gen(function*() {
      const attempt = yield* CurrentAttempt
      return make(`${name}/${attempt}`, {
        success: successSchema,
        error: errorSchema
      })
    })
  }
}

const EngineTag = ServiceMap.Service<WorkflowEngine, WorkflowEngine["Service"]>(
  "effect/workflow/WorkflowEngine" satisfies typeof WorkflowEngine.key
)

const InstanceTag = ServiceMap.Service<
  WorkflowInstance,
  WorkflowInstance["Service"]
>(
  "effect/workflow/WorkflowEngine/WorkflowInstance" satisfies typeof WorkflowInstance.key
)

const CurrentAttempt = ServiceMap.Reference<number>(
  "effect/workflow/Activity/CurrentAttempt" satisfies typeof Activity.CurrentAttempt.key,
  { defaultValue: () => 1 }
)

const await_: <Success extends Schema.Top, Error extends Schema.Top>(
  self: DurableDeferred<Success, Error>
) => Effect.Effect<
  Success["Type"],
  Error["Type"],
  | WorkflowEngine
  | WorkflowInstance
  | Success["DecodingServices"]
  | Error["DecodingServices"]
> = Effect.fnUntraced(function*<
  Success extends Schema.Top,
  Error extends Schema.Top
>(self: DurableDeferred<Success, Error>) {
  const engine = yield* EngineTag
  const instance = yield* InstanceTag
  const exit = yield* Workflow.wrapActivityResult(
    engine.deferredResult(self),
    Option.isNone
  )
  if (Option.isNone(exit)) {
    return yield* Workflow.suspend(instance)
  }
  return yield* exit.value as Exit.Exit<any, any>
})

export {
  /**
   * @since 4.0.0
   * @category Combinators
   */
  await_ as await
}

/**
 * @since 4.0.0
 * @category Combinators
 */
export const into: {
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>
  ): <R>(
    effect: Effect.Effect<Success["Type"], Error["Type"], R>
  ) => Effect.Effect<
    Success["Type"],
    Error["Type"],
    | R
    | WorkflowEngine
    | WorkflowInstance
    | Success["DecodingServices"]
    | Error["DecodingServices"]
  >
  <Success extends Schema.Top, Error extends Schema.Top, R>(
    effect: Effect.Effect<Success["Type"], Error["Type"], R>,
    self: DurableDeferred<Success, Error>
  ): Effect.Effect<
    Success["Type"],
    Error["Type"],
    | R
    | WorkflowEngine
    | WorkflowInstance
    | Success["DecodingServices"]
    | Error["DecodingServices"]
  >
} = dual(
  2,
  <Success extends Schema.Top, Error extends Schema.Top, R>(
    effect: Effect.Effect<Success["Type"], Error["Type"], R>,
    self: DurableDeferred<Success, Error>
  ): Effect.Effect<
    Success["Type"],
    Error["Type"],
    | R
    | WorkflowEngine
    | WorkflowInstance
    | Success["DecodingServices"]
    | Error["DecodingServices"]
  > =>
    Effect.servicesWith(
      (services: ServiceMap.ServiceMap<WorkflowEngine | WorkflowInstance>) => {
        const engine = ServiceMap.get(services, EngineTag)
        const instance = ServiceMap.get(services, InstanceTag)
        return Effect.onExit(
          effect,
          Effect.fnUntraced(function*(exit) {
            if (instance.suspended) return
            yield* engine.deferredDone(self, {
              workflowName: instance.workflow.name,
              executionId: instance.executionId,
              deferredName: self.name,
              exit
            })
          })
        )
      }
    )
)

/**
 * @since 4.0.0
 * @category Racing
 */
export const raceAll = <
  const Effects extends NonEmptyReadonlyArray<Effect.Effect<any, any, any>>,
  Success extends Schema.Schema<Effect.Success<Effects[number]>>,
  Error extends Schema.Schema<Effect.Error<Effects[number]>>
>(options: {
  name: string
  success: Success
  error: Error
  effects: Effects
}): Effect.Effect<
  Effect.Success<Effects[number]>,
  Effect.Error<Effects[number]>,
  | Effect.Services<Effects[number]>
  | Success["DecodingServices"]
  | Success["EncodingServices"]
  | Error["DecodingServices"]
  | Error["EncodingServices"]
  | WorkflowEngine
  | WorkflowInstance
> => {
  const deferred = make<any, any>(`raceAll/${options.name}`, {
    success: options.success,
    error: options.error
  })
  return Effect.gen(function*() {
    const engine = yield* EngineTag
    const exit = yield* engine.deferredResult(deferred)
    if (Option.isSome(exit)) {
      return yield* Effect.flatten(exit.value) as Effect.Effect<any, any, any>
    }
    return yield* into(Effect.raceAll(options.effects), deferred)
  })
}

/**
 * @since 4.0.0
 */
export const TokenTypeId = "~effect/workflow/DurableDeferred/Token"

/**
 * @since 4.0.0
 */
export type TokenTypeId = typeof TokenTypeId

/**
 * @since 4.0.0
 * @category Token
 */
export type Token = Brand.Branded<string, TokenTypeId>

/**
 * @since 4.0.0
 * @category Token
 */
export const Token: Schema.brand<Schema.String, TokenTypeId> = Schema.String.pipe(Schema.brand(TokenTypeId))

/**
 * @since 4.0.0
 * @category Token
 */
export class TokenParsed extends Schema.Class<TokenParsed>(
  "effect/workflow/DurableDeferred/TokenParsed"
)({
  workflowName: Schema.String,
  executionId: Schema.String,
  deferredName: Schema.String
}) {
  /**
   * @since 4.0.0
   */
  get asToken(): Token {
    return Encoding.encodeBase64Url(
      JSON.stringify([this.workflowName, this.executionId, this.deferredName])
    ) as Token
  }

  /**
   * @since 4.0.0
   */
  static readonly FromString = Schema.String.pipe(
    Schema.decodeTo(
      Schema.fromJsonString(
        Schema.Tuple([Schema.String, Schema.String, Schema.String])
      ),
      {
        decode: Getter.decodeBase64UrlString(),
        encode: Getter.encodeBase64Url()
      }
    ),
    Schema.decodeTo(TokenParsed, {
      decode: Getter.transform(
        ([workflowName, executionId, deferredName]) =>
          new TokenParsed({
            workflowName,
            executionId,
            deferredName
          })
      ),
      encode: Getter.transform(
        (parsed) =>
          [
            parsed.workflowName,
            parsed.executionId,
            parsed.deferredName
          ] as const
      )
    })
  )

  /**
   * @since 4.0.0
   */
  static readonly fromString = Schema.decodeSync(TokenParsed.FromString)

  /**
   * @since 4.0.0
   */
  static readonly encode = Schema.encodeSync(TokenParsed.FromString)
}

/**
 * @since 4.0.0
 * @category Token
 */
export const token: <Success extends Schema.Top, Error extends Schema.Top>(
  self: DurableDeferred<Success, Error>
) => Effect.Effect<Token, never, WorkflowInstance> = Effect.fnUntraced(
  function*<Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>
  ) {
    const instance = yield* InstanceTag
    return tokenFromExecutionId(self, instance)
  }
)

/**
 * @since 4.0.0
 * @category Token
 */
export const tokenFromExecutionId: {
  (options: {
    readonly workflow: Workflow.Any
    readonly executionId: string
  }): <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>
  ) => Token
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: { readonly workflow: Workflow.Any; readonly executionId: string }
  ): Token
} = dual(
  2,
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly workflow: Workflow.Any
      readonly executionId: string
    }
  ): Token =>
    new TokenParsed({
      workflowName: options.workflow.name,
      executionId: options.executionId,
      deferredName: self.name
    }).asToken
)

/**
 * @since 4.0.0
 * @category Token
 */
export const tokenFromPayload: {
  <W extends Workflow.Any>(options: {
    readonly workflow: W
    readonly payload: Workflow.PayloadSchema<W>["~type.make.in"]
  }): <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>
  ) => Effect.Effect<Token>
  <
    Success extends Schema.Top,
    Error extends Schema.Top,
    W extends Workflow.Any
  >(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly workflow: W
      readonly payload: Workflow.PayloadSchema<W>["~type.make.in"]
    }
  ): Effect.Effect<Token>
} = dual(
  2,
  <
    Success extends Schema.Top,
    Error extends Schema.Top,
    W extends Workflow.Any
  >(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly workflow: W
      readonly payload: Workflow.PayloadSchema<W>["~type.make.in"]
    }
  ): Effect.Effect<Token> =>
    Effect.map(options.workflow.executionId(options.payload), (executionId) =>
      tokenFromExecutionId(self, {
        workflow: options.workflow,
        executionId
      }))
)

/**
 * @since 4.0.0
 * @category Combinators
 */
export const done: {
  <Success extends Schema.Top, Error extends Schema.Top>(options: {
    readonly token: Token
    readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
  }): (
    self: DurableDeferred<Success, Error>
  ) => Effect.Effect<
    void,
    never,
    WorkflowEngine | Success["EncodingServices"] | Error["EncodingServices"]
  >
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
    }
  ): Effect.Effect<
    void,
    never,
    WorkflowEngine | Success["EncodingServices"] | Error["EncodingServices"]
  >
} = dual(
  2,
  Effect.fnUntraced(function*<
    Success extends Schema.Top,
    Error extends Schema.Top
  >(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
    }
  ) {
    const engine = yield* EngineTag
    const token = TokenParsed.fromString(options.token)
    yield* engine.deferredDone(self, {
      workflowName: token.workflowName,
      executionId: token.executionId,
      deferredName: token.deferredName,
      exit: options.exit
    })
  })
)

/**
 * @since 4.0.0
 * @category Combinators
 */
export const succeed: {
  <Success extends Schema.Top, Error extends Schema.Top>(options: {
    readonly token: Token
    readonly value: Success["Type"]
  }): (
    self: DurableDeferred<Success, Error>
  ) => Effect.Effect<void, never, WorkflowEngine | Success["EncodingServices"]>
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly value: Success["Type"]
    }
  ): Effect.Effect<void, never, WorkflowEngine | Success["EncodingServices"]>
} = dual(
  2,
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly value: Success["Type"]
    }
  ): Effect.Effect<void, never, WorkflowEngine | Success["EncodingServices"]> =>
    done(self, {
      token: options.token,
      exit: Exit.succeed(options.value)
    })
)

/**
 * @since 4.0.0
 * @category Combinators
 */
export const fail: {
  <Success extends Schema.Top, Error extends Schema.Top>(options: {
    readonly token: Token
    readonly error: Error["Type"]
  }): (
    self: DurableDeferred<Success, Error>
  ) => Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]>
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly error: Error["Type"]
    }
  ): Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]>
} = dual(
  2,
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly error: Error["Type"]
    }
  ): Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]> =>
    done(self, {
      token: options.token,
      exit: Exit.fail(options.error)
    })
)

/**
 * @since 4.0.0
 * @category Combinators
 */
export const failCause: {
  <Success extends Schema.Top, Error extends Schema.Top>(options: {
    readonly token: Token
    readonly cause: Cause.Cause<Error["Type"]>
  }): (
    self: DurableDeferred<Success, Error>
  ) => Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]>
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly cause: Cause.Cause<Error["Type"]>
    }
  ): Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]>
} = dual(
  2,
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly cause: Cause.Cause<Error["Type"]>
    }
  ): Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]> =>
    done(self, {
      token: options.token,
      exit: Exit.failCause(options.cause)
    })
)
