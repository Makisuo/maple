/**
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import * as Context from "../../Context.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import * as Predicate from "../../Predicate.ts"
import * as Record from "../../Record.ts"
import type * as Schema from "../../Schema.ts"
import type * as AST from "../../SchemaAST.ts"
import type { Mutable } from "../../Types.ts"
import type { PathInput } from "../http/HttpRouter.ts"
import * as HttpApiEndpoint from "./HttpApiEndpoint.ts"
import type * as HttpApiGroup from "./HttpApiGroup.ts"
import type * as HttpApiMiddleware from "./HttpApiMiddleware.ts"
import * as HttpApiSchema from "./HttpApiSchema.ts"

const TypeId = "~effect/httpapi/HttpApi"

/**
 * @since 4.0.0
 * @category guards
 */
export const isHttpApi = (u: unknown): u is Any => Predicate.hasProperty(u, TypeId)

/**
 * An `HttpApi` is a collection of `HttpApiEndpoint`s. You can use an `HttpApi` to
 * represent a portion of your domain.
 *
 * The endpoints can be implemented later using the `HttpApiBuilder.make` api.
 *
 * @since 4.0.0
 * @category models
 */
export interface HttpApi<
  out Id extends string,
  out Groups extends HttpApiGroup.Any = never
> extends Pipeable {
  new(_: never): {}
  readonly [TypeId]: typeof TypeId
  readonly identifier: Id
  readonly groups: Record.ReadonlyRecord<string, Groups>
  readonly annotations: Context.Context<never>

  /**
   * Add a `HttpApiGroup` to the `HttpApi`.
   */
  add<A extends NonEmptyReadonlyArray<HttpApiGroup.Any>>(...groups: A): HttpApi<Id, Groups | A[number]>

  /**
   * Add another `HttpApi` to the `HttpApi`.
   */
  addHttpApi<Id2 extends string, Groups2 extends HttpApiGroup.Any>(
    api: HttpApi<Id2, Groups2>
  ): HttpApi<Id, Groups | Groups2>

  /**
   * Prefix all endpoints in the `HttpApi`.
   */
  prefix<const Prefix extends PathInput>(prefix: Prefix): HttpApi<Id, HttpApiGroup.AddPrefix<Groups, Prefix>>

  /**
   * Add a middleware to a `HttpApi`. It will be applied to all endpoints in the
   * `HttpApi`.
   *
   * Note that this will only add the middleware to the endpoints **before** this
   * api is called.
   */
  middleware<I extends HttpApiMiddleware.AnyId, S>(
    middleware: Context.Key<I, S>
  ): HttpApi<Id, HttpApiGroup.AddMiddleware<Groups, I>>

  /**
   * Annotate the `HttpApi`.
   */
  annotate<I, S>(tag: Context.Key<I, S>, value: S): HttpApi<Id, Groups>

  /**
   * Annotate the `HttpApi` with a Context.
   */
  annotateMerge<I>(context: Context.Context<I>): HttpApi<Id, Groups>
}

/**
 * @since 4.0.0
 * @category models
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
}

/**
 * @since 4.0.0
 * @category models
 */
export type AnyWithProps = HttpApi<string, HttpApiGroup.AnyWithProps>

const Proto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments)
  },
  add(
    this: AnyWithProps,
    ...toAdd: NonEmptyReadonlyArray<HttpApiGroup.AnyWithProps>
  ) {
    const groups = { ...this.groups }
    for (const group of toAdd) {
      groups[group.identifier] = group
    }
    return makeProto({
      identifier: this.identifier,
      groups,
      annotations: this.annotations
    })
  },
  addHttpApi(
    this: AnyWithProps,
    api: AnyWithProps
  ) {
    const newGroups = { ...this.groups }
    for (const key in api.groups) {
      const newGroup: Mutable<HttpApiGroup.AnyWithProps> = api.groups[key]
      newGroup.annotations = Context.merge(api.annotations, newGroup.annotations)
      newGroups[key] = newGroup as any
    }
    return makeProto({
      identifier: this.identifier,
      groups: newGroups,
      annotations: this.annotations
    })
  },
  prefix(this: AnyWithProps, prefix: PathInput) {
    return makeProto({
      identifier: this.identifier,
      groups: Record.map(this.groups, (group) => group.prefix(prefix)),
      annotations: this.annotations
    })
  },
  middleware(this: AnyWithProps, tag: HttpApiMiddleware.AnyService) {
    return makeProto({
      identifier: this.identifier,
      groups: Record.map(this.groups, (group) => group.middleware(tag as any)),
      annotations: this.annotations
    })
  },
  annotate(this: AnyWithProps, key: Context.Key<any, any>, value: any) {
    return makeProto({
      identifier: this.identifier,
      groups: this.groups,
      annotations: Context.add(this.annotations, key, value)
    })
  },
  annotateMerge(this: AnyWithProps, annotations: Context.Context<never>) {
    return makeProto({
      identifier: this.identifier,
      groups: this.groups,
      annotations: Context.merge(this.annotations, annotations)
    })
  }
}

