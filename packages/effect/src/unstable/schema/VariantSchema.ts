/**
 * @since 4.0.0
 */
import type { Brand } from "../../Brand.ts"
import * as Effect from "../../Effect.ts"
import { dual } from "../../Function.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import type * as AST from "../../SchemaAST.ts"
import * as Struct_ from "../../Struct.ts"

/**
 * @since 4.0.0
 * @category Type IDs
 */
export const TypeId = "~effect/schema/VariantSchema"

const cacheSymbol = Symbol.for(`${TypeId}/cache`)

/**
 * @since 4.0.0
 * @category models
 */
export interface Struct<in out A extends Field.Fields> extends Pipeable {
  readonly [TypeId]: A
  /** @internal */
  [cacheSymbol]?: Record<string, Schema.Top>
}

/**
 * @since 4.0.0
 * @category guards
 */
export const isStruct = (u: unknown): u is Struct<any> => Predicate.hasProperty(u, TypeId)

/**
 * @since 4.0.0
 * @category models
 */
export declare namespace Struct {
  /**
   * @since 4.0.0
   * @category models
   */
  export type Any = { readonly [TypeId]: any }

  /**
   * @since 4.0.0
   * @category models
   */
  export type Fields = {
    readonly [key: string]:
      | Schema.Top
      | Field<any>
      | Struct<any>
      | undefined
  }

  /**
   * @since 4.0.0
   * @category models
   */
  export type Validate<A, Variant extends string> = {
    readonly [K in keyof A]: A[K] extends { readonly [TypeId]: infer _ } ? Validate<A[K], Variant> :
      A[K] extends Field<infer Config> ? [keyof Config] extends [Variant] ? {} : "field must have valid variants"
      : {}
  }
}

const FieldTypeId = "~effect/schema/VariantSchema/Field"

/**
 * @since 4.0.0
 * @category models
 */
export interface Field<in out A extends Field.Config> extends Pipeable {
  readonly [FieldTypeId]: typeof FieldTypeId
  readonly schemas: A
}

/**
 * @since 4.0.0
 * @category guards
 */
export const isField = (u: unknown): u is Field<any> => Predicate.hasProperty(u, FieldTypeId)

/**
 * @since 4.0.0
 * @category models
 */
export declare namespace Field {
  /**
   * @since 4.0.0
   * @category models
   */
  export type Any = { readonly [FieldTypeId]: typeof FieldTypeId }

  /**
   * @since 4.0.0
   * @category models
   */
  export type Config = {
    readonly [key: string]: Schema.Top | undefined
  }

  /**
   * @since 4.0.0
   * @category models
   */
  export type ConfigWithKeys<K extends string> = {
    readonly [P in K]?: Schema.Top
  }

  /**
   * @since 4.0.0
   * @category models
   */
  export type Fields = {
    readonly [key: string]:
      | Schema.Top
      | Field<any>
      | Struct<any>
      | undefined
  }
}

/**
 * @since 4.0.0
 * @category extractors
 */
export type ExtractFields<V extends string, Fields extends Struct.Fields, IsDefault = false> = {
  readonly [
    K in keyof Fields as [Fields[K]] extends [Field<infer Config>] ? V extends keyof Config ? K
      : never
      : K
  ]: [Fields[K]] extends [Struct<infer _>] ? Extract<V, Fields[K], IsDefault>
    : [Fields[K]] extends [Field<infer Config>] ? [Config[V]] extends [Schema.Top] ? Config[V]
      : never
    : [Fields[K]] extends [Schema.Top] ? Fields[K]
    : never
}

/**
 * @since 4.0.0
 * @category extractors
 */
export type Extract<V extends string, A extends Struct<any>, IsDefault = false> = [A] extends [
  Struct<infer Fields>
] ? IsDefault extends true ? [A] extends [Schema.Top] ? A : Schema.Struct<Struct_.Simplify<ExtractFields<V, Fields>>>
  : Schema.Struct<Struct_.Simplify<ExtractFields<V, Fields>>>
  : never

