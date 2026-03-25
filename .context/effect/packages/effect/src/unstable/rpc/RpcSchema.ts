/**
 * @since 4.0.0
 */
import * as Cause from "../../Cause.ts"
import { constUndefined } from "../../Function.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import type * as AST from "../../SchemaAST.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as Stream_ from "../../Stream.ts"

const StreamSchemaTypeId = "~effect/rpc/RpcSchema/StreamSchema"

/**
 * @since 4.0.0
 * @category Stream
 */
export function isStreamSchema(schema: Schema.Top): schema is Stream<Schema.Top, Schema.Top> {
  return Predicate.hasProperty(schema, StreamSchemaTypeId)
}

/** @internal */
export function getStreamSchemas(schema: Schema.Top): Option.Option<{
  readonly success: Schema.Top
  readonly error: Schema.Top
}> {
  return isStreamSchema(schema) ?
    Option.some({
      success: schema.success,
      error: schema.error
    }) :
    Option.none()
}

/**
 * @since 4.0.0
 * @category Stream
 */
export interface Stream<A extends Schema.Top, E extends Schema.Top> extends
  Schema.Bottom<
    Stream_.Stream<A["Type"], E["Type"]>,
    Stream_.Stream<A["Encoded"], E["Encoded"]>,
    A["DecodingServices"] | E["DecodingServices"],
    A["EncodingServices"] | E["EncodingServices"],
    AST.Declaration,
    Stream<A, E>
  >
{
  readonly "~rebuild.out": this
  readonly [StreamSchemaTypeId]: typeof StreamSchemaTypeId
  readonly success: A
  readonly error: E
}

const schema = Schema.declare(Stream_.isStream)

/**
 * @since 4.0.0
 * @category Stream
 */
export function Stream<A extends Schema.Top, E extends Schema.Top>(success: A, error: E): Stream<A, E> {
  return Schema.make(schema.ast, { [StreamSchemaTypeId]: StreamSchemaTypeId, success, error })
}

/**
 * @since 4.0.0
 * @category Cause annotations
 */
export class ClientAbort extends ServiceMap.Service<ClientAbort, true>()("effect/rpc/RpcSchema/ClientAbort") {
  static annotation = this.serviceMap(true).pipe(
    ServiceMap.add(Cause.StackTrace, {
      name: "ClientAbort",
      stack: constUndefined,
      parent: undefined
    })
  )
}
