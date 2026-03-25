/**
 * Abstract Syntax Tree (AST) representation for Effect schemas.
 *
 * This module defines the runtime data structures that represent schemas.
 * Most users work with the `Schema` module directly; use `SchemaAST` when you
 * need to inspect, traverse, or programmatically transform schema definitions.
 *
 * ## Mental model
 *
 * - **{@link AST}** — discriminated union (`_tag`) of all schema node types
 *   (e.g. `String`, `Objects`, `Union`, `Suspend`)
 * - **{@link Base}** — abstract base class shared by every node; carries
 *   annotations, checks, encoding chain, and context
 * - **{@link Encoding}** — a non-empty chain of {@link Link} values describing
 *   how to transform between the decoded (type) and encoded (wire) form
 * - **{@link Check}** — a validation filter ({@link Filter} or
 *   {@link FilterGroup}) attached to an AST node
 * - **{@link Context}** — per-property metadata: optionality, mutability,
 *   default values, key annotations
 * - **Guards** — type-narrowing predicates for each AST variant (e.g.
 *   {@link isString}, {@link isObjects})
 *
 * ## Common tasks
 *
 * - Inspect what kind of schema you have → guard functions ({@link isString},
 *   {@link isObjects}, {@link isUnion}, etc.)
 * - Get the decoded (type-level) AST → {@link toType}
 * - Get the encoded (wire-format) AST → {@link toEncoded}
 * - Swap decode/encode directions → {@link flip}
 * - Read annotations → {@link resolve}, {@link resolveAt},
 *   {@link resolveIdentifier}
 * - Build a transformation between schemas → {@link decodeTo}
 * - Add regex validation → {@link isPattern}
 *
 * ## Gotchas
 *
 * - AST nodes are structurally immutable; modification helpers return new
 *   objects via `Object.create`.
 * - {@link Arrays} represents both tuples and arrays; {@link Objects}
 *   represents both structs and records.
 * - {@link toType} and {@link toEncoded} are memoized — same input yields
 *   same output reference.
 * - {@link Suspend} lazily resolves its inner AST via a thunk; the thunk is
 *   memoized on first call.
 *
 * ## Quickstart
 *
 * **Example** (Inspecting a schema's AST)
 *
 * ```ts
 * import { Schema, SchemaAST } from "effect"
 *
 * const schema = Schema.Struct({ name: Schema.String, age: Schema.Number })
 * const ast = schema.ast
 *
 * if (SchemaAST.isObjects(ast)) {
 *   console.log(ast.propertySignatures.map(ps => ps.name))
 *   // ["name", "age"]
 * }
 *
 * const encoded = SchemaAST.toEncoded(ast)
 * console.log(SchemaAST.isObjects(encoded)) // true
 * ```
 *
 * ## See also
 *
 * - {@link AST}
 * - {@link toType}
 * - {@link toEncoded}
 * - {@link flip}
 * - {@link resolve}
 *
 * @since 4.0.0
 */

import * as Arr from "./Array.ts"
import * as Cause from "./Cause.ts"
import type * as Combiner from "./Combiner.ts"
import * as Effect from "./Effect.ts"
import type * as Exit from "./Exit.ts"
import { format, formatPropertyKey } from "./Formatter.ts"
import { memoize } from "./Function.ts"
import { effectIsExit } from "./internal/effect.ts"
import * as internalRecord from "./internal/record.ts"
import * as InternalAnnotations from "./internal/schema/annotations.ts"
import * as Option from "./Option.ts"
import * as Pipeable from "./Pipeable.ts"
import * as Predicate from "./Predicate.ts"
import * as RegEx from "./RegExp.ts"
import * as Result from "./Result.ts"
import type * as Schema from "./Schema.ts"
import * as Getter from "./SchemaGetter.ts"
import * as Issue from "./SchemaIssue.ts"
import type * as Parser from "./SchemaParser.ts"
import * as Transformation from "./SchemaTransformation.ts"

/**
 * Discriminated union of all AST node types.
 *
 * Every `Schema` has an `.ast` property of this type. Use the guard functions
 * ({@link isString}, {@link isObjects}, etc.) to narrow to a specific variant,
 * then access variant-specific fields.
 *
 * - All variants share the {@link Base} fields: `annotations`, `checks`,
 *   `encoding`, `context`.
 * - Discriminate on the `_tag` field (e.g. `"String"`, `"Objects"`, `"Union"`).
 *
 * @see {@link Base}
 * @see {@link isAST}
 *
 * @category model
 * @since 4.0.0
 */
export type AST =
  | Declaration
  | Null
  | Undefined
  | Void
  | Never
  | Unknown
  | Any
  | String
  | Number
  | Boolean
  | BigInt
  | Symbol
  | Literal
  | UniqueSymbol
  | ObjectKeyword
  | Enum
  | TemplateLiteral
  | Arrays
  | Objects
  | Union
  | Suspend

function makeGuard<T extends AST["_tag"]>(tag: T) {
  return (ast: AST): ast is Extract<AST, { _tag: T }> => ast._tag === tag
}

/**
 * Returns `true` if the value is an {@link AST} node (any variant).
 *
 * Uses the internal `TypeId` brand to distinguish AST nodes from arbitrary
 * objects.
 *
 * @see {@link AST}
 *
 * @category Guard
 * @since 4.0.0
 */
export function isAST(u: unknown): u is AST {
  return Predicate.hasProperty(u, TypeId) && u[TypeId] === TypeId
}

/**
 * Narrows an {@link AST} to {@link Declaration}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isDeclaration = makeGuard("Declaration")

/**
 * Narrows an {@link AST} to {@link Null}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isNull = makeGuard("Null")

/**
 * Narrows an {@link AST} to {@link Undefined}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isUndefined = makeGuard("Undefined")

/**
 * Narrows an {@link AST} to {@link Void}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isVoid = makeGuard("Void")

/**
 * Narrows an {@link AST} to {@link Never}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isNever = makeGuard("Never")

/**
 * Narrows an {@link AST} to {@link Unknown}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isUnknown = makeGuard("Unknown")

/**
 * Narrows an {@link AST} to {@link Any}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isAny = makeGuard("Any")

/**
 * Narrows an {@link AST} to {@link String}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isString = makeGuard("String")

/**
 * Narrows an {@link AST} to {@link Number}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isNumber = makeGuard("Number")

/**
 * Narrows an {@link AST} to {@link Boolean}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isBoolean = makeGuard("Boolean")

/**
 * Narrows an {@link AST} to {@link BigInt}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isBigInt = makeGuard("BigInt")

/**
 * Narrows an {@link AST} to {@link Symbol}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isSymbol = makeGuard("Symbol")

/**
 * Narrows an {@link AST} to {@link Literal}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isLiteral = makeGuard("Literal")

/**
 * Narrows an {@link AST} to {@link UniqueSymbol}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isUniqueSymbol = makeGuard("UniqueSymbol")

/**
 * Narrows an {@link AST} to {@link ObjectKeyword}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isObjectKeyword = makeGuard("ObjectKeyword")

/**
 * Narrows an {@link AST} to {@link Enum}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isEnum = makeGuard("Enum")

/**
 * Narrows an {@link AST} to {@link TemplateLiteral}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isTemplateLiteral = makeGuard("TemplateLiteral")

/**
 * Narrows an {@link AST} to {@link Arrays}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isArrays = makeGuard("Arrays")

/**
 * Narrows an {@link AST} to {@link Objects}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isObjects = makeGuard("Objects")

/**
 * Narrows an {@link AST} to {@link Union}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isUnion = makeGuard("Union")

/**
 * Narrows an {@link AST} to {@link Suspend}.
 *
 * @category Guard
 * @since 4.0.0
 */
export const isSuspend = makeGuard("Suspend")

/**
 * A single step in an {@link Encoding} chain, pairing a target {@link AST}
 * with a `Transformation` or `Middleware` that converts values between the
 * current node and the target.
 *
 * - `to` — the AST node on the other side of this transformation step.
 * - `transformation` — the bidirectional conversion logic (decode/encode).
 *
 * Links are composed into a non-empty array ({@link Encoding}) attached to
 * AST nodes that have a different encoded representation.
 *
 * @see {@link Encoding}
 * @see {@link decodeTo}
 *
 * @category model
 * @since 4.0.0
 */
export class Link {
  readonly to: AST
  readonly transformation:
    | Transformation.Transformation<any, any, any, any>
    | Transformation.Middleware<any, any, any, any, any, any>

  constructor(
    to: AST,
    transformation:
      | Transformation.Transformation<any, any, any, any>
      | Transformation.Middleware<any, any, any, any, any, any>
  ) {
    this.to = to
    this.transformation = transformation
  }
}

/**
 * A non-empty chain of {@link Link} values representing the transformation
 * steps between a schema's decoded (type) form and its encoded (wire) form.
 *
 * Stored on {@link Base.encoding}. When `undefined`, the node has no
 * encoding transformation (type and encoded forms are identical).
 *
 * @see {@link Link}
 * @see {@link toEncoded}
 *
 * @category model
 * @since 4.0.0
 */
export type Encoding = readonly [Link, ...Array<Link>]

/**
 * Options that control parsing/validation behavior.
 *
 * Pass to `Schema.decodeUnknown`, `Schema.encode`, etc. to customize error
 * reporting, excess property handling, and output key ordering.
 *
 * - `errors` — `"first"` (default) stops at the first error; `"all"`
 *   collects every error.
 * - `onExcessProperty` — `"ignore"` (default) strips unknown keys;
 *   `"error"` fails; `"preserve"` keeps them.
 * - `propertyOrder` — `"none"` (default) lets the system choose key order;
 *   `"original"` preserves input key order.
 *
 * @category model
 * @since 4.0.0
 */
export interface ParseOptions {
  /**
   * The `errors` option allows you to receive all parsing errors when
   * attempting to parse a value using a schema. By default only the first error
   * is returned, but by setting the `errors` option to `"all"`, you can receive
   * all errors that occurred during the parsing process. This can be useful for
   * debugging or for providing more comprehensive error messages to the user.
   *
   * default: "first"
   */
  readonly errors?: "first" | "all" | undefined

  /**
   * When using a `Objects` to parse a value, by default any properties that
   * are not specified in the schema will be stripped out from the output. This
   * is because the `Objects` is expecting a specific shape for the parsed
   * value, and any excess properties do not conform to that shape.
   *
   * However, you can use the `onExcessProperty` option (default value:
   * `"ignore"`) to trigger a parsing error. This can be particularly useful in
   * cases where you need to detect and handle potential errors or unexpected
   * values.
   *
   * If you want to allow excess properties to remain, you can use
   * `onExcessProperty` set to `"preserve"`.
   *
   * default: "ignore"
   */
  readonly onExcessProperty?: "ignore" | "error" | "preserve" | undefined

  /**
   * The `propertyOrder` option provides control over the order of object fields
   * in the output. This feature is useful when the sequence of keys is
   * important for the consuming processes or when maintaining the input order
   * enhances readability and usability.
   *
   * By default, the `propertyOrder` option is set to `"none"`. This means that
   * the internal system decides the order of keys to optimize parsing speed.
   * The order of keys in this mode should not be considered stable, and it's
   * recommended not to rely on key ordering as it may change in future updates
   * without notice.
   *
   * Setting `propertyOrder` to `"original"` ensures that the keys are ordered
   * as they appear in the input during the decoding/encoding process.
   *
   * default: "none"
   */
  readonly propertyOrder?: "none" | "original" | undefined

  /**
   * Whether to disable checks while still applying defaults and
   * transformations.
   */
  readonly disableChecks?: boolean | undefined
}

/** @internal */
export const defaultParseOptions: ParseOptions = {}

/**
 * Per-property metadata attached to AST nodes via {@link Base.context}.
 *
 * Tracks whether a property key is optional, mutable, has a constructor
 * default, or carries key-level annotations. Typically set by helpers like
 * {@link optionalKey} and `Schema.mutableKey`.
 *
 * - `isOptional` — the property key may be absent from the input.
 * - `isMutable` — the property is `readonly` when `false`.
 * - `defaultValue` — an {@link Encoding} applied during construction to
 *   supply missing values.
 * - `annotations` — key-level annotations (e.g. description of the key
 *   itself).
 *
 * @see {@link optionalKey}
 * @see {@link isOptional}
 *
 * @category model
 * @since 4.0.0
 */
