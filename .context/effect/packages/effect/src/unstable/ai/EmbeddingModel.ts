/**
 * The `EmbeddingModel` module provides provider-agnostic text embedding capabilities.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { EmbeddingModel } from "effect/unstable/ai"
 *
 * const program = Effect.gen(function*() {
 *   const model = yield* EmbeddingModel.EmbeddingModel
 *   return yield* model.embed("hello world")
 * })
 * ```
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Request from "../../Request.ts"
import * as RequestResolver from "../../RequestResolver.ts"
import * as Schema from "../../Schema.ts"
import * as AiError from "./AiError.ts"

/**
 * Service tag for embedding model operations.
 *
 * @since 4.0.0
 * @category services
 */
export class EmbeddingModel extends Context.Service<EmbeddingModel, Service>()(
  "effect/unstable/ai/EmbeddingModel"
) {}

/**
 * Service tag that provides the current embedding dimensions.
 *
 * @since 4.0.0
 * @category services
 */
export class Dimensions extends Context.Service<Dimensions, number>()(
  "effect/unstable/ai/EmbeddingModel/Dimensions"
) {}

/**
 * Token usage metadata for embedding operations.
 *
 * @since 4.0.0
 * @category models
 */
export class EmbeddingUsage extends Schema.Class<EmbeddingUsage>(
  "effect/ai/EmbeddingModel/EmbeddingUsage"
)({
  inputTokens: Schema.UndefinedOr(Schema.Finite)
}) {}

/**
 * Response for a single embedding request.
 *
 * @since 4.0.0
 * @category models
 */
export class EmbedResponse extends Schema.Class<EmbedResponse>(
  "effect/ai/EmbeddingModel/EmbedResponse"
)({
  vector: Schema.Array(Schema.Finite)
}) {}

/**
 * Response for multiple embeddings.
 *
 * @since 4.0.0
 * @category models
 */
export class EmbedManyResponse extends Schema.Class<EmbedManyResponse>(
  "effect/ai/EmbeddingModel/EmbedManyResponse"
)({
  embeddings: Schema.Array(EmbedResponse),
  usage: EmbeddingUsage
}) {}

/**
 * Provider input options for embedding requests.
 *
 * @since 4.0.0
 * @category models
 */
export interface ProviderOptions {
  readonly inputs: ReadonlyArray<string>
}

/**
 * Provider response for batch embedding requests.
 *
 * @since 4.0.0
 * @category models
 */
export interface ProviderResponse {
  readonly results: Array<Array<number>>
  readonly usage: {
    readonly inputTokens: number | undefined
  }
}

/**
 * Tagged request used by request resolvers for embedding operations.
 *
 * @since 4.0.0
 * @category constructors
 */
export class EmbeddingRequest extends Request.TaggedClass("EmbeddingRequest")<
  { readonly input: string },
  EmbedResponse,
  AiError.AiError
> {}

/**
 * Service interface for embedding operations.
 *
 * @since 4.0.0
 * @category models
 */
export interface Service {
  readonly resolver: RequestResolver.RequestResolver<EmbeddingRequest>
  readonly embed: (input: string) => Effect.Effect<EmbedResponse, AiError.AiError>
  readonly embedMany: (input: ReadonlyArray<string>) => Effect.Effect<EmbedManyResponse, AiError.AiError>
}

const invalidProviderResponse = (description: string): AiError.AiError =>
  AiError.make({
    module: "EmbeddingModel",
    method: "embedMany",
    reason: new AiError.InvalidOutputError({ description })
  })

/**
 * Creates an EmbeddingModel service from a provider embedMany implementation.
 *
 * @since 4.0.0
 * @category constructors
 */
export const make: (params: {
  readonly embedMany: (options: ProviderOptions) => Effect.Effect<ProviderResponse, AiError.AiError>
}) => Effect.Effect<Service> = Effect.fnUntraced(function*(params) {
  const resolver = RequestResolver.make<EmbeddingRequest>((entries) =>
    Effect.flatMap(
      params.embedMany({
        inputs: entries.map((entry) => entry.request.input)
      }),
      (response) =>
        Effect.map(mapProviderResults(entries.length, response.results), (embeddings) => {
          for (let i = 0; i < entries.length; i++) {
            entries[i].completeUnsafe(Exit.succeed(embeddings[i]))
          }
        })
    )
  ).pipe(
    RequestResolver.withSpan("EmbeddingModel.resolver")
  )

  return EmbeddingModel.of({
    resolver,
    embed: (input) =>
      Effect.request(new EmbeddingRequest({ input }), resolver).pipe(
        Effect.withSpan("EmbeddingModel.embed")
      ),
    embedMany: (input) =>
      (input.length === 0
        ? Effect.succeed(
          new EmbedManyResponse({
            embeddings: [],
            usage: new EmbeddingUsage({ inputTokens: undefined })
          })
        )
        : params.embedMany({ inputs: input }).pipe(
          Effect.flatMap((response) =>
            mapProviderResults(input.length, response.results).pipe(
              Effect.map((embeddings) =>
                new EmbedManyResponse({
                  embeddings,
                  usage: new EmbeddingUsage({
                    inputTokens: response.usage.inputTokens
                  })
                })
              )
            )
          )
        )).pipe(Effect.withSpan("EmbeddingModel.embedMany"))
  })
})

const mapProviderResults = (
  inputLength: number,
  results: Array<Array<number>>
): Effect.Effect<Array<EmbedResponse>, AiError.AiError> => {
  const embeddings = new Array<EmbedResponse>(inputLength)
  if (results.length !== inputLength) {
    return Effect.fail(
      invalidProviderResponse(
        `Provider returned ${results.length} embeddings but expected ${inputLength}`
      )
    )
  }
  for (let i = 0; i < results.length; i++) {
    const vector = results[i]
    embeddings[i] = new EmbedResponse({ vector })
  }
  return Effect.succeed(embeddings)
}
