/**
 * @since 4.0.0
 */
import { dual } from "../../Function.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import type { Redacted } from "../../Redacted.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type { Covariant } from "../../Types.ts"

const TypeId = "~effect/httpapi/HttpApiSecurity"

/**
 * @since 4.0.0
 * @category models
 */
export type HttpApiSecurity = Bearer | ApiKey | Basic

/**
 * @since 4.0.0
 * @category models
 */
export declare namespace HttpApiSecurity {
  /**
   * @since 4.0.0
   * @category models
   */
  export interface Proto<out A> extends Pipeable {
    readonly [TypeId]: {
      readonly _A: Covariant<A>
    }
    readonly annotations: ServiceMap.ServiceMap<never>
  }

  /**
   * @since 4.0.0
   * @category models
   */
  export type Type<A extends HttpApiSecurity> = A extends Proto<infer Out> ? Out : never
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Bearer extends HttpApiSecurity.Proto<Redacted> {
  readonly _tag: "Bearer"
}

/**
 * @since 4.0.0
 * @category models
 */
export interface ApiKey extends HttpApiSecurity.Proto<Redacted> {
  readonly _tag: "ApiKey"
  readonly in: "header" | "query" | "cookie"
  readonly key: string
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Basic extends HttpApiSecurity.Proto<Credentials> {
  readonly _tag: "Basic"
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Credentials {
  readonly username: string
  readonly password: Redacted
}

const Proto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments)
  }
}

/**
 * Create an Bearer token security scheme.
 *
 * You can implement some api middleware for this security scheme using
 * `HttpApiBuilder.middlewareSecurity`.
 *
 * @since 4.0.0
 * @category constructors
 */
export const bearer: Bearer = Object.assign(Object.create(Proto), {
  _tag: "Bearer",
  annotations: ServiceMap.empty()
})

/**
 * Create an API key security scheme.
 *
 * You can implement some api middleware for this security scheme using
 * `HttpApiBuilder.middlewareSecurity`.
 *
 * To set the correct cookie in a handler, you can use
 * `HttpApiBuilder.securitySetCookie`.
 *
 * The default value for `in` is "header".
 *
 * @since 4.0.0
 * @category constructors
 */
export const apiKey = (options: {
  readonly key: string
  readonly in?: "header" | "query" | "cookie" | undefined
}): ApiKey =>
  Object.assign(Object.create(Proto), {
    _tag: "ApiKey",
    key: options.key,
    in: options.in ?? "header",
    annotations: ServiceMap.empty()
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const basic: Basic = Object.assign(Object.create(Proto), {
  _tag: "Basic",
  annotations: ServiceMap.empty()
})

/**
 * @since 4.0.0
 * @category annotations
 */
export const annotateMerge: {
  <I>(annotations: ServiceMap.ServiceMap<I>): <A extends HttpApiSecurity>(self: A) => A
  <A extends HttpApiSecurity, I>(self: A, annotations: ServiceMap.ServiceMap<I>): A
} = dual(
  2,
  <A extends HttpApiSecurity, I>(self: A, annotations: ServiceMap.ServiceMap<I>): A =>
    Object.assign(Object.create(Proto), {
      ...self,
      annotations: ServiceMap.merge(self.annotations, annotations)
    })
)

/**
 * @since 4.0.0
 * @category annotations
 */
export const annotate: {
  <I, S>(service: ServiceMap.Key<I, S>, value: S): <A extends HttpApiSecurity>(self: A) => A
  <A extends HttpApiSecurity, I, S>(self: A, service: ServiceMap.Key<I, S>, value: S): A
} = dual(
  3,
  <A extends HttpApiSecurity, I, S>(self: A, service: ServiceMap.Key<I, S>, value: S): A =>
    Object.assign(Object.create(Proto), {
      ...self,
      annotations: ServiceMap.add(self.annotations, service, value)
    })
)