export class Context {
  readonly isOptional: boolean
  readonly isMutable: boolean
  /** Used for constructor default values (e.g. `withConstructorDefault` API) */
  readonly defaultValue: Encoding | undefined
  readonly annotations: Schema.Annotations.Key<unknown> | undefined

  constructor(
    isOptional: boolean,
    isMutable: boolean,
    /** Used for constructor default values (e.g. `withConstructorDefault` API) */
    defaultValue: Encoding | undefined = undefined,
    annotations: Schema.Annotations.Key<unknown> | undefined = undefined
  ) {
    this.isOptional = isOptional
    this.isMutable = isMutable
    this.defaultValue = defaultValue
    this.annotations = annotations
  }
}

/**
 * Non-empty array of validation {@link Check} values attached to an AST node
 * via {@link Base.checks}.
 *
 * Checks are run after basic type matching succeeds. They represent
 * refinements like `minLength`, `pattern`, `int`, etc.
 *
 * @see {@link Check}
 * @see {@link Filter}
 * @see {@link FilterGroup}
 *
 * @category model
 * @since 4.0.0
 */
export type Checks = readonly [Check<any>, ...Array<Check<any>>]

const TypeId = "~effect/Schema"

/**
 * Abstract base class for all {@link AST} node variants.
 *
 * Every AST node extends `Base` and inherits these fields:
 *
 * - `annotations` — user-supplied metadata (identifier, title, description,
 *   arbitrary keys).
 * - `checks` — optional {@link Checks} for post-type-match validation.
 * - `encoding` — optional {@link Encoding} chain for type ↔ wire
 *   transformations.
 * - `context` — optional {@link Context} for per-property metadata.
 *
 * Subclasses add a `_tag` discriminant and variant-specific data.
 *
 * @see {@link AST}
 *
 * @category model
 * @since 4.0.0
 */
export abstract class Base {
  readonly [TypeId] = TypeId
  abstract readonly _tag: string
  readonly annotations: Schema.Annotations.Annotations | undefined
  readonly checks: Checks | undefined
  readonly encoding: Encoding | undefined
  readonly context: Context | undefined

  constructor(
    annotations: Schema.Annotations.Annotations | undefined = undefined,
    checks: Checks | undefined = undefined,
    encoding: Encoding | undefined = undefined,
    context: Context | undefined = undefined
  ) {
    this.annotations = annotations
    this.checks = checks
    this.encoding = encoding
    this.context = context
  }
  toString() {
    return `<${this._tag}>`
  }
}

/**
 * AST node for user-defined opaque types with custom parsing logic.
 *
 * Use when none of the built-in AST nodes fit. The `run` function receives
 * `typeParameters` and returns a parser that validates/transforms raw input.
 *
 * - `typeParameters` — inner schemas this declaration is parameterized over
 *   (e.g. the element type for a custom collection).
 * - `run` — factory producing the actual parse function.
 *
 * @see {@link isDeclaration}
 *
 * @category model
 * @since 4.0.0
 */
export class Declaration extends Base {
  readonly _tag = "Declaration"
  readonly typeParameters: ReadonlyArray<AST>
  readonly run: (
    typeParameters: ReadonlyArray<AST>
  ) => (input: unknown, self: Declaration, options: ParseOptions) => Effect.Effect<any, Issue.Issue, any>

  constructor(
    typeParameters: ReadonlyArray<AST>,
    run: (
      typeParameters: ReadonlyArray<AST>
    ) => (input: unknown, self: Declaration, options: ParseOptions) => Effect.Effect<any, Issue.Issue, any>,
    annotations?: Schema.Annotations.Annotations,
    checks?: Checks,
    encoding?: Encoding,
    context?: Context
  ) {
    super(annotations, checks, encoding, context)
    this.typeParameters = typeParameters
    this.run = run
  }
  /** @internal */
  getParser(): Parser.Parser {
    const run = this.run(this.typeParameters)
    return (oinput, options) => {
      if (Option.isNone(oinput)) return Effect.succeedNone
      return Effect.mapEager(run(oinput.value, this, options), Option.some)
    }
  }
  /** @internal */
  recur(recur: (ast: AST) => AST) {
    const tps = mapOrSame(this.typeParameters, recur)
    return tps === this.typeParameters ?
      this :
      new Declaration(tps, this.run, this.annotations, this.checks, undefined, this.context)
  }
  /** @internal */
  getExpected(): string {
    const expected = this.annotations?.expected
    if (typeof expected === "string") return expected
    return "<Declaration>"
  }
}

/**
 * AST node matching the `null` literal value.
 *
 * Parsing succeeds only when the input is exactly `null`.
 *
 * @see {@link null}
 * @see {@link isNull}
 *
 * @category model
 * @since 4.0.0
 */
export class Null extends Base {
  readonly _tag = "Null"
  /** @internal */
  getParser() {
    return fromConst(this, null)
  }
  /** @internal */
  getExpected(): string {
    return "null"
  }
}

const null_ = new Null()
export {
  /**
   * Singleton {@link Null} AST instance.
   *
   * @since 4.0.0
   */
  null_ as null
}

/**
 * AST node matching the `undefined` value.
 *
 * Parsing succeeds only when the input is exactly `undefined`.
 *
 * @see {@link undefined}
 * @see {@link isUndefined}
 *
 * @category model
 * @since 4.0.0
 */
export class Undefined extends Base {
  readonly _tag = "Undefined"
  /** @internal */
  getParser() {
    return fromConst(this, undefined)
  }
  /** @internal */
  toCodecJson(): AST {
    return replaceEncoding(this, [undefinedToNull])
  }
  /** @internal */
  getExpected(): string {
    return "undefined"
  }
}

const undefinedToNull = new Link(
  null_,
  new Transformation.Transformation(
    Getter.transform(() => undefined),
    Getter.transform(() => null)
  )
)

const undefined_ = new Undefined()
export {
  /**
   * Singleton {@link Undefined} AST instance.
   *
   * @since 4.0.0
   */
  undefined_ as undefined
}

/**
 * AST node matching the `void` type (accepts `undefined` at runtime).
 *
 * Behaves like {@link Undefined} for parsing but represents the TypeScript
 * `void` type semantically.
 *
 * @see {@link void}
 * @see {@link isVoid}
 *
 * @category model
 * @since 4.0.0
 */
export class Void extends Base {
  readonly _tag = "Void"
  /** @internal */
  getParser() {
    return fromConst(this, undefined)
  }
  /** @internal */
  toCodecJson(): AST {
    return replaceEncoding(this, [undefinedToNull])
  }
  /** @internal */
  getExpected(): string {
    return "void"
  }
}

const void_ = new Void()
export {
  /**
   * Singleton {@link Void} AST instance.
   *
   * @since 4.0.0
   */
  void_ as void
}

/**
 * AST node representing the `never` type — no value matches.
 *
 * Parsing always fails. Useful as a placeholder in unions or as the result
 * of narrowing that eliminates all options.
 *
 * @see {@link never}
 * @see {@link isNever}
 *
 * @category model
 * @since 4.0.0
 */
export class Never extends Base {
  readonly _tag = "Never"
  /** @internal */
  getParser() {
    return fromRefinement(this, Predicate.isNever)
  }
  /** @internal */
  getExpected(): string {
    return "never"
  }
}

/**
 * Singleton {@link Never} AST instance.
 *
 * @since 4.0.0
 */
export const never = new Never()

/**
 * AST node representing the `any` type — every value matches.
 *
 * @see {@link any}
 * @see {@link isAny}
 *
 * @category model
 * @since 4.0.0
 */
export class Any extends Base {
  readonly _tag = "Any"
  /** @internal */
  getParser() {
    return fromRefinement(this, Predicate.isUnknown)
  }
  /** @internal */
  getExpected(): string {
    return "any"
  }
}

/**
 * Singleton {@link Any} AST instance.
 *
 * @since 4.0.0
 */
export const any = new Any()

/**
 * AST node representing the `unknown` type — every value matches.
 *
 * Unlike {@link Any}, this is type-safe: the parsed result is typed as
 * `unknown` rather than `any`.
 *
 * @see {@link unknown}
 * @see {@link isUnknown}
 *
 * @category model
 * @since 4.0.0
 */
export class Unknown extends Base {
  readonly _tag = "Unknown"
  /** @internal */
  getParser() {
    return fromRefinement(this, Predicate.isUnknown)
  }
  /** @internal */
  getExpected(): string {
    return "unknown"
  }
}

/**
 * Singleton {@link Unknown} AST instance.
 *
 * @since 4.0.0
 */
export const unknown = new Unknown()

/**
 * AST node matching the TypeScript `object` type — accepts objects, arrays,
 * and functions (anything non-primitive and non-null).
 *
 * @see {@link objectKeyword}
 * @see {@link isObjectKeyword}
 *
 * @category model
 * @since 4.0.0
 */
export class ObjectKeyword extends Base {
  readonly _tag = "ObjectKeyword"
  /** @internal */
  getParser() {
    return fromRefinement(this, Predicate.isObjectKeyword)
  }
  /** @internal */
  getExpected(): string {
    return "object | array | function"
  }
}

/**
 * Singleton {@link ObjectKeyword} AST instance.
 *
 * @since 4.0.0
 */
export const objectKeyword = new ObjectKeyword()

/**
 * AST node representing a TypeScript `enum`.
 *
 * Holds `enums` as an array of `[name, value]` pairs where values are
 * `string | number`. Parsing succeeds when the input matches any enum value.
 *
 * @see {@link isEnum}
 *
 * @category model
 * @since 4.0.0
 */
export class Enum extends Base {
  readonly _tag = "Enum"
  readonly enums: ReadonlyArray<readonly [string, string | number]>

  constructor(
    enums: ReadonlyArray<readonly [string, string | number]>,
    annotations?: Schema.Annotations.Annotations,
    checks?: Checks,
    encoding?: Encoding,
    context?: Context
  ) {
    super(annotations, checks, encoding, context)
    this.enums = enums
  }
  /** @internal */
  getParser() {
    const values = new Set<unknown>(this.enums.map(([, v]) => v))
    return fromRefinement(
      this,
      (input): input is typeof this.enums[number][1] => values.has(input)
    )
  }
  /** @internal */
  toCodecStringTree(): AST {
    if (this.enums.some(([_, v]) => typeof v === "number")) {
      const coercions = Object.fromEntries(this.enums.map(([_, v]) => [globalThis.String(v), v]))
      return replaceEncoding(this, [
        new Link(
          new Union(Object.keys(coercions).map((k) => new Literal(k)), "anyOf"),
          new Transformation.Transformation(
            Getter.transform((s) => coercions[s]),
            Getter.String()
          )
        )
      ])
    }
    return this
  }
  /** @internal */
  getExpected(): string {
    return this.enums.map(([_, value]) => JSON.stringify(value)).join(" | ")
  }
}

type TemplateLiteralPart =
  | String
  | Number
  | BigInt
  | Literal
  | TemplateLiteral
  | Union<TemplateLiteralPart>

function isTemplateLiteralPart(ast: AST): ast is TemplateLiteralPart {
  switch (ast._tag) {
    case "String":
    case "Number":
    case "BigInt":
    case "Literal":
    case "TemplateLiteral":
      return true
    case "Union":
      return ast.types.every(isTemplateLiteralPart)
    default:
      return false
  }
}

/**
 * AST node representing a TypeScript template literal type
 * (e.g. `` `user_${string}` ``).
 *
 * `parts` is an array of AST nodes; each part contributes to the
 * template literal pattern. A regex is derived from the parts to validate
 * strings at runtime.
 *
 * @see {@link isTemplateLiteral}
 *
 * @category model
 * @since 4.0.0
 */
export class TemplateLiteral extends Base {
  readonly _tag = "TemplateLiteral"
  readonly parts: ReadonlyArray<AST>
  /** @internal */
  readonly encodedParts: ReadonlyArray<TemplateLiteralPart>