const extract: {
  <V extends string, const IsDefault extends boolean = false>(
    variant: V,
    options?: {
      readonly isDefault?: IsDefault | undefined
    }
  ): <A extends Struct<any>>(self: A) => Extract<V, A, IsDefault>
  <V extends string, A extends Struct<any>, const IsDefault extends boolean = false>(self: A, variant: V, options?: {
    readonly isDefault?: IsDefault | undefined
  }): Extract<V, A, IsDefault>
} = dual(
  (args) => isStruct(args[0]),
  <V extends string, A extends Struct<any>>(
    self: A,
    variant: V,
    options?: {
      readonly isDefault?: boolean | undefined
    }
  ): Extract<V, A> => {
    const cache = self[cacheSymbol] ?? (self[cacheSymbol] = {})
    const cacheKey = options?.isDefault === true ? "__default" : variant
    if (cache[cacheKey] !== undefined) {
      return cache[cacheKey] as any
    }
    const fields: Record<string, any> = {}
    for (const key of Object.keys(self[TypeId])) {
      const value = self[TypeId][key]
      if (TypeId in value) {
        if (options?.isDefault === true && Schema.isSchema(value)) {
          fields[key] = value
        } else {
          fields[key] = extract(value, variant)
        }
      } else if (FieldTypeId in value) {
        if (variant in value.schemas) {
          fields[key] = value.schemas[variant]
        }
      } else {
        fields[key] = value
      }
    }
    return cache[cacheKey] = Schema.Struct(fields) as any
  }
)

/**
 * @category accessors
 * @since 4.0.0
 */
export const fields = <A extends Struct<any>>(self: A): A[typeof TypeId] => self[TypeId]

/**
 * @since 4.0.0
 * @category models
 */
export interface Class<
  Self,
  Fields extends Struct.Fields,
  S extends Schema.Top & {
    readonly fields: Schema.Struct.Fields
  }
> extends
  Schema.Bottom<
    Self,
    S["Encoded"],
    S["DecodingServices"],
    S["EncodingServices"],
    AST.Declaration,
    Schema.decodeTo<Schema.declareConstructor<Self, S["Encoded"], readonly [S], S["Iso"]>, S>,
    S["~type.make.in"],
    S["Iso"],
    readonly [S],
    Self,
    S["~type.mutability"],
    S["~type.optionality"],
    S["~type.constructor.default"],
    S["~encoded.mutability"],
    S["~encoded.optionality"]
  >,
  Struct<Struct_.Simplify<Fields>>
{
  new(
    props: S["~type.make.in"],
    options?: {
      readonly disableChecks?: boolean
    } | undefined
  ): S["Type"]

  make<Args extends Array<any>, X>(
    this: { new(...args: Args): X },
    ...args: Args
  ): X

  readonly fields: S["fields"]
}

type MissingSelfGeneric<Params extends string = ""> =
  `Missing \`Self\` generic - use \`class Self extends Class<Self>()(${Params}{ ... })\``

/**
 * @since 4.0.0
 * @category models
 */
export interface Union<Members extends ReadonlyArray<Struct<any>>> extends
  Schema.Union<
    {
      readonly [K in keyof Members]: [Members[K]] extends [Schema.Top] ? Members[K] : never
    }
  >
{}

/**
 * @since 4.0.0
 * @category models
 */
