/**
 * @since 4.0.0
 */
import { identity } from "./Function.ts"
import * as Schema from "./Schema.ts"
import * as Transformation from "./SchemaTransformation.ts"

/**
 * @since 4.0.0
 * @experimental
 */
export function getNativeClassSchema<C extends new(...args: any) => any, S extends Schema.Struct<Schema.Struct.Fields>>(
  constructor: C,
  options: {
    readonly encoding: S
    readonly annotations?: Schema.Annotations.Declaration<InstanceType<C>>
  }
): Schema.decodeTo<Schema.instanceOf<InstanceType<C>, S["Iso"]>, S> {
  const transformation = Transformation.transform<InstanceType<C>, S["Type"]>({
    decode: (props) => new constructor(props),
    encode: identity
  })
  return Schema.instanceOf(constructor, {
    toCodec: () => Schema.link<InstanceType<C>>()(options.encoding, transformation),
    ...options.annotations
  }).pipe(Schema.encodeTo(options.encoding, transformation))
}