  constructor(
    parts: ReadonlyArray<AST>,
    annotations?: Schema.Annotations.Annotations,
    checks?: Checks,
    encoding?: Encoding,
    context?: Context
  ) {
    super(annotations, checks, encoding, context)
    const encodedParts: Array<TemplateLiteralPart> = []
    for (const part of parts) {
      const encoded = toEncoded(part)
      if (isTemplateLiteralPart(encoded)) {
        encodedParts.push(encoded)
      } else {
        throw new Error(`Invalid TemplateLiteral part ${encoded._tag}`)
      }
    }
    this.parts = parts
    this.encodedParts = encodedParts
  }
  /** @internal */
  getParser(recur: (ast: AST) => Parser.Parser): Parser.Parser {
    const parser = recur(this.asTemplateLiteralParser())
    return (oinput: Option.Option<unknown>, options: ParseOptions) =>
      Effect.mapBothEager(parser(oinput, options), {
        onSuccess: () => oinput,
        onFailure: (issue) => new Issue.Composite(this, oinput, [issue])
      })
  }
  /** @internal */
  getExpected(): string {
    return "string"
  }
  /** @internal */
  asTemplateLiteralParser(): Arrays {
    const tuple = new Arrays(false, this.parts.map(templateLiteralPartFromString), [])
    const regExp = getTemplateLiteralRegExp(this)
    return decodeTo(
      string,
      tuple,
      new Transformation.Transformation(
        Getter.transformOrFail((s: string) => {
          const match = regExp.exec(s)
          if (match) return Effect.succeed(match.slice(1, this.parts.length + 1))
          return Effect.fail(
            new Issue.InvalidValue(Option.some(s), {
              message: `Expected a value matching ${regExp.source}, got ${format(s)}`
            })
          )
        }),
        Getter.transform((parts) => parts.join(""))
      )
    )
  }
}

/**
 * AST node matching a specific `unique symbol` value.
 *
 * Parsing succeeds only when the input is reference-equal to the stored
 * `symbol`.
 *
 * @see {@link isUniqueSymbol}
 *
 * @category model
 * @since 4.0.0
 */
export class UniqueSymbol extends Base {
  readonly _tag = "UniqueSymbol"
  readonly symbol: symbol

  constructor(
    symbol: symbol,
    annotations?: Schema.Annotations.Annotations,
    checks?: Checks,
    encoding?: Encoding,
    context?: Context
  ) {
    super(annotations, checks, encoding, context)
    this.symbol = symbol
  }
  /** @internal */
  getParser() {
    return fromConst(this, this.symbol)
  }
  /** @internal */
  toCodecStringTree(): AST {
    return replaceEncoding(this, [symbolToString])
  }
  /** @internal */
  getExpected(): string {
    return globalThis.String(this.symbol)
  }
}

/**
 * The set of primitive types that can appear as a {@link Literal} value.
 *
 * @see {@link Literal}
 *
 * @category model
 * @since 4.0.0
 */
export type LiteralValue = string | number | boolean | bigint

/**
 * AST node matching an exact primitive value (string, number, boolean, or
 * bigint).
 *
 * Parsing succeeds only when the input is strictly equal (`===`) to the
 * stored `literal`. Numeric literals must be finite — `Infinity`, `-Infinity`,
 * and `NaN` are rejected at construction time.
 *
 * **Example** (Creating a literal AST)
 *
 * ```ts
 * import { SchemaAST } from "effect"
 *
 * const ast = new SchemaAST.Literal("active")
 * console.log(ast.literal) // "active"
 * ```
 *
 * @see {@link LiteralValue}
 * @see {@link isLiteral}
 *
 * @category model
 * @since 4.0.0
 */
export class Literal extends Base {
  readonly _tag = "Literal"
  readonly literal: LiteralValue

  constructor(
    literal: LiteralValue,
    annotations?: Schema.Annotations.Annotations,
    checks?: Checks,
    encoding?: Encoding,
    context?: Context
  ) {
    super(annotations, checks, encoding, context)
    if (typeof literal === "number" && !globalThis.Number.isFinite(literal)) {
      throw new Error(`A numeric literal must be finite, got ${format(literal)}`)
    }
    this.literal = literal
  }
  /** @internal */
  getParser() {
    return fromConst(this, this.literal)
  }
  /** @internal */
  toCodecJson(): AST {
    return typeof this.literal === "bigint" ? literalToString(this) : this
  }
  /** @internal */
  toCodecStringTree(): AST {
    return typeof this.literal === "string" ? this : literalToString(this)
  }
  /** @internal */
  getExpected(): string {
    return typeof this.literal === "string" ? JSON.stringify(this.literal) : globalThis.String(this.literal)
  }
}

function literalToString(ast: Literal): Literal {
  const literalAsString = globalThis.String(ast.literal)
  return replaceEncoding(ast, [
    new Link(
      new Literal(literalAsString),
      new Transformation.Transformation(
        Getter.transform(() => ast.literal),
        Getter.transform(() => literalAsString)
      )
    )
  ])
}

/**
 * AST node matching any `string` value.
 *
 * @see {@link string}
 * @see {@link isString}
 *
 * @category model
 * @since 4.0.0
 */
export class String extends Base {
  readonly _tag = "String"
  /** @internal */
  getParser() {
    return fromRefinement(this, Predicate.isString)
  }
  /** @internal */
  getExpected(): string {
    return "string"
  }
}

/**
 * Singleton {@link String} AST instance.
 *
 * @since 4.0.0
 */
export const string = new String()

/**
 * AST node matching any `number` value (including `NaN`, `Infinity`,
 * `-Infinity`).
 *
 * Default JSON serialization:
 * - Finite numbers are serialized as JSON numbers.
 * - `Infinity`, `-Infinity`, and `NaN` are serialized as JSON strings.
 *
 * If the node has an `isFinite` or `isInt` check, the string fallback is
 * skipped since non-finite values cannot occur.
 *
 * @see {@link number}
 * @see {@link isNumber}
 *
 * @category model
 * @since 4.0.0
 */
export class Number extends Base {
  readonly _tag = "Number"
  /** @internal */
  getParser() {
    return fromRefinement(this, Predicate.isNumber)
  }
  /** @internal */
  toCodecJson(): AST {
    if (this.checks && (hasCheck(this.checks, "isFinite") || hasCheck(this.checks, "isInt"))) {
      return this
    }
    return replaceEncoding(this, [numberToJson])
  }
  /** @internal */
  toCodecStringTree(): AST {
    if (this.checks && (hasCheck(this.checks, "isFinite") || hasCheck(this.checks, "isInt"))) {
      return replaceEncoding(this, [finiteToString])
    }
    return replaceEncoding(this, [numberToString])
  }
  /** @internal */
  getExpected(): string {
    return "number"
  }
}

// oxlint-disable-next-line only-used-in-recursion - @gcanti what's this? :-)
function hasCheck(checks: ReadonlyArray<Check<unknown>>, tag: string): boolean {
  return checks.some((c) => {
    switch (c._tag) {
      case "Filter":
        return c.annotations?.meta?._tag === tag
      case "FilterGroup":
        return hasCheck(c.checks, tag)
    }
  })
}

/**
 * Singleton {@link Number} AST instance.
 *
 * @since 4.0.0
 */
export const number = new Number()

/**
 * AST node matching any `boolean` value (`true` or `false`).
 *
 * @see {@link boolean}
 * @see {@link isBoolean}
 *
 * @category model
 * @since 4.0.0
 */
export class Boolean extends Base {
  readonly _tag = "Boolean"
  /** @internal */
  getParser() {
    return fromRefinement(this, Predicate.isBoolean)
  }
  /** @internal */
  getExpected(): string {
    return "boolean"
  }
}

/**
 * Singleton {@link Boolean} AST instance.
 *
 * @since 4.0.0
 */
export const boolean = new Boolean()

/**
 * AST node matching any `symbol` value.
 *
 * When serialized to a string-based codec, symbols are converted via
 * `Symbol.keyFor` and must be registered with `Symbol.for`.
 *
 * @see {@link symbol}
 * @see {@link isSymbol}
 *
 * @category model
 * @since 4.0.0
 */
export class Symbol extends Base {
  readonly _tag = "Symbol"
  /** @internal */
  getParser() {
    return fromRefinement(this, Predicate.isSymbol)
  }
  /** @internal */
  toCodecStringTree(): AST {
    return replaceEncoding(this, [symbolToString])
  }
  /** @internal */
  getExpected(): string {
    return "symbol"
  }
}

/**
 * Singleton {@link Symbol} AST instance.
 *
 * @since 4.0.0
 */
export const symbol = new Symbol()

/**
 * AST node matching any `bigint` value.
 *
 * When serialized to a string-based codec, bigints are converted to/from
 * their decimal string representation.
 *
 * @see {@link bigInt}
 * @see {@link isBigInt}
 *
 * @category model
 * @since 4.0.0
 */
export class BigInt extends Base {
  readonly _tag = "BigInt"
  /** @internal */
  getParser() {
    return fromRefinement(this, Predicate.isBigInt)
  }
  /** @internal */
  toCodecStringTree(): AST {
    return replaceEncoding(this, [bigIntToString])
  }
  /** @internal */
  getExpected(): string {
    return "bigint"
  }
}

/**
 * Singleton {@link BigInt} AST instance.
 *
 * @since 4.0.0
 */
export const bigInt = new BigInt()

/**
 * AST node for array-like types — both tuples and arrays.
 *
 * - `elements` — positional element types (tuple elements). An element is
 *   optional if its {@link Context.isOptional} is `true`.
 * - `rest` — the rest/variadic element types. When non-empty, the first
 *   entry is the "spread" type (e.g. `...Array<string>`), and subsequent
 *   entries are trailing positional elements after the spread.
 * - `isMutable` — whether the resulting array is `readonly` (`false`) or
 *   mutable (`true`).
 *
 * Construction enforces TypeScript ordering rules: a required element
 * cannot follow an optional one, and an optional element cannot follow a
 * rest element.
 *
 * **Example** (Inspecting a tuple AST)
 *
 * ```ts
 * import { Schema, SchemaAST } from "effect"
 *
 * const schema = Schema.Tuple([Schema.String, Schema.Number])
 * const ast = schema.ast
 *
 * if (SchemaAST.isArrays(ast)) {
 *   console.log(ast.elements.length) // 2
 *   console.log(ast.rest.length)     // 0
 * }
 * ```
 *
 * @see {@link isArrays}
 * @see {@link Objects}
 *
 * @category model
 * @since 4.0.0
 */
export class Arrays extends Base {
  readonly _tag = "Arrays"
  readonly isMutable: boolean
  readonly elements: ReadonlyArray<AST>
  readonly rest: ReadonlyArray<AST>

