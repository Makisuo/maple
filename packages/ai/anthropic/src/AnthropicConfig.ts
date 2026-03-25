/**
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as ServiceMap from "effect/ServiceMap"
import type { HttpClient } from "effect/unstable/http/HttpClient"

/**
 * @since 1.0.0
 * @category services
 */
export class AnthropicConfig extends ServiceMap.Service<
  AnthropicConfig,
  AnthropicConfig.Service
>()("@effect/ai-anthropic/AnthropicConfig") {
  /**
   * @since 1.0.0
   */
  static readonly getOrUndefined: Effect.Effect<typeof AnthropicConfig.Service | undefined> = Effect.map(
    Effect.services<never>(),
    (services) => services.mapUnsafe.get(AnthropicConfig.key)
  )
}

/**
 * @since 1.0.0
 */
export declare namespace AnthropicConfig {
  /**
   * @since 1.0.0
   * @category models
   */
  export interface Service {
    readonly transformClient?: ((client: HttpClient) => HttpClient) | undefined
  }
}

/**
 * @since 1.0.0
 * @category configuration
 */
export const withClientTransform: {
  (transform: (client: HttpClient) => HttpClient): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(self: Effect.Effect<A, E, R>, transform: (client: HttpClient) => HttpClient): Effect.Effect<A, E, R>
} = dual(2, <A, E, R>(
  self: Effect.Effect<A, E, R>,
  transformClient: (client: HttpClient) => HttpClient
) =>
  Effect.flatMap(
    AnthropicConfig.getOrUndefined,
    (config) => Effect.provideService(self, AnthropicConfig, { ...config, transformClient })
  ))