export declare namespace Union {
  /**
   * @since 4.0.0
   * @category models
   */
  export type Variants<Members extends ReadonlyArray<Struct<any>>, Variants extends string> = {
    readonly [Variant in Variants]: Schema.Union<
      {
        [K in keyof Members]: Extract<Variant, Members[K]>
      }
    >
  }
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = <
  const Variants extends ReadonlyArray<string>,
  const Default extends Variants[number]
>(options: {
  readonly variants: Variants
  readonly defaultVariant: Default
}): {
  readonly Struct: <const A extends Struct.Fields>(
    fields: A & Struct.Validate<A, Variants[number]>
  ) => Struct<A>
  readonly Field: <const A extends Field.ConfigWithKeys<Variants[number]>>(
    config: A & { readonly [K in Exclude<keyof A, Variants[number]>]: never }
  ) => Field<A>
  readonly FieldOnly: <const Keys extends ReadonlyArray<Variants[number]>>(
    keys: Keys
  ) => <S extends Schema.Top>(
    schema: S
  ) => Field<{ readonly [K in Keys[number]]: S }>
  readonly FieldExcept: <const Keys extends ReadonlyArray<Variants[number]>>(
    keys: Keys
  ) => <S extends Schema.Top>(
    schema: S
  ) => Field<{ readonly [K in Exclude<Variants[number], Keys[number]>]: S }>
  readonly fieldEvolve: {
    <
      Self extends Field<any> | Schema.Top,
      const Mapping extends (Self extends Field<infer S> ? { readonly [K in keyof S]?: (variant: S[K]) => Schema.Top }
        : { readonly [K in Variants[number]]?: (variant: Self) => Schema.Top })
    >(f: Mapping): (self: Self) => Field<
      Self extends Field<infer S> ? {
          readonly [K in keyof S]: K extends keyof Mapping
            ? Mapping[K] extends (arg: any) => any ? ReturnType<Mapping[K]> : S[K]
            : S[K]
        } :
        {
          readonly [K in Variants[number]]: K extends keyof Mapping
            ? Mapping[K] extends (arg: any) => any ? ReturnType<Mapping[K]> : Self
            : Self
        }
    >
    <
      Self extends Field<any> | Schema.Top,
      const Mapping extends (Self extends Field<infer S> ? {
          readonly [K in keyof S]?: (variant: S[K]) => Schema.Top
        }
        : { readonly [K in Variants[number]]?: (variant: Self) => Schema.Top })
    >(self: Self, f: Mapping): Field<
      Self extends Field<infer S> ? {
          readonly [K in keyof S]: K extends keyof Mapping
            ? Mapping[K] extends (arg: any) => any ? ReturnType<Mapping[K]> : S[K]
            : S[K]
        } :
        {
          readonly [K in Variants[number]]: K extends keyof Mapping
            ? Mapping[K] extends (arg: any) => any ? ReturnType<Mapping[K]> : Self
            : Self
        }
    >
  }
  readonly Class: <Self = never>(
    identifier: string
  ) => <const Fields extends Struct.Fields>(
    fields: Fields & Struct.Validate<Fields, Variants[number]>,
    annotations?:
      | Schema.Annotations.Declaration<Self, readonly [Schema.Struct<ExtractFields<Default, Fields, true>>]>
      | undefined
  ) => [Self] extends [never] ? MissingSelfGeneric
    :
      & Class<
        Self,
        Fields,
        Schema.Struct<ExtractFields<Default, Fields, true>>
      >
      & {
        readonly [V in Variants[number]]: Extract<V, Struct<Fields>>
      }
  readonly Union: <const Members extends ReadonlyArray<Struct<any>>>(
    members: Members
  ) => Union<Members> & Union.Variants<Members, Variants[number]>
  readonly extract: {
    <V extends Variants[number]>(
      variant: V
    ): <A extends Struct<any>>(self: A) => Extract<V, A, V extends Default ? true : false>
    <V extends Variants[number], A extends Struct<any>>(
      self: A,
      variant: V
    ): Extract<V, A, V extends Default ? true : false>
  }
} => {
  function Class<Self>(identifier: string) {
    return function(
      fields: Struct.Fields,
      annotations?: Schema.Annotations.Declaration<
        Self,
        readonly [Schema.Struct<ExtractFields<Default, typeof fields, true>>]
      >
    ) {
      const variantStruct = Struct(fields)
      const schema = extract(variantStruct, options.defaultVariant, {
        isDefault: true
      })
      const SClass = Schema.Class as any
      class Base extends SClass(identifier)(schema.fields, annotations) {
        static [TypeId] = fields
      }
      for (const variant of options.variants) {
        Object.defineProperty(Base, variant, {
          value: extract(variantStruct, variant).annotate({
            id: `${identifier}.${variant}`,
            title: `${identifier}.${variant}`
          })
        })
      }
      return Base
    }
  }
  function FieldOnly<const Keys extends ReadonlyArray<Variants[number]>>(keys: Keys) {
    return function<S extends Schema.Top>(schema: S) {
      const obj: Record<string, S> = {}
      for (const key of keys) {
        obj[key] = schema
      }
      return Field(obj)
    }
  }
  function FieldExcept<const Keys extends ReadonlyArray<Variants[number]>>(keys: Keys) {
    return function<S extends Schema.Top>(schema: S) {
      const obj: Record<string, S> = {}
      for (const variant of options.variants) {
        if (!keys.includes(variant)) {
          obj[variant] = schema
        }
      }
      return Field(obj)
    }
  }
  function UnionVariants(members: ReadonlyArray<Struct<any>>) {
    return Union(members, options.variants)
  }
  const fieldEvolve = dual(
    2,
    (
      self: Field<any> | Schema.Top,
      f: Record<string, (schema: Schema.Top) => Schema.Top>
    ): Field<any> => {
      const field = isField(self) ? self : Field(Object.fromEntries(
        options.variants.map((variant) => [variant, self])
      ))
      return Field(Struct_.evolve(field.schemas, f))
    }
  )
  const extractVariants = dual(
    2,
    (self: Struct<any>, variant: string): any =>
      extract(self, variant, {
        isDefault: variant === options.defaultVariant
      })
  )
  return {
    Struct,
    Field,
    FieldOnly,
    FieldExcept,
    Class,
    Union: UnionVariants,
    fieldEvolve,
    // fieldFromKey,
    extract: extractVariants
  } as any
}

/**
 * @since 4.0.0
 * @category overrideable
 */
export const Override = <A>(value: A): A & Brand<"Override"> => value as any

/**
 * @since 4.0.0
 * @category overrideable
 */
export interface Overrideable<S extends Schema.Top & Schema.WithoutConstructorDefault> extends
  Schema.Bottom<
    S["Type"] & Brand<"Override">,
    S["Encoded"],
    S["DecodingServices"],
    S["EncodingServices"],
    S["ast"],
    Overrideable<S>,
    S["~type.make.in"],
    (S["Type"] & Brand<"Override">) | undefined,
    S["~type.parameters"],
    (S["Type"] & Brand<"Override">) | undefined,
    S["~type.mutability"],
    "required",
    "with-default",
    S["~encoded.mutability"],
    S["~encoded.optionality"]
  >
{}

/**
 * @since 4.0.0
 * @category overrideable
 */
export const Overrideable = <S extends Schema.Top & Schema.WithoutConstructorDefault>(
  schema: S,
  options: {
    readonly defaultValue: Effect.Effect<S["~type.make.in"]>
  }
): Overrideable<S> =>
  schema.pipe(
    Schema.decodeTo(Schema.brand("Override")(Schema.toType(schema))),
    Schema.withConstructorDefault(Effect.map(options.defaultValue, Override))
  ) as any

const StructProto = {
  pipe() {
    return pipeArguments(this, arguments)
  }
}

const Struct = <const A extends Field.Fields>(fields: A): Struct<A> => {
  const self = Object.create(StructProto)
  self[TypeId] = fields
  return self
}

const FieldProto = {
  [FieldTypeId]: FieldTypeId,
  pipe() {
    return pipeArguments(this, arguments)
  }
}

const Field = <const A extends Field.Config>(schemas: A): Field<A> => {
  const self = Object.create(FieldProto)
  self.schemas = schemas
  return self
}

const Union = <Members extends ReadonlyArray<Struct<any>>, Variants extends ReadonlyArray<string>>(
  members: Members,
  variants: Variants
) => {
  const VariantUnion = Schema.Union(members.filter((member) => Schema.isSchema(member))) as any
  for (const variant of variants) {
    Object.defineProperty(VariantUnion, variant, {
      value: Schema.Union(members.map((member) => extract(member, variant)))
    })
  }
  return VariantUnion
}