  constructor(
    isMutable: boolean,
    elements: ReadonlyArray<AST>,
    rest: ReadonlyArray<AST>,
    annotations?: Schema.Annotations.Annotations,
    checks?: Checks,
    encoding?: Encoding,
    context?: Context
  ) {
    super(annotations, checks, encoding, context)
    this.isMutable = isMutable
    this.elements = elements
    this.rest = rest

    // A required element cannot follow an optional element. ts(1257)
    const i = elements.findIndex(isOptional)
    if (i !== -1 && (elements.slice(i + 1).some((e) => !isOptional(e)) || rest.length > 1)) {
      throw new Error("A required element cannot follow an optional element. ts(1257)")
    }

    // An optional element cannot follow a rest element.ts(1266)
    if (rest.length > 1 && rest.slice(1).some(isOptional)) {
      throw new Error("An optional element cannot follow a rest element. ts(1266)")
    }
  }
  /** @internal */
  getParser(recur: (ast: AST) => Parser.Parser): Parser.Parser {
    // oxlint-disable-next-line @typescript-eslint/no-this-alias
    const ast = this
    const elements = ast.elements.map((ast) => ({ ast, parser: recur(ast) }))
    const rest = ast.rest.map((ast) => ({ ast, parser: recur(ast) }))
    const elementLen = elements.length
    return Effect.fnUntracedEager(function*(oinput, options) {
      if (oinput._tag === "None") {
        return oinput
      }
      const input = oinput.value

      // If the input is not an array, return early with an error
      if (!Array.isArray(input)) {
        return yield* Effect.fail(new Issue.InvalidType(ast, oinput))
      }

      const output: Array<unknown> = []
      let issues: Arr.NonEmptyArray<Issue.Issue> | undefined
      const errorsAllOption = options.errors === "all"

      let i = 0
      // ---------------------------------------------
      // handle elements
      // ---------------------------------------------
      for (; i < elementLen; i++) {
        const e = elements[i]
        const value = i < input.length ? Option.some(input[i]) : Option.none()
        const eff = e.parser(value, options)
        const exit = effectIsExit(eff) ? eff : yield* Effect.exit(eff)
        if (exit._tag === "Failure") {
          const issueElement = Cause.findError(exit.cause)
          if (Result.isFailure(issueElement)) {
            return yield* exit
          }
          const issue = new Issue.Pointer([i], issueElement.success)
          if (errorsAllOption) {
            if (issues) issues.push(issue)
            else issues = [issue]
          } else {
            return yield* Effect.fail(new Issue.Composite(ast, oinput, [issue]))
          }
        } else if (exit.value._tag === "Some") {
          output[i] = exit.value.value
        } else if (!isOptional(e.ast)) {
          const issue = new Issue.Pointer([i], new Issue.MissingKey(e.ast.context?.annotations))
          if (errorsAllOption) {
            if (issues) issues.push(issue)
            else issues = [issue]
          } else {
            return yield* Effect.fail(new Issue.Composite(ast, oinput, [issue]))
          }
        }
      }
      // ---------------------------------------------
      // handle rest element
      // ---------------------------------------------
      const len = input.length
      if (ast.rest.length > 0) {
        const [head, ...tail] = rest
        const keyAnnotations = head.ast.context?.annotations
        for (; i < len - tail.length; i++) {
          const eff = head.parser(Option.some(input[i]), options)
          const exit = effectIsExit(eff) ? eff : yield* Effect.exit(eff)
          if (exit._tag === "Failure") {
            const issueRest = Cause.findError(exit.cause)
            if (Result.isFailure(issueRest)) {
              return yield* exit
            }
            const issue = new Issue.Pointer([i], issueRest.success)
            if (errorsAllOption) {
              if (issues) issues.push(issue)
              else issues = [issue]
            } else {
              return yield* Effect.fail(new Issue.Composite(ast, oinput, [issue]))
            }
          } else if (exit.value._tag === "Some") {
            output[i] = exit.value.value
          } else {
            const issue = new Issue.Pointer([i], new Issue.MissingKey(keyAnnotations))
            if (errorsAllOption) {
              if (issues) issues.push(issue)
              else issues = [issue]
            } else {
              return yield* Effect.fail(new Issue.Composite(ast, oinput, [issue]))
            }
          }
        }
        // ---------------------------------------------
        // handle post rest elements
        // ---------------------------------------------
        for (let j = 0; j < tail.length; j++) {
          const index = i + j
          if (len < index) {
            continue
          } else {
            const tailj = tail[j]
            const keyAnnotations = tailj.ast.context?.annotations
            const eff = tailj.parser(Option.some(input[index]), options)
            const exit = effectIsExit(eff) ? eff : yield* Effect.exit(eff)
            if (exit._tag === "Failure") {
              const issueRest = Cause.findError(exit.cause)
              if (Result.isFailure(issueRest)) {
                return yield* exit
              }
              const issue = new Issue.Pointer([index], issueRest.success)
              if (errorsAllOption) {
                if (issues) issues.push(issue)
                else issues = [issue]
              } else {
                return yield* Effect.fail(new Issue.Composite(ast, oinput, [issue]))
              }
            } else if (exit.value._tag === "Some") {
              output[index] = exit.value.value
            } else {
              const issue = new Issue.Pointer([index], new Issue.MissingKey(keyAnnotations))
              if (errorsAllOption) {
                if (issues) issues.push(issue)
                else issues = [issue]
              } else {
                return yield* Effect.fail(new Issue.Composite(ast, oinput, [issue]))
              }
            }
          }
        }
      } else {
        // ---------------------------------------------
        // handle excess indexes
        // ---------------------------------------------
        for (let i = elementLen; i <= len - 1; i++) {
          const issue = new Issue.Pointer([i], new Issue.UnexpectedKey(ast, input[i]))
          if (errorsAllOption) {
            if (issues) issues.push(issue)
            else issues = [issue]
          } else {
            return yield* Effect.fail(new Issue.Composite(ast, oinput, [issue]))
          }
        }
      }
      if (issues) {
        return yield* Effect.fail(new Issue.Composite(ast, oinput, issues))
      }
      return Option.some(output)
    })
  }
  /** @internal */
  recur(recur: (ast: AST) => AST) {
    const elements = mapOrSame(this.elements, recur)
    const rest = mapOrSame(this.rest, recur)
    return elements === this.elements && rest === this.rest ?
      this :
      new Arrays(this.isMutable, elements, rest, this.annotations, this.checks, undefined, this.context)
  }
  /** @internal */
  getExpected(): string {
    return "array"
  }
}

/**
 * floating point or integer, with optional exponent
 * @internal
 */
export const FINITE_PATTERN = "[+-]?\\d*\\.?\\d+(?:[Ee][+-]?\\d+)?"

const isNumberStringRegExp = new globalThis.RegExp(`(?:${FINITE_PATTERN}|Infinity|-Infinity|NaN)`)

/**
 * Returns the object keys that match the index signature parameter schema.
 * @internal
 */
export function getIndexSignatureKeys(
  input: { readonly [x: PropertyKey]: unknown },
  parameter: AST
): ReadonlyArray<PropertyKey> {
  const encoded = toEncoded(parameter)
  switch (encoded._tag) {
    case "String":
      return Object.keys(input)
    case "TemplateLiteral": {
      const regExp = getTemplateLiteralRegExp(encoded)
      return Object.keys(input).filter((k) => regExp.test(k))
    }
    case "Symbol":
      return Object.getOwnPropertySymbols(input)
    case "Number":
      return Object.keys(input).filter((k) => isNumberStringRegExp.test(k))
    case "Union":
      return [...new Set(encoded.types.flatMap((t) => getIndexSignatureKeys(input, t)))]
    default:
      return []
  }
}

/**
 * A named property within an {@link Objects} node.
 *
 * Pairs a `name` (any `PropertyKey`) with a `type` ({@link AST}). The
 * property's optionality and mutability are determined by the `type`'s
 * {@link Context}.
 *
 * @see {@link Objects}
 *
 * @category model
 * @since 4.0.0
 */
export class PropertySignature {
  readonly name: PropertyKey
  readonly type: AST

  constructor(
    name: PropertyKey,
    type: AST
  ) {
    this.name = name
    this.type = type
  }
}

/**
 * Bidirectional merge strategy for index signature key-value pairs.
 *
 * Used by {@link IndexSignature} when the same key appears multiple times
 * (e.g. from `Schema.extend` or overlapping records). Provides separate
 * `decode` and `encode` combiners that determine how duplicate entries are
 * merged.
 *
 * @see {@link IndexSignature}
 *
 * @category model
 * @since 4.0.0
 */
export class KeyValueCombiner {
  readonly decode: Combiner.Combiner<readonly [key: PropertyKey, value: any]> | undefined
  readonly encode: Combiner.Combiner<readonly [key: PropertyKey, value: any]> | undefined

  constructor(
    decode: Combiner.Combiner<readonly [key: PropertyKey, value: any]> | undefined,
    encode: Combiner.Combiner<readonly [key: PropertyKey, value: any]> | undefined
  ) {
    this.decode = decode
    this.encode = encode
  }
  /** @internal */
  flip(): KeyValueCombiner {
    return new KeyValueCombiner(this.encode, this.decode)
  }
}

/**
 * An index signature entry within an {@link Objects} node.
 *
 * - `parameter` — the key type AST (e.g. {@link String} for `string` keys,
 *   {@link TemplateLiteral} for patterned keys).
 * - `type` — the value type AST.
 * - `merge` — optional {@link KeyValueCombiner} for handling duplicate keys.
 *
 * Using `Schema.optionalKey` on the value type is not allowed for index
 * signatures (throws at construction); use `Schema.optional` instead.
 *
 * @see {@link Objects}
 * @see {@link PropertySignature}
 *
 * @category model
 * @since 4.0.0
 */
export class IndexSignature {
  readonly parameter: AST
  readonly type: AST
  readonly merge: KeyValueCombiner | undefined

  constructor(
    parameter: AST,
    type: AST,
    merge: KeyValueCombiner | undefined
  ) {
    this.parameter = parameter
    this.type = type
    this.merge = merge
    if (isOptional(type) && !containsUndefined(type)) {
      throw new Error("Cannot use `Schema.optionalKey` with index signatures, use `Schema.optional` instead.")
    }
  }
}

/**
 * AST node for object-like types — both structs and records.
 *
 * - `propertySignatures` — named properties with their types (struct fields).
 * - `indexSignatures` — index signature entries (record patterns), each with
 *   a `parameter` AST (the key type) and a `type` AST (the value type).
 *
 * An `Objects` with no properties and no index signatures acts as a bare
 * `object | array` type check (accepts any non-nullish value).
 *
 * Duplicate property names throw at construction time.
 *
 * **Example** (Inspecting a struct AST)
 *
 * ```ts
 * import { Schema, SchemaAST } from "effect"
 *
 * const schema = Schema.Struct({ name: Schema.String })
 * const ast = schema.ast
 *
 * if (SchemaAST.isObjects(ast)) {
 *   for (const ps of ast.propertySignatures) {
 *     console.log(ps.name, ps.type._tag)
 *   }
 *   // "name" "String"
 * }
 * ```
 *
 * @see {@link isObjects}
 * @see {@link PropertySignature}
 * @see {@link IndexSignature}
 * @see {@link Arrays}
 *
 * @category model
 * @since 4.0.0
 */
export class Objects extends Base {
  readonly _tag = "Objects"
  readonly propertySignatures: ReadonlyArray<PropertySignature>
  readonly indexSignatures: ReadonlyArray<IndexSignature>