const makeProto = <Id extends string, Groups extends HttpApiGroup.Any>(
  options: {
    readonly identifier: Id
    readonly groups: Record.ReadonlyRecord<string, Groups>
    readonly annotations: Context.Context<never>
  }
): HttpApi<Id, Groups> => {
  function HttpApi() {}
  Object.setPrototypeOf(HttpApi, Proto)
  HttpApi.groups = options.groups
  HttpApi.annotations = options.annotations
  return HttpApi as any
}

/**
 * An `HttpApi` is a collection of `HttpApiEndpoint`s. You can use an `HttpApi` to
 * represent a portion of your domain.
 *
 * You can then use `HttpApiBuilder.layer(api)` to implement the endpoints of the
 * `HttpApi`.
 *
 * @since 4.0.0
 * @category constructors
 */
export const make = <const Id extends string>(identifier: Id): HttpApi<Id, never> =>
  makeProto({
    identifier,
    groups: new Map() as any,
    annotations: Context.empty()
  })

/**
 * @since 4.0.0
 * @category Reflection
 */
export const reflect = <Id extends string, Groups extends HttpApiGroup.Any>(
  self: HttpApi<Id, Groups>,
  options: {
    readonly predicate?:
      | Predicate.Predicate<{
        readonly endpoint: HttpApiEndpoint.AnyWithProps
        readonly group: HttpApiGroup.AnyWithProps
      }>
      | undefined
    readonly onGroup: (options: {
      readonly group: HttpApiGroup.AnyWithProps
      readonly mergedAnnotations: Context.Context<never>
    }) => void
    readonly onEndpoint: (options: {
      readonly group: HttpApiGroup.AnyWithProps
      readonly endpoint: HttpApiEndpoint.AnyWithProps
      readonly mergedAnnotations: Context.Context<never>
      readonly middleware: ReadonlySet<HttpApiMiddleware.AnyService>
      readonly successes: ReadonlyMap<number, readonly [Schema.Top, ...Array<Schema.Top>]>
      readonly errors: ReadonlyMap<number, readonly [Schema.Top, ...Array<Schema.Top>]>
    }) => void
  }
) => {
  const groups = Object.values(self.groups) as any as Array<HttpApiGroup.AnyWithProps>
  for (const group of groups) {
    const groupAnnotations = Context.merge(self.annotations, group.annotations)
    options.onGroup({
      group,
      mergedAnnotations: groupAnnotations
    })
    const endpoints = Object.values(group.endpoints) as Iterable<HttpApiEndpoint.AnyWithProps>
    for (const endpoint of endpoints) {
      if (
        options.predicate && !options.predicate({
          endpoint,
          group
        } as any)
      ) continue

      options.onEndpoint({
        group,
        endpoint,
        middleware: endpoint.middlewares as any,
        mergedAnnotations: Context.merge(groupAnnotations, endpoint.annotations),
        successes: extractResponseContent(
          HttpApiEndpoint.getSuccessSchemas(endpoint),
          HttpApiSchema.getStatusSuccess
        ),
        errors: extractResponseContent(
          HttpApiEndpoint.getErrorSchemas(endpoint),
          HttpApiSchema.getStatusError
        )
      })
    }
  }
}

// -------------------------------------------------------------------------------------

const extractResponseContent = (
  schemas: Array<Schema.Top>,
  getStatus: (ast: AST.AST) => number
): ReadonlyMap<number, [Schema.Top, ...Array<Schema.Top>]> => {
  const map = new Map<number, [Schema.Top, ...Array<Schema.Top>]>()

  schemas.forEach(add)

  return map

  function add(schema: Schema.Top) {
    const ast = schema.ast
    const status = getStatus(ast)
    const schemas = map.get(status)
    if (schemas === undefined) {
      map.set(status, [schema])
    } else {
      schemas.push(schema)
    }
  }
}

/**
 * Adds additional schemas to components/schemas.
 * The provided schemas must have a `identifier` annotation.
 *
 * @since 4.0.0
 * @category tags
 */
export class AdditionalSchemas extends Context.Service<
  AdditionalSchemas,
  ReadonlyArray<Schema.Top>
>()("effect/httpapi/HttpApi/AdditionalSchemas") {}