  constructor(
    propertySignatures: ReadonlyArray<PropertySignature>,
    indexSignatures: ReadonlyArray<IndexSignature>,
    annotations?: Schema.Annotations.Annotations,
    checks?: Checks,
    encoding?: Encoding,
    context?: Context
  ) {
    super(annotations, checks, encoding, context)
    this.propertySignatures = propertySignatures
    this.indexSignatures = indexSignatures

    // Duplicate property signatures
    const duplicates = propertySignatures.map((ps) => ps.name).filter((name, i, arr) => arr.indexOf(name) !== i)
    if (duplicates.length > 0) {
      throw new Error(`Duplicate identifiers: ${JSON.stringify(duplicates)}. ts(2300)`)
    }
  }
  /** @internal */
  getParser(recur: (ast: AST) => Parser.Parser): Parser.Parser {
    // oxlint-disable-next-line @typescript-eslint/no-this-alias
    const ast = this
    const expectedKeys: Array<PropertyKey> = []
    const expectedKeysSet = new Set<PropertyKey>()
    const properties: Array<{
      readonly ps: PropertySignature
      readonly parser: Parser.Parser
      readonly name: PropertyKey
      readonly type: AST
    }> = []
    const propertyCount = ast.propertySignatures.length
    for (const ps of ast.propertySignatures) {
      expectedKeys.push(ps.name)
      expectedKeysSet.add(ps.name)
      properties.push({
        ps,
        parser: recur(ps.type),
        name: ps.name,
        type: ps.type
      })
    }
    const indexCount = ast.indexSignatures.length
    // ---------------------------------------------
    // handle empty struct
    // ---------------------------------------------
    if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0) {
      return fromRefinement(ast, Predicate.isNotNullish)
    }
    return Effect.fnUntracedEager(function*(oinput, options) {
      if (oinput._tag === "None") {
        return oinput
      }
      const input = oinput.value as Record<PropertyKey, unknown>

      // If the input is not a record, return early with an error
      if (!(typeof input === "object" && input !== null && !Array.isArray(input))) {
        return yield* Effect.fail(new Issue.InvalidType(ast, oinput))
      }

      const out: Record<PropertyKey, unknown> = {}
      let issues: Arr.NonEmptyArray<Issue.Issue> | undefined
      const errorsAllOption = options.errors === "all"
      const onExcessPropertyError = options.onExcessProperty === "error"
      const onExcessPropertyPreserve = options.onExcessProperty === "preserve"

      // ---------------------------------------------
      // handle excess properties
      // ---------------------------------------------
      let inputKeys: Array<PropertyKey> | undefined
      if (ast.indexSignatures.length === 0 && (onExcessPropertyError || onExcessPropertyPreserve)) {
        inputKeys = Reflect.ownKeys(input)
        for (let i = 0; i < inputKeys.length; i++) {
          const key = inputKeys[i]
          if (!expectedKeysSet.has(key)) {
            // key is unexpected
            if (onExcessPropertyError) {
              const issue = new Issue.Pointer([key], new Issue.UnexpectedKey(ast, input[key]))
              if (errorsAllOption) {
                if (issues) {
                  issues.push(issue)
                } else {
                  issues = [issue]
                }
                continue
              } else {
                return yield* Effect.fail(new Issue.Composite(ast, oinput, [issue]))
              }
            } else {
              // preserve key
              internalRecord.set(out, key, input[key])
            }
          }
        }
      }

      // ---------------------------------------------
      // handle property signatures
      // ---------------------------------------------
      for (let i = 0; i < propertyCount; i++) {
        const p = properties[i]
        const value: Option.Option<unknown> = Object.hasOwn(input, p.name)
          ? Option.some(input[p.name])
          : Option.none()
        const eff = p.parser(value, options)
        const exit = effectIsExit(eff) ? eff : yield* Effect.exit(eff)
        if (exit._tag === "Failure") {
          const issueProp = Cause.findError(exit.cause)
          if (Result.isFailure(issueProp)) {
            return yield* exit
          }
          const issue = new Issue.Pointer([p.name], issueProp.success)
          if (errorsAllOption) {
            if (issues) issues.push(issue)
            else issues = [issue]
            continue
          } else {
            return yield* Effect.fail(new Issue.Composite(ast, oinput, [issue]))
          }
        } else if (exit.value._tag === "Some") {
          internalRecord.set(out, p.name, exit.value.value)
        } else if (!isOptional(p.type)) {
          const issue = new Issue.Pointer([p.name], new Issue.MissingKey(p.type.context?.annotations))
          if (errorsAllOption) {
            if (issues) issues.push(issue)
            else issues = [issue]
            continue
          } else {
            return yield* Effect.fail(
              new Issue.Composite(ast, oinput, [issue])
            )
          }
        }
      }

      // ---------------------------------------------
      // handle index signatures
      // ---------------------------------------------
      if (indexCount > 0) {
        for (let i = 0; i < indexCount; i++) {
          const is = ast.indexSignatures[i]
          const keys = getIndexSignatureKeys(input, is.parameter)
          for (let j = 0; j < keys.length; j++) {
            const key = keys[j]
            const parserKey = recur(indexSignatureParameterFromString(is.parameter))
            const effKey = parserKey(Option.some(key), options)
            const exitKey = (effectIsExit(effKey) ? effKey : yield* Effect.exit(effKey)) as Exit.Exit<
              Option.Option<PropertyKey>,
              Issue.Issue
            >
            if (exitKey._tag === "Failure") {
              const issueKey = Cause.findError(exitKey.cause)
              if (Result.isFailure(issueKey)) {
                return yield* exitKey
              }
              const issue = new Issue.Pointer([key], issueKey.success)
              if (errorsAllOption) {
                if (issues) issues.push(issue)
                else issues = [issue]
                continue
              }
              return yield* Effect.fail(
                new Issue.Composite(ast, oinput, [issue])
              )
            }

            const value: Option.Option<unknown> = Option.some(input[key])
            const parserValue = recur(is.type)
            const effValue = parserValue(value, options)
            const exitValue = effectIsExit(effValue) ? effValue : yield* Effect.exit(effValue)
            if (exitValue._tag === "Failure") {
              const issueValue = Cause.findError(exitValue.cause)
              if (Result.isFailure(issueValue)) {
                return yield* exitValue
              }
              const issue = new Issue.Pointer([key], issueValue.success)
              if (errorsAllOption) {
                if (issues) issues.push(issue)
                else issues = [issue]
                continue
              } else {
                return yield* Effect.fail(
                  new Issue.Composite(ast, oinput, [issue])
                )
              }
            } else if (exitKey.value._tag === "Some" && exitValue.value._tag === "Some") {
              const k2 = exitKey.value.value
              const v2 = exitValue.value.value
              if (is.merge && is.merge.decode && Object.hasOwn(out, k2)) {
                const [k, v] = is.merge.decode.combine([k2, out[k2]], [k2, v2])
                internalRecord.set(out, k, v)
              } else {
                internalRecord.set(out, k2, v2)
              }
            }
          }
        }
      }

      if (issues) {
        return yield* Effect.fail(new Issue.Composite(ast, oinput, issues))
      }
      if (options.propertyOrder === "original") {
        // preserve input keys order
        const keys = (inputKeys ?? Reflect.ownKeys(input)).concat(expectedKeys)
        const preserved: Record<PropertyKey, unknown> = {}
        for (const key of keys) {
          if (Object.hasOwn(out, key)) {
            internalRecord.set(preserved, key, out[key])
          }
        }
        return Option.some(preserved)
      }
      return Option.some(out)
    })
  }
  private rebuild(
    recur: (ast: AST) => AST,
    flipMerge: boolean
  ): Objects {
    const props = mapOrSame(this.propertySignatures, (ps) => {
      const t = recur(ps.type)
      return t === ps.type ? ps : new PropertySignature(ps.name, t)
    })

    const indexes = mapOrSame(this.indexSignatures, (is) => {
      const p = recur(is.parameter)
      const t = recur(is.type)
      const merge = flipMerge ? is.merge?.flip() : is.merge
      return p === is.parameter && t === is.type && merge === is.merge
        ? is
        : new IndexSignature(p, t, merge)
    })

    return props === this.propertySignatures && indexes === this.indexSignatures
      ? this
      : new Objects(props, indexes, this.annotations, this.checks, undefined, this.context)
  }
  /** @internal */
  flip(recur: (ast: AST) => AST): AST {
    return this.rebuild(recur, true)
  }
  /** @internal */
  recur(recur: (ast: AST) => AST): AST {
    return this.rebuild(recur, false)
  }
  /** @internal */
  getExpected(): string {
    if (this.propertySignatures.length === 0 && this.indexSignatures.length === 0) return "object | array"
    return "object"
  }
}

function mergeChecks(checks: Checks | undefined, b: AST): Checks | undefined {
  if (!checks) {
    return b.checks
  }
  if (!b.checks) {
    return checks
  }
  return [...checks, ...b.checks]
}

/** @internal */
export function struct<Fields extends Schema.Struct.Fields>(
  fields: Fields,
  checks: Checks | undefined,
  annotations?: Schema.Annotations.Annotations
): Objects {
  return new Objects(
    Reflect.ownKeys(fields).map((key) => {
      return new PropertySignature(key, fields[key].ast)
    }),
    [],
    annotations,
    checks
  )
}

/** @internal */
export function getAST<S extends Schema.Top>(self: S): S["ast"] {
  return self.ast
}

/** @internal */
export function tuple<Elements extends Schema.Tuple.Elements>(
  elements: Elements,
  checks: Checks | undefined = undefined
): Arrays {
  return new Arrays(false, elements.map((e) => e.ast), [], undefined, checks)
}

/** @internal */
export function union<Members extends ReadonlyArray<Schema.Top>>(
  members: Members,
  mode: "anyOf" | "oneOf",
  checks: Checks | undefined
): Union<Members[number]["ast"]> {
  return new Union(members.map(getAST), mode, undefined, checks)
}

/** @internal */
export function structWithRest(ast: Objects, records: ReadonlyArray<Objects>): Objects {
  if (ast.encoding || records.some((r) => r.encoding)) {
    throw new Error("StructWithRest does not support encodings")
  }
  let propertySignatures = ast.propertySignatures
  let indexSignatures = ast.indexSignatures
  let checks = ast.checks
  for (const r of records) {
    propertySignatures = propertySignatures.concat(r.propertySignatures)
    indexSignatures = indexSignatures.concat(r.indexSignatures)
    checks = mergeChecks(checks, r)
  }
  return new Objects(propertySignatures, indexSignatures, undefined, checks)
}

/** @internal */
export function tupleWithRest(ast: Arrays, rest: ReadonlyArray<AST>): Arrays {
  if (ast.encoding) {
    throw new Error("TupleWithRest does not support encodings")
  }
  return new Arrays(ast.isMutable, ast.elements, rest, undefined, ast.checks)
}

type Type =
  | "null"
  | "array"
  | "object"
  | "string"
  | "number"
  | "boolean"
  | "symbol"
  | "undefined"
  | "bigint"
  | "function"

/** @internal */
export type Sentinel = {
  readonly key: PropertyKey
  readonly literal: LiteralValue | symbol
}

function getCandidateTypes(ast: AST): ReadonlyArray<Type> {
  switch (ast._tag) {
    case "Null":
      return ["null"]
    case "Undefined":
    case "Void":
      return ["undefined"]
    case "String":
    case "TemplateLiteral":
      return ["string"]
    case "Number":
      return ["number"]
    case "Boolean":
      return ["boolean"]
    case "Symbol":
    case "UniqueSymbol":
      return ["symbol"]
    case "BigInt":
      return ["bigint"]
    case "Arrays":
      return ["array"]
    case "ObjectKeyword":
      return ["object", "array", "function"]
    case "Objects":
      return ast.propertySignatures.length || ast.indexSignatures.length
        ? ["object"]
        : ["object", "array"]
    case "Enum":
      return Array.from(new Set(ast.enums.map(([, v]) => typeof v)))
    case "Literal":
      return [typeof ast.literal]
    case "Union":
      return Array.from(new Set(ast.types.flatMap(getCandidateTypes)))
    default:
      return [
        "null",
        "undefined",
        "string",
        "number",
        "boolean",
        "symbol",
        "bigint",
        "object",
        "array",
        "function"
      ]
  }
}

/** @internal */
export function collectSentinels(ast: AST): Array<Sentinel> {
  switch (ast._tag) {
    default:
      return []
    case "Declaration": {
      const s = ast.annotations?.["~sentinels"]
      return Array.isArray(s) ? s : []
    }
    case "Objects":
      return ast.propertySignatures.flatMap((ps): Array<Sentinel> => {
        const type = ps.type
        if (!isOptional(type)) {
          if (isLiteral(type)) {
            return [{ key: ps.name, literal: type.literal }]
          }
          if (isUniqueSymbol(type)) {
            return [{ key: ps.name, literal: type.symbol }]
          }
        }
        return []
      })
    case "Arrays":
      return ast.elements.flatMap((e, i) => {
        return isLiteral(e) && !isOptional(e)
          ? [{ key: i, literal: e.literal }]
          : []
      })
    case "Suspend":
      return collectSentinels(ast.thunk())
  }
}

type CandidateIndex = {
  byType?: { [K in Type]?: Array<AST> }
  bySentinel?: Map<PropertyKey, Map<LiteralValue | symbol, Array<AST>>>
  otherwise?: { [K in Type]?: Array<AST> }
}

const candidateIndexCache = new WeakMap<ReadonlyArray<AST>, CandidateIndex>()

function getIndex(types: ReadonlyArray<AST>): CandidateIndex {
  let idx = candidateIndexCache.get(types)
  if (idx) return idx

  idx = {}
  for (const a of types) {
    const encoded = toEncoded(a)
    if (isNever(encoded)) continue

    const types = getCandidateTypes(encoded)
    const sentinels = collectSentinels(encoded)

    // by-type (always filled – cheap primary filter)
    idx.byType ??= {}
    for (const t of types) (idx.byType[t] ??= []).push(a)

    if (sentinels.length > 0) { // discriminated variants
      idx.bySentinel ??= new Map()
      for (const { key, literal } of sentinels) {
        let m = idx.bySentinel.get(key)
        if (!m) idx.bySentinel.set(key, m = new Map())
        let arr = m.get(literal)
        if (!arr) m.set(literal, arr = [])
        arr.push(a)
      }
    } else { // non-discriminated
      idx.otherwise ??= {}
      for (const t of types) (idx.otherwise[t] ??= []).push(a)
    }
  }

  candidateIndexCache.set(types, idx)
  return idx
}

function filterLiterals(input: any) {
  return (ast: AST) => {
    const encoded = toEncoded(ast)
    return encoded._tag === "Literal" ?
      encoded.literal === input
      : encoded._tag === "UniqueSymbol" ?
      encoded.symbol === input
      : true
  }
}

/**
 * The goal is to reduce the number of a union members that will be checked.
 * This is useful to reduce the number of issues that will be returned.
 *
 * @internal
 */
export function getCandidates(input: any, types: ReadonlyArray<AST>): ReadonlyArray<AST> {
  const idx = getIndex(types)
  const runtimeType: Type = input === null ? "null" : Array.isArray(input) ? "array" : typeof input

  // 1. Try sentinel-based dispatch (most selective)
  if (idx.bySentinel) {
    const base = idx.otherwise?.[runtimeType] ?? []
    if (runtimeType === "object" || runtimeType === "array") {
      for (const [k, m] of idx.bySentinel) {
        if (Object.hasOwn(input, k)) {
          const match = m.get((input as any)[k])
          if (match) return [...match, ...base].filter(filterLiterals(input))
        }
      }
    }
    return base
  }

  // 2. Fallback: runtime-type dispatch only
  return (idx.byType?.[runtimeType] ?? []).filter(filterLiterals(input))
}

/**
 * AST node representing a union of schemas.
 *
 * - `types` — the member AST nodes.
 * - `mode` — `"anyOf"` succeeds on the first match (like TypeScript unions);
 *   `"oneOf"` requires exactly one member to match (fails if multiple do).
 *
 * During parsing, members are tried in order. An internal candidate index
 * narrows which members to try based on the runtime type of the input and
 * discriminant ("sentinel") fields, making large unions efficient.
 *
 * **Example** (Inspecting a union AST)
 *
 * ```ts
 * import { Schema, SchemaAST } from "effect"
 *
 * const schema = Schema.Union([Schema.String, Schema.Number])
 * const ast = schema.ast
 *
 * if (SchemaAST.isUnion(ast)) {
 *   console.log(ast.types.length) // 2
 *   console.log(ast.mode)         // "anyOf"
 * }
 * ```
 *
 * @see {@link isUnion}
 *
 * @category model
 * @since 4.0.0
 */
export class Union<A extends AST = AST> extends Base {
  readonly _tag = "Union"
  readonly types: ReadonlyArray<A>
  readonly mode: "anyOf" | "oneOf"

  constructor(
    types: ReadonlyArray<A>,
    mode: "anyOf" | "oneOf",
    annotations?: Schema.Annotations.Annotations,
    checks?: Checks,
    encoding?: Encoding,
    context?: Context
  ) {
    super(annotations, checks, encoding, context)
    this.types = types
    this.mode = mode
  }
  /** @internal */
  getParser(recur: (ast: AST) => Parser.Parser): Parser.Parser {
    // oxlint-disable-next-line @typescript-eslint/no-this-alias
    const ast = this
    return Effect.fnUntracedEager(function*(oinput, options) {
      if (oinput._tag === "None") {
        return oinput
      }
      const input = oinput.value
      const oneOf = ast.mode === "oneOf"
      const candidates = getCandidates(input, ast.types)
      let issues: Arr.NonEmptyArray<Issue.Issue> | undefined

      const tracking: {
        out: Option.Option<unknown> | undefined
        successes: Array<AST>
      } = {
        out: undefined,
        successes: []
      }
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]
        const parser = recur(candidate)
        const eff = parser(oinput, options)
        const exit = effectIsExit(eff) ? eff : yield* Effect.exit(eff)
        if (exit._tag === "Failure") {
          const issueResult = Cause.findError(exit.cause)
          if (Result.isFailure(issueResult)) {
            return yield* exit
          }
          if (issues) issues.push(issueResult.success)
          else issues = [issueResult.success]
          continue
        } else {
          if (tracking.out && oneOf) {
            tracking.successes.push(candidate)
            return yield* Effect.fail(new Issue.OneOf(ast, input, tracking.successes))
          }
          tracking.out = exit.value
          tracking.successes.push(candidate)
          if (!oneOf) {
            break
          }
        }
      }

      if (tracking.out) {
        return tracking.out
      } else {
        return yield* Effect.fail(new Issue.AnyOf(ast, input, issues ?? []))
      }
    })
  }
  /** @internal */
  recur(recur: (ast: AST) => AST) {
    const types = mapOrSame(this.types, recur)
    return types === this.types ?
      this :
      new Union(types, this.mode, this.annotations, this.checks, undefined, this.context)
  }
  /** @internal */
  getExpected(getExpected: (ast: AST) => string): string {
    const expected = this.annotations?.expected
    if (typeof expected === "string") return expected

    if (this.types.length === 0) return "never"

    const types = this.types.map((type) => {
      const encoded = toEncoded(type)
      switch (encoded._tag) {
        case "Arrays": {
          const literals = encoded.elements.filter(isLiteral)
          if (literals.length > 0) {
            return `${formatIsMutable(encoded.isMutable)}[ ${
              literals.map((e) => getExpected(e) + formatIsOptional(e.context?.isOptional)).join(", ")
            }, ... ]`
          }
          break
        }
        case "Objects": {
          const literals = encoded.propertySignatures.filter((ps) => isLiteral(ps.type))
          if (literals.length > 0) {
            return `{ ${
              literals.map((ps) =>
                `${formatIsMutable(ps.type.context?.isMutable)}${formatPropertyKey(ps.name)}${
                  formatIsOptional(ps.type.context?.isOptional)
                }: ${getExpected(ps.type)}`
              ).join(", ")
            }, ... }`
          }
          break
        }
      }
      return getExpected(encoded)
    })
    return Array.from(new Set(types)).join(" | ")
  }
}

const nonFiniteLiterals = new Union([
  new Literal("Infinity"),
  new Literal("-Infinity"),
  new Literal("NaN")
], "anyOf")

const numberToJson = new Link(
  new Union([number, nonFiniteLiterals], "anyOf"),
  new Transformation.Transformation(
    Getter.Number(),
    Getter.transform((n) => globalThis.Number.isFinite(n) ? n : globalThis.String(n))
  )
)

function formatIsMutable(isMutable: boolean | undefined): string {
  return isMutable ? "" : "readonly "
}

function formatIsOptional(isOptional: boolean | undefined): string {
  return isOptional ? "?" : ""
}

/** @internal */
export function memoizeThunk<A>(f: () => A): () => A {
  let done = false
  let a: A
  return () => {
    if (done) {
      return a
    }
    a = f()
    done = true
    return a
  }
}

/**
 * AST node for lazy/recursive schemas.
 *
 * Wraps a thunk (`() => AST`) that is memoized on first call. Use this to
 * define recursive or mutually recursive schemas without infinite loops at
 * construction time.
 *
 * **Example** (Recursive schema AST)
 *
 * ```ts
 * import { Schema, SchemaAST } from "effect"
 *
 * interface Category {
 *   readonly name: string
 *   readonly children: ReadonlyArray<Category>
 * }
 *
 * const Category = Schema.Struct({
 *   name: Schema.String,
 *   children: Schema.Array(Schema.suspend((): Schema.Codec<Category> => Category))
 * })
 *
 * // The recursive branch is a Suspend node
 * ```
 *
 * @see {@link isSuspend}
 *
 * @category model
 * @since 4.0.0
 */
export class Suspend extends Base {
  readonly _tag = "Suspend"
  readonly thunk: () => AST

  constructor(
    thunk: () => AST,
    annotations?: Schema.Annotations.Annotations,
    checks?: Checks,
    encoding?: Encoding,
    context?: Context
  ) {
    super(annotations, checks, encoding, context)
    this.thunk = memoizeThunk(thunk)
  }
  /** @internal */
  getParser(recur: (ast: AST) => Parser.Parser): Parser.Parser {
    return recur(this.thunk())
  }
  /** @internal */
  recur(recur: (ast: AST) => AST) {
    return new Suspend(() => recur(this.thunk()), this.annotations, this.checks, undefined, this.context)
  }
  /** @internal */
  getExpected(getExpected: (ast: AST) => string): string {
    return getExpected(this.thunk())
  }
}

// -----------------------------------------------------------------------------
// Checks
// -----------------------------------------------------------------------------

/**
 * A single validation check attached to an AST node.
 *
 * - `run` — the validation function. Returns `undefined` on success, or an
 *   `Issue` on failure.
 * - `annotations` — optional filter-level metadata (expected message, meta
 *   tags, arbitrary constraint hints).
 * - `aborted` — when `true`, parsing stops immediately after this filter
 *   fails (no further checks run).
 *
 * Use `.annotate()` to add metadata and `.abort()` to mark as aborting.
 * Combine with another check via `.and()` to form a {@link FilterGroup}.
 *
 * @see {@link FilterGroup}
 * @see {@link Check}
 * @see {@link isPattern}
 *
 * @category model
 * @since 4.0.0
 */
export class Filter<in E> extends Pipeable.Class {
  readonly _tag = "Filter"
  readonly run: (input: E, self: AST, options: ParseOptions) => Issue.Issue | undefined
  readonly annotations: Schema.Annotations.Filter | undefined
  /**
   * Whether the parsing process should be aborted after this check has failed.
   */
  readonly aborted: boolean

  constructor(
    run: (input: E, self: AST, options: ParseOptions) => Issue.Issue | undefined,
    annotations: Schema.Annotations.Filter | undefined = undefined,
    /**
     * Whether the parsing process should be aborted after this check has failed.
     */
    aborted: boolean = false
  ) {
    super()
    this.run = run
    this.annotations = annotations
    this.aborted = aborted
  }
  annotate(annotations: Schema.Annotations.Filter): Filter<E> {
    return new Filter(this.run, { ...this.annotations, ...annotations }, this.aborted)
  }
  abort(): Filter<E> {
    return new Filter(this.run, this.annotations, true)
  }
  and(other: Check<E>, annotations?: Schema.Annotations.Filter): FilterGroup<E>
  and(other: Check<E>, annotations?: Schema.Annotations.Filter): FilterGroup<E> {
    return new FilterGroup([this, other], annotations)
  }
}

/**
 * A composite validation check grouping multiple {@link Check} values.
 *
 * Created by calling `.and()` on a {@link Filter} or another `FilterGroup`.
 * All inner checks are run; failures from aborted filters still stop
 * evaluation.
 *
 * @see {@link Filter}
 * @see {@link Check}
 *
 * @category model
 * @since 4.0.0
 */
export class FilterGroup<in E> extends Pipeable.Class {
  readonly _tag = "FilterGroup"
  readonly checks: readonly [Check<E>, ...Array<Check<E>>]
  readonly annotations: Schema.Annotations.Filter | undefined

  constructor(
    checks: readonly [Check<E>, ...Array<Check<E>>],
    annotations: Schema.Annotations.Filter | undefined = undefined
  ) {
    super()
    this.checks = checks
    this.annotations = annotations
  }
  annotate(annotations: Schema.Annotations.Filter): FilterGroup<E> {
    return new FilterGroup(this.checks, { ...this.annotations, ...annotations })
  }
  and(other: Check<E>, annotations?: Schema.Annotations.Filter): FilterGroup<E>
  and(other: Check<E>, annotations?: Schema.Annotations.Filter): FilterGroup<E> {
    return new FilterGroup([this, other], annotations)
  }
}

/**
 * A validation check — either a single {@link Filter} or a composite
 * {@link FilterGroup}.
 *
 * Stored in the {@link Checks} array on {@link Base.checks}.
 *
 * @see {@link Filter}
 * @see {@link FilterGroup}
 *
 * @category model
 * @since 4.0.0
 */
export type Check<T> = Filter<T> | FilterGroup<T>

/** @internal */
export function makeFilter<T>(
  filter: (
    input: T,
    ast: AST,
    options: ParseOptions
  ) => undefined | boolean | string | Issue.Issue | {
    readonly path: ReadonlyArray<PropertyKey>
    readonly message: string
  },
  annotations?: Schema.Annotations.Filter | undefined,
  aborted: boolean = false
): Filter<T> {
  return new Filter(
    (input, ast, options) => Issue.make(input, filter(input, ast, options)),
    annotations,
    aborted
  )
}

/** @internal */
export function makeFilterByGuard<T extends E, E>(
  is: (value: E) => value is T,
  annotations?: Schema.Annotations.Filter
): Filter<any> {
  return new Filter(
    (input: E) => is(input) ? undefined : new Issue.InvalidValue(Option.some(input)),
    annotations,
    true // after a guard, we always want to abort
  )
}

/**
 * Creates a {@link Filter} that validates strings against a regular expression.
 *
 * - Returns a `Filter<string>` suitable for use with `Schema.filter` or
 *   attached directly to a `String` AST node via checks.
 * - The regex `source` is stored in annotations for serialization and
 *   arbitrary generation.
 *
 * **Example** (Validating an email pattern)
 *
 * ```ts
 * import { SchemaAST } from "effect"
 *
 * const emailFilter = SchemaAST.isPattern(/^[^@]+@[^@]+$/)
 * ```
 *
 * @see {@link Filter}
 *
 * @since 4.0.0
 */
export function isPattern(regExp: globalThis.RegExp, annotations?: Schema.Annotations.Filter) {
  const source = regExp.source
  return makeFilter(
    (s: string) => regExp.test(s),
    {
      expected: `a string matching the RegExp ${source}`,
      meta: {
        _tag: "isPattern",
        regExp
      },
      toArbitraryConstraint: {
        string: {
          patterns: [regExp.source]
        }
      },
      ...annotations
    }
  )
}

function modifyOwnPropertyDescriptors<A extends AST>(
  ast: A,
  f: (
    d: { [P in keyof A]: TypedPropertyDescriptor<A[P]> }
  ) => void
): A {
  const d = Object.getOwnPropertyDescriptors(ast)
  f(d)
  return Object.create(Object.getPrototypeOf(ast), d)
}

/** @internal */
export function replaceEncoding<A extends AST>(ast: A, encoding: Encoding | undefined): A {
  if (ast.encoding === encoding) {
    return ast
  }
  return modifyOwnPropertyDescriptors(ast, (d) => {
    d.encoding.value = encoding
  })
}

/** @internal */
export function replaceContext<A extends AST>(ast: A, context: Context | undefined): A {
  if (ast.context === context) {
    return ast
  }
  return modifyOwnPropertyDescriptors(ast, (d) => {
    d.context.value = context
  })
}

/** @internal */
export function getLastEncoding(ast: AST): AST {
  return ast.encoding ? getLastEncoding(ast.encoding[ast.encoding.length - 1].to) : ast
}

/** @internal */
export function annotate<A extends AST>(ast: A, annotations: Schema.Annotations.Annotations): A {
  if (ast.checks) {
    const last = ast.checks[ast.checks.length - 1]
    return replaceChecks(ast, Arr.append(ast.checks.slice(0, -1), last.annotate(annotations)))
  }
  return modifyOwnPropertyDescriptors(ast, (d) => {
    d.annotations.value = { ...d.annotations.value, ...annotations }
  })
}

/** @internal */
export function replaceChecks<A extends AST>(ast: A, checks: Checks | undefined): A {
  if (ast.checks === checks) {
    return ast
  }
  return modifyOwnPropertyDescriptors(ast, (d) => {
    d.checks.value = checks
  })
}

/** @internal */
export function appendChecks<A extends AST>(ast: A, checks: Checks): A {
  return replaceChecks(ast, ast.checks ? [...ast.checks, ...checks] : checks)
}

function updateLastLink(encoding: Encoding, f: (ast: AST) => AST): Encoding {
  const links = encoding
  const last = links[links.length - 1]
  const to = f(last.to)
  if (to !== last.to) {
    return Arr.append(encoding.slice(0, encoding.length - 1), new Link(to, last.transformation))
  }
  return encoding
}

/** @internal */
export function applyToLastLink(f: (ast: AST) => AST) {
  return <A extends AST>(ast: A): A => ast.encoding ? replaceEncoding(ast, updateLastLink(ast.encoding, f)) : ast
}

/** @internal */
export function middlewareDecoding(
  ast: AST,
  middleware: Transformation.Middleware<any, any, any, any, any, any>
): AST {
  return appendTransformation(ast, middleware, toType(ast))
}

/** @internal */
export function middlewareEncoding(
  ast: AST,
  middleware: Transformation.Middleware<any, any, any, any, any, any>
): AST {
  return appendTransformation(toEncoded(ast), middleware, ast)
}

function appendTransformation<A extends AST>(
  from: AST,
  transformation:
    | Transformation.Transformation<any, any, any, any>
    | Transformation.Middleware<any, any, any, any, any, any>,
  to: A
): A {
  const link = new Link(from, transformation)
  return replaceEncoding(to, to.encoding ? [...to.encoding, link] : [link])
}

/** @internal */
export function brand(ast: AST, brand: string): AST {
  const existing = InternalAnnotations.resolveBrands(ast)
  const brands = existing ? [...existing, brand] : [brand]
  return annotate(ast, { brands })
}

/**
 * Maps over the array but will return the original array if no changes occur.
 * @internal
 */
export function mapOrSame<A>(as: Arr.NonEmptyReadonlyArray<A>, f: (a: A) => A): Arr.NonEmptyReadonlyArray<A>
export function mapOrSame<A>(as: ReadonlyArray<A>, f: (a: A) => A): ReadonlyArray<A>
export function mapOrSame<A>(as: ReadonlyArray<A>, f: (a: A) => A): ReadonlyArray<A> {
  let changed = false
  const out: Array<A> = new Array(as.length)
  for (let i = 0; i < as.length; i++) {
    const a = as[i]
    const fa = f(a)
    if (fa !== a) {
      changed = true
    }
    out[i] = fa
  }
  return changed ? out : as
}

/** @internal */
export function annotateKey<A extends AST>(ast: A, annotations: Schema.Annotations.Key<unknown>): A {
  const context = ast.context ?
    new Context(
      ast.context.isOptional,
      ast.context.isMutable,
      ast.context.defaultValue,
      { ...ast.context.annotations, ...annotations }
    ) :
    new Context(false, false, undefined, annotations)
  return replaceContext(ast, context)
}

/** @internal */
export const optionalKeyLastLink = applyToLastLink(optionalKey)

/**
 * Marks an AST node's property key as optional by setting
 * {@link Context.isOptional} to `true`.
 *
 * Also propagates the optional flag through the last link of the encoding
 * chain if present.
 *
 * @see {@link isOptional}
 * @see {@link Context}
 *
 * @since 4.0.0
 */
export function optionalKey<A extends AST>(ast: A): A {
  const context = ast.context ?
    ast.context.isOptional === false ?
      new Context(true, ast.context.isMutable, ast.context.defaultValue, ast.context.annotations) :
      ast.context :
    new Context(true, false)
  return optionalKeyLastLink(replaceContext(ast, context))
}

const mutableKeyLastLink = applyToLastLink(mutableKey)

/** @internal */
export function mutableKey<A extends AST>(ast: A): A {
  const context = ast.context ?
    ast.context.isMutable === false ?
      new Context(ast.context.isOptional, true, ast.context.defaultValue, ast.context.annotations) :
      ast.context :
    new Context(false, true)
  return mutableKeyLastLink(replaceContext(ast, context))
}

/** @internal */
export function withConstructorDefault<A extends AST>(
  ast: A,
  /**
   * The `input` parameters is `None` if the value is not present and
   * `Some(undefined)` if the value is present but undefined
   */
  defaultValue: (input: Option.Option<undefined>) => Option.Option<unknown> | Effect.Effect<Option.Option<unknown>>
): A {
  const transformation = new Transformation.Transformation(
    new Getter.Getter((o) => {
      if (Option.isNone(Option.filter(o, Predicate.isNotUndefined))) {
        const oe = defaultValue(o as Option.Option<undefined>)
        return Effect.isEffect(oe) ? oe : Effect.succeed(oe)
      } else {
        return Effect.succeed(o)
      }
    }),
    Getter.passthrough()
  )
  const encoding: Encoding = [new Link(unknown, transformation)]
  const context = ast.context ?
    new Context(ast.context.isOptional, ast.context.isMutable, encoding, ast.context.annotations) :
    new Context(false, false, encoding)
  return replaceContext(ast, context)
}

/**
 * Attaches a `Transformation` to the `to` AST, making it decode from the
 * `from` AST and encode back to it.
 *
 * This is the low-level primitive behind `Schema.transform` and
 * `Schema.transformOrFail`. It appends a {@link Link} to the `to` node's
 * encoding chain.
 *
 * - Does not mutate either input.
 * - Returns a new AST with the same type as `to`.
 *
 * @see {@link Link}
 * @see {@link Encoding}
 * @see {@link flip}
 *
 * @since 4.0.0
 */
export function decodeTo<A extends AST>(
  from: AST,
  to: A,
  transformation: Transformation.Transformation<any, any, any, any>
): A {
  return appendTransformation(from, transformation, to)
}

function parseParameter(ast: AST): {
  literals: ReadonlyArray<PropertyKey>
  parameters: ReadonlyArray<AST>
} {
  switch (ast._tag) {
    case "Literal":
      return {
        literals: Predicate.isPropertyKey(ast.literal) ? [ast.literal] : [],
        parameters: []
      }
    case "UniqueSymbol":
      return {
        literals: [ast.symbol],
        parameters: []
      }
    case "String":
    case "Number":
    case "Symbol":
    case "TemplateLiteral":
      return {
        literals: [],
        parameters: [ast]
      }
    case "Union": {
      const out: {
        literals: ReadonlyArray<PropertyKey>
        parameters: ReadonlyArray<AST>
      } = { literals: [], parameters: [] }
      for (let i = 0; i < ast.types.length; i++) {
        const parsed = parseParameter(ast.types[i])
        out.literals = out.literals.concat(parsed.literals)
        out.parameters = out.parameters.concat(parsed.parameters)
      }
      return out
    }
  }
  return { literals: [], parameters: [] }
}

/** @internal */
export function record(key: AST, value: AST, keyValueCombiner: KeyValueCombiner | undefined): Objects {
  const { literals, parameters: indexSignatures } = parseParameter(key)
  return new Objects(
    literals.map((literal) => new PropertySignature(literal, value)),
    indexSignatures.map((parameter) => new IndexSignature(parameter, value, keyValueCombiner))
  )
}

// -------------------------------------------------------------------------------------
// Public APIs
// -------------------------------------------------------------------------------------

/**
 * Returns `true` if the AST node represents an optional property.
 *
 * Checks `ast.context?.isOptional`. Defaults to `false` when no
 * {@link Context} is set.
 *
 * @see {@link optionalKey}
 * @see {@link Context}
 *
 * @since 4.0.0
 */
export function isOptional(ast: AST): boolean {
  return ast.context?.isOptional ?? false
}

/** @internal */
export function isMutable(ast: AST): boolean {
  return ast.context?.isMutable ?? false
}

/**
 * Strips all encoding transformations from an AST, returning the decoded
 * (type-level) representation.
 *
 * - Memoized: same input reference → same output reference.
 * - Recursively walks into composite nodes ({@link Arrays}, {@link Objects},
 *   {@link Union}, {@link Suspend}).
 * - Does not mutate the input.
 *
 * **Example** (Getting the type AST)
 *
 * ```ts
 * import { Schema, SchemaAST } from "effect"
 *
 * const schema = Schema.NumberFromString
 * const typeAst = SchemaAST.toType(schema.ast)
 * console.log(typeAst._tag) // "Number"
 * ```
 *
 * @see {@link toEncoded}
 * @see {@link flip}
 *
 * @since 4.0.0
 */
export const toType = memoize(<A extends AST>(ast: A): A => {
  if (ast.encoding) {
    return toType(replaceEncoding(ast, undefined))
  }
  const out: any = ast
  return out.recur?.(toType) ?? out
})

/**
 * Returns the encoded (wire-format) AST by flipping and then stripping
 * encodings.
 *
 * Equivalent to `toType(flip(ast))`. This gives you the AST that describes
 * the shape of the serialized/encoded data.
 *
 * - Memoized: same input reference → same output reference.
 * - Does not mutate the input.
 *
 * **Example** (Getting the encoded AST)
 *
 * ```ts
 * import { Schema, SchemaAST } from "effect"
 *
 * const schema = Schema.NumberFromString
 * const encodedAst = SchemaAST.toEncoded(schema.ast)
 * console.log(encodedAst._tag) // "String"
 * ```
 *
 * @see {@link toType}
 * @see {@link flip}
 *
 * @since 4.0.0
 */
export const toEncoded = memoize((ast: AST): AST => {
  return toType(flip(ast))
})

function flipEncoding(ast: AST, encoding: Encoding): AST {
  const links = encoding
  const len = links.length
  const last = links[len - 1]
  const ls: Arr.NonEmptyArray<Link> = [
    new Link(flip(replaceEncoding(ast, undefined)), links[0].transformation.flip())
  ]
  for (let i = 1; i < len; i++) {
    ls.unshift(new Link(flip(links[i - 1].to), links[i].transformation.flip()))
  }
  const to = flip(last.to)
  if (to.encoding) {
    return replaceEncoding(to, [...to.encoding, ...ls])
  } else {
    return replaceEncoding(to, ls)
  }
}

/**
 * Swaps the decode and encode directions of an AST's {@link Encoding} chain.
 *
 * After flipping, what was decoding becomes encoding and vice versa. This is
 * the core operation behind `Schema.encode` — encoding a value is decoding
 * with a flipped AST.
 *
 * - Memoized: same input reference → same output reference.
 * - Recursively walks composite nodes.
 * - Does not mutate the input.
 *
 * @see {@link toType}
 * @see {@link toEncoded}
 *
 * @since 4.0.0
 */
export const flip = memoize((ast: AST): AST => {
  if (ast.encoding) {
    return flipEncoding(ast, ast.encoding)
  }
  const out: any = ast
  return out.flip?.(flip) ?? out.recur?.(flip) ?? out
})

/** @internal */
export function containsUndefined(ast: AST): boolean {
  switch (ast._tag) {
    case "Undefined":
      return true
    case "Union":
      return ast.types.some(containsUndefined)
    default:
      return false
  }
}

function getTemplateLiteralSource(ast: TemplateLiteral, top: boolean): string {
  return ast.encodedParts.map((part) =>
    handleTemplateLiteralASTPartParens(part, getTemplateLiteralASTPartPattern(part), top)
  ).join("")
}

/** @internal */
export const getTemplateLiteralRegExp = memoize((ast: TemplateLiteral): RegExp => {
  return new globalThis.RegExp(`^${getTemplateLiteralSource(ast, true)}$`)
})

function getTemplateLiteralASTPartPattern(part: TemplateLiteralPart): string {
  switch (part._tag) {
    case "Literal":
      return RegEx.escape(globalThis.String(part.literal))
    case "String":
      return STRING_PATTERN
    case "Number":
      return FINITE_PATTERN
    case "BigInt":
      return BIGINT_PATTERN
    case "TemplateLiteral":
      return getTemplateLiteralSource(part, false)
    case "Union":
      return part.types.map(getTemplateLiteralASTPartPattern).join("|")
  }
}

function handleTemplateLiteralASTPartParens(part: TemplateLiteralPart, s: string, top: boolean): string {
  if (isUnion(part)) {
    if (!top) {
      return `(?:${s})`
    }
  } else if (!top) {
    return s
  }
  return `(${s})`
}

function fromConst<const T>(
  ast: AST,
  value: T
): Parser.Parser {
  const succeed = Effect.succeedSome(value)
  return (oinput) => {
    if (oinput._tag === "None") {
      return Effect.succeedNone
    }
    return oinput.value === value
      ? succeed
      : Effect.fail(new Issue.InvalidType(ast, oinput))
  }
}

function fromRefinement<T>(
  ast: AST,
  refinement: (input: unknown) => input is T
): Parser.Parser {
  return (oinput) => {
    if (oinput._tag === "None") {
      return Effect.succeedNone
    }
    return refinement(oinput.value)
      ? Effect.succeed(oinput)
      : Effect.fail(new Issue.InvalidType(ast, oinput))
  }
}

/** @internal */
export const enumsToLiterals = memoize((ast: Enum): Union<Literal> => {
  return new Union(
    ast.enums.map((e) => new Literal(e[1], { title: e[0] })),
    "anyOf"
  )
})

/** @internal */
export function toCodec(f: (ast: AST) => AST) {
  function out(ast: AST): AST {
    return ast.encoding ? replaceEncoding(ast, updateLastLink(ast.encoding, out)) : f(ast)
  }
  return memoize(out)
}

const indexSignatureParameterFromString = toCodec((ast) => {
  switch (ast._tag) {
    default:
      return ast
    case "Number":
      return ast.toCodecStringTree()
    case "Union":
      return ast.recur(indexSignatureParameterFromString)
  }
})

const templateLiteralPartFromString = toCodec((ast) => {
  switch (ast._tag) {
    default:
      return ast
    case "String":
    case "TemplateLiteral":
      return ast
    case "BigInt":
    case "Number":
    case "Literal":
      return ast.toCodecStringTree()
    case "Union":
      return ast.recur(templateLiteralPartFromString)
  }
})

/**
 * any string, including newlines
 * @internal
 */
export const STRING_PATTERN = "[\\s\\S]*?"

const isStringFiniteRegExp = new globalThis.RegExp(`^${FINITE_PATTERN}$`)

/** @internal */
export function isStringFinite(annotations?: Schema.Annotations.Filter) {
  return isPattern(
    isStringFiniteRegExp,
    {
      expected: "a string representing a finite number",
      meta: {
        _tag: "isStringFinite",
        regExp: isStringFiniteRegExp
      },
      ...annotations
    }
  )
}

const finiteString = appendChecks(string, [isStringFinite()])

const finiteToString = new Link(
  finiteString,
  Transformation.numberFromString
)

const numberToString = new Link(
  new Union([finiteString, nonFiniteLiterals], "anyOf"),
  Transformation.numberFromString
)

/**
 * signed integer only (no leading "+" because TypeScript doesn't support it)
 */
const BIGINT_PATTERN = "-?\\d+"

const isStringBigIntRegExp = new globalThis.RegExp(`^${BIGINT_PATTERN}$`)

/** @internal */
export function isStringBigInt(annotations?: Schema.Annotations.Filter) {
  return isPattern(
    isStringBigIntRegExp,
    {
      expected: "a string representing a bigint",
      meta: {
        _tag: "isStringBigInt",
        regExp: isStringBigIntRegExp
      },
      ...annotations
    }
  )
}

/** @internal */
export const bigIntString = appendChecks(string, [isStringBigInt()])

const bigIntToString = new Link(
  bigIntString,
  Transformation.bigintFromString
)

const REGEXP_PATTERN = "Symbol\\((.*)\\)"

const isStringSymbolRegExp = new globalThis.RegExp(`^${REGEXP_PATTERN}$`)

/** @internal */
export const symbolString = appendChecks(string, [isStringSymbol()])

/**
 * to distinguish between Symbol and String, we need to add a check to the string keyword
 */
const symbolToString = new Link(
  symbolString,
  new Transformation.Transformation(
    Getter.transform((description) => globalThis.Symbol.for(isStringSymbolRegExp.exec(description)![1])),
    Getter.transformOrFail((sym: symbol) => {
      const key = globalThis.Symbol.keyFor(sym)
      if (key !== undefined) {
        return Effect.succeed(globalThis.String(sym))
      }
      return Effect.fail(
        new Issue.Forbidden(Option.some(sym), { message: "cannot serialize to string, Symbol is not registered" })
      )
    })
  )
)

/** @internal */
export function isStringSymbol(annotations?: Schema.Annotations.Filter) {
  return isPattern(
    isStringSymbolRegExp,
    {
      expected: "a string representing a symbol",
      meta: {
        _tag: "isStringSymbol",
        regExp: isStringSymbolRegExp
      },
      ...annotations
    }
  )
}

/** @internal */
export function collectIssues<T>(
  checks: ReadonlyArray<Check<T>>,
  value: T,
  issues: Array<Issue.Issue>,
  ast: AST,
  options: ParseOptions
) {
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i]
    if (check._tag === "FilterGroup") {
      collectIssues(check.checks, value, issues, ast, options)
    } else {
      const issue = check.run(value, ast, options)
      if (issue) {
        issues.push(new Issue.Filter(value, check, issue))
        if (check.aborted || options?.errors !== "all") {
          return
        }
      }
    }
  }
}

/** @internal */
export function runChecks<T>(
  checks: readonly [Check<T>, ...Array<Check<T>>],
  s: T
): Result.Result<T, Issue.Issue> {
  const issues: Array<Issue.Issue> = []
  collectIssues(checks, s, issues, unknown, { errors: "all" })
  if (Arr.isArrayNonEmpty(issues)) {
    const issue = new Issue.Composite(unknown, Option.some(s), issues)
    return Result.fail(issue)
  }
  return Result.succeed(s)
}

/** @internal */
export const ClassTypeId = "~effect/Schema/Class"

/** @internal */
export const STRUCTURAL_ANNOTATION_KEY = "~structural"

/**
 * Returns all annotations from the AST node.
 *
 * If the node has {@link Checks}, returns annotations from the last check
 * (which is where user-supplied annotations end up after `.pipe(Schema.annotations(...))`).
 * Otherwise returns `Base.annotations` directly.
 *
 * **Example** (Reading annotations)
 *
 * ```ts
 * import { Schema, SchemaAST } from "effect"
 *
 * const schema = Schema.String.annotate({ title: "Name" })
 * const annotations = SchemaAST.resolve(schema.ast)
 * console.log(annotations?.title) // "Name"
 * ```
 *
 * @see {@link resolveAt}
 * @see {@link resolveIdentifier}
 * @see {@link resolveTitle}
 * @see {@link resolveDescription}
 *
 * @since 4.0.0
 */
export const resolve: (ast: AST) => Schema.Annotations.Annotations | undefined = InternalAnnotations.resolve

/**
 * Returns a single annotation value by key from the AST node.
 *
 * Like {@link resolve}, reads from the last check's annotations when checks
 * are present. Returns `undefined` if the key is not found.
 *
 * @see {@link resolve}
 *
 * @since 4.0.0
 */
export const resolveAt: <A>(key: string) => (ast: AST) => A | undefined = InternalAnnotations.resolveAt

/**
 * Returns the `identifier` annotation from the AST node, if set.
 *
 * The identifier is typically set by `Schema.annotations({ identifier: "..." })`
 * and is used for error messages and schema identification.
 *
 * @see {@link resolve}
 * @see {@link resolveTitle}
 *
 * @since 4.0.0
 */
export const resolveIdentifier: (ast: AST) => string | undefined = InternalAnnotations.resolveIdentifier

/**
 * Returns the `title` annotation from the AST node, if set.
 *
 * @see {@link resolve}
 * @see {@link resolveIdentifier}
 * @see {@link resolveDescription}
 *
 * @since 4.0.0
 */
export const resolveTitle: (ast: AST) => string | undefined = InternalAnnotations.resolveTitle

/**
 * Returns the `description` annotation from the AST node, if set.
 *
 * @see {@link resolve}
 * @see {@link resolveTitle}
 * @see {@link resolveIdentifier}
 *
 * @since 4.0.0
 */
export const resolveDescription: (ast: AST) => string | undefined = InternalAnnotations.resolveDescription

/**
 * Returns true if the value is a JSON value.
 *
 * When a cyclic reference is detected, returns false.
 *
 * @internal
 */
export function isJson(u: unknown): u is Schema.Json {
  const seen = new Set<unknown>()
  return recur(u)

  function recur(u: unknown): boolean {
    if (u === null || typeof u === "string" || typeof u === "boolean") {
      return true
    }
    if (typeof u === "number") {
      return globalThis.Number.isFinite(u)
    }
    if (typeof u !== "object" || u === undefined) {
      return false
    }
    if (seen.has(u)) {
      return false
    }
    seen.add(u)
    if (Array.isArray(u)) {
      return u.every(recur)
    }
    return Object.keys(u).every((key) => recur((u as Record<string, unknown>)[key]))
  }
}

/** @internal */
export const Json = new Declaration(
  [],
  () => (input, ast) =>
    isJson(input) ?
      Effect.succeed(input) :
      Effect.fail(new Issue.InvalidType(ast, Option.some(input))),
  {
    typeConstructor: {
      _tag: "effect/Json"
    },
    generation: {
      runtime: `Schema.Json`,
      Type: `Schema.Json`
    },
    expected: "JSON value",
    toCodecJson: () => new Link(unknown, Transformation.passthrough())
  }
)

/** @internal */
export const MutableJson = annotate(Json, {
  typeConstructor: {
    _tag: "effect/MutableJson"
  },
  generation: {
    runtime: `Schema.MutableJson`,
    Type: `Schema.MutableJson`
  }
})

/** @internal */
export const unknownToNull = new Link(
  null_,
  new Transformation.Transformation(
    Getter.passthrough(),
    Getter.transform(() => null)
  )
)

/** @internal */
export const unknownToJson = new Link(
  Json,
  Transformation.passthrough()
)

/**
 * Returns true if the value is a StringTree value.
 *
 * When a cyclic reference is detected, returns false.
 *
 * @internal
 */
export function isStringTree(u: unknown): u is Schema.StringTree {
  const seen = new Set<unknown>()
  return recur(u)

  function recur(u: unknown): boolean {
    if (u === undefined || typeof u === "string") {
      return true
    }
    if (typeof u !== "object" || u === null) {
      return false
    }
    if (seen.has(u)) {
      return false
    }
    seen.add(u)
    if (Array.isArray(u)) {
      return u.every(recur)
    }
    return Object.keys(u).every((key) => recur((u as Record<string, unknown>)[key]))
  }
}

const StringTree = new Declaration(
  [],
  () => (input, ast) =>
    isStringTree(input) ?
      Effect.succeed(input) :
      Effect.fail(new Issue.InvalidType(ast, Option.some(input))),
  {
    expected: "StringTree",
    toCodecStringTree: () => new Link(unknown, Transformation.passthrough())
  }
)

/** @internal */
export const unknownToStringTree = new Link(
  StringTree,
  Transformation.passthrough()
)
