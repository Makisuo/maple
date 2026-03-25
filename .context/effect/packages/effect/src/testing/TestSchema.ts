/**
 * Testing utilities for asserting Schema decoding, encoding, make, and
 * arbitrary-generation behavior. Used in unit tests to verify that schemas
 * accept, reject, and round-trip values correctly.
 *
 * ## Mental model
 *
 * - **Asserts** – entry point: wraps a schema and exposes helpers grouped by
 *   operation (decoding, encoding, make, arbitrary, round-trip).
 * - **Decoding** – returned by `asserts.decoding()`; has `succeed` / `fail`
 *   helpers that run the schema's decoder and compare the result.
 * - **Encoding** – returned by `asserts.encoding()`; mirrors {@link Decoding}
 *   but exercises the encoder direction.
 * - Every assertion is async (`Promise<void>`) because parsing may involve
 *   effectful schemas.
 * - `succeed` with one argument asserts identity (output equals input);
 *   with two arguments asserts a specific expected output.
 * - `fail` always takes the input and the expected error message string.
 *
 * ## Common tasks
 *
 * - Assert decoding succeeds / fails → `new Asserts(schema).decoding().succeed(…)` / `.fail(…)`
 * - Assert encoding succeeds / fails → `new Asserts(schema).encoding().succeed(…)` / `.fail(…)`
 * - Assert make succeeds / fails → `new Asserts(schema).make().succeed(…)` / `.fail(…)`
 * - Verify round-trip (encode then decode) → `new Asserts(schema).verifyLosslessTransformation()`
 * - Verify arbitrary generation → `new Asserts(schema).arbitrary().verifyGeneration()`
 * - Compare AST of struct fields → `Asserts.ast.fields.equals(a, b)`
 * - Provide a service dependency for decoding → `asserts.decoding().provide(key, impl)`
 *
 * ## Gotchas
 *
 * - `succeed` uses `assert.deepStrictEqual`, so reference equality is not
 *   required but structural equality is.
 * - `fail` compares against the stringified `Issue`, not the `Issue` object
 *   itself. Pass the exact multiline string the issue produces.
 * - `verifyLosslessTransformation` and `arbitrary().verifyGeneration` run
 *   property-based tests via FastCheck; default run count is 20 for
 *   `verifyGeneration`.
 *
 * ## Quickstart
 *
 * **Example** (Basic decoding and encoding assertions)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { TestSchema } from "effect/testing"
 *
 * const schema = Schema.NumberFromString
 * const asserts = new TestSchema.Asserts(schema)
 *
 * // decoding
 * const decoding = asserts.decoding()
 * await decoding.succeed("1", 1)
 * await decoding.fail(null, "Expected string, got null")
 *
 * // encoding
 * const encoding = asserts.encoding()
 * await encoding.succeed(1, "1")
 * ```
 *
 * ## See also
 *
 * - {@link Asserts}
 * - {@link Decoding}
 * - {@link Encoding}
 *
 * @since 4.0.0
 */
import * as assert from "node:assert"
import * as Effect from "../Effect.ts"
import * as Record from "../Record.ts"
import * as Result from "../Result.ts"
import * as Schema from "../Schema.ts"
import * as AST from "../SchemaAST.ts"
import type * as Issue from "../SchemaIssue.ts"
import * as Parser from "../SchemaParser.ts"
import type * as ServiceMap from "../ServiceMap.ts"
import * as FastCheck from "../testing/FastCheck.ts"

/**
 * Entry point for schema test assertions. Wraps a schema and exposes
 * operation-specific helpers: {@link Decoding}, {@link Encoding}, make,
 * arbitrary generation, and round-trip verification.
 *
 * When to use:
 * - You are writing unit tests for a schema's decoding, encoding, or
 *   construction behavior.
 * - You want property-based round-trip or generation checks.
 *
 * **Example** (Decoding and encoding a struct)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { TestSchema } from "effect/testing"
 *
 * const schema = Schema.Struct({ name: Schema.String })
 * const asserts = new TestSchema.Asserts(schema)
 *
 * // decoding
 * await asserts.decoding().succeed({ name: "Alice" })
 *
 * // encoding
 * await asserts.encoding().succeed({ name: "Alice" })
 * ```
 *
 * @see {@link Decoding}
 * @see {@link Encoding}
 *
 * @since 4.0.0
 */
export class Asserts<S extends Schema.Top> {
  /**
   * Static helpers for comparing schema AST structures. Useful when you need
   * to assert that two field or element definitions produce the same AST.
   *
   * - `ast.fields.equals(a, b)` – compares struct field ASTs via
   *   `assert.deepStrictEqual`.
   * - `ast.elements.equals(a, b)` – compares tuple element ASTs via
   *   `assert.deepStrictEqual`.
   *
   * **Example** (Comparing struct fields)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const fieldsA = { name: Schema.String }
   * const fieldsB = { name: Schema.String }
   * TestSchema.Asserts.ast.fields.equals(fieldsA, fieldsB) // no error
   * ```
   */
  static ast = {
    fields: {
      equals: (a: Schema.Struct.Fields, b: Schema.Struct.Fields) => {
        assert.deepStrictEqual(Record.map(a, AST.getAST), Record.map(b, AST.getAST))
      }
    },
    elements: {
      equals: (a: Schema.Tuple.Elements, b: Schema.Tuple.Elements) => {
        assert.deepStrictEqual(a.map(AST.getAST), b.map(AST.getAST))
      }
    }
  } as const

  readonly schema: S
  constructor(schema: S) {
    this.schema = schema
  }
  /**
   * Returns an object with `succeed` and `fail` helpers for testing the
   * schema's `make` operation.
   *
   * - `succeed(input)` – asserts make returns the input unchanged.
   * - `succeed(input, expected)` – asserts make returns `expected`.
   * - `fail(input, message)` – asserts make fails with `message`.
   *
   * **Example** (Testing make)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const schema = Schema.String
   * const asserts = new TestSchema.Asserts(schema)
   * await asserts.make().succeed("hello")
   * ```
   */
  make(options?: Schema.MakeOptions) {
    const makeEffect = Parser.makeEffect(this.schema)
    async function succeed(input: S["Type"]): Promise<void>
    async function succeed(input: S["~type.make.in"], expected: S["Type"]): Promise<void>
    async function succeed(input: S["~type.make.in"], expected?: S["Type"]) {
      const r = await Effect.runPromise(
        makeEffect(input, options).pipe(
          Effect.mapError((issue) => issue.toString()),
          Effect.result
        )
      )
      expected = arguments.length === 1 ? input : expected
      assert.deepStrictEqual(r, Result.succeed(expected))
    }
    return {
      succeed,
      async fail(input: unknown, message: string) {
        const r = await Effect.runPromise(
          makeEffect(input, options).pipe(
            Effect.mapError((issue) => issue.toString()),
            Effect.result
          )
        )
        assert.deepStrictEqual(r, Result.fail(message))
      }
    }
  }
  /**
   * Runs a property-based test that encodes arbitrary values and then decodes
   * them, asserting the decoded value equals the original. Useful for verifying
   * that a codec is lossless (encode followed by decode is identity).
   *
   * - Uses FastCheck to generate arbitrary values matching the schema's Type.
   * - Fails the test if any generated value does not round-trip.
   * - Pass `options.params` to control FastCheck parameters (e.g. `numRuns`).
   *
   * **Example** (Round-trip verification)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const asserts = new TestSchema.Asserts(Schema.NumberFromString)
   * await asserts.verifyLosslessTransformation()
   * ```
   */
  verifyLosslessTransformation<S extends Schema.Codec<unknown, unknown>>(this: Asserts<S>, options?: {
    readonly params?: FastCheck.Parameters<[S["Type"]]>
  }) {
    const decodeUnknownEffect = Parser.decodeUnknownEffect(this.schema)
    const encodeEffect = Parser.encodeEffect(this.schema)
    const arbitrary = Schema.toArbitrary(this.schema)
    return FastCheck.assert(
      FastCheck.asyncProperty(arbitrary, async (t) => {
        const r = await Effect.runPromise(
          encodeEffect(t).pipe(
            Effect.flatMap((e) => decodeUnknownEffect(e)),
            Effect.mapError((issue) => issue.toString()),
            Effect.result
          )
        )
        assert.deepStrictEqual(r, Result.succeed(t))
      }),
      options?.params
    )
  }
  /**
   * Returns a {@link Decoding} instance for this schema, providing `succeed`
   * and `fail` helpers to test decoding behavior.
   *
   * - Pass `parseOptions` to control error reporting (e.g. `{ errors: "all" }`).
   *
   * **Example** (Decoding assertions)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const asserts = new TestSchema.Asserts(Schema.NumberFromString)
   * const decoding = asserts.decoding()
   * await decoding.succeed("42", 42)
   * await decoding.fail(null, "Expected string, got null")
   * ```
   *
   * @see {@link Decoding}
   */
  decoding(options?: {
    readonly parseOptions?: AST.ParseOptions | undefined
  }) {
    return new Decoding(this.schema, options)
  }
  /**
   * Returns an {@link Encoding} instance for this schema, providing `succeed`
   * and `fail` helpers to test encoding behavior.
   *
   * - Pass `parseOptions` to control error reporting (e.g. `{ errors: "all" }`).
   *
   * **Example** (Encoding assertions)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const asserts = new TestSchema.Asserts(Schema.NumberFromString)
   * const encoding = asserts.encoding()
   * await encoding.succeed(42, "42")
   * ```
   *
   * @see {@link Encoding}
   */
  encoding(options?: {
    readonly parseOptions?: AST.ParseOptions | undefined
  }) {
    return new Encoding(this.schema, options)
  }
  /**
   * Returns an object with property-based testing helpers for the schema's
   * arbitrary generator.
   *
   * - `verifyGeneration()` – generates arbitrary values and asserts each
   *   satisfies the schema's `is` predicate. Defaults to 20 runs.
   * - Pass `options.params` to override FastCheck parameters.
   *
   * **Example** (Verifying arbitrary generation)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const asserts = new TestSchema.Asserts(Schema.String)
   * asserts.arbitrary().verifyGeneration()
   * ```
   */
  arbitrary<S extends Schema.Codec<unknown, unknown, never, unknown>>(this: Asserts<S>) {
    const schema = this.schema
    return {
      verifyGeneration(options?: {
        readonly params?: FastCheck.Parameters<[S["Type"]]> | undefined
      }) {
        const params = options?.params
        const is = Schema.is(schema)
        const arb = Schema.toArbitrary(schema)
        FastCheck.assert(FastCheck.property(arb, (a) => is(a)), { numRuns: 20, ...params })
      }
    }
  }
}

/**
 * Decoding test helper. Wraps a schema and exposes `succeed` and `fail`
 * methods that run the schema's decoder and compare the result.
 *
 * When to use:
 * - You want to assert that specific inputs decode to expected values.
 * - You want to assert that invalid inputs produce specific error messages.
 * - You need to provide services required by the schema's decoding pipeline.
 *
 * Behavior:
 * - All assertions are async and use `assert.deepStrictEqual` internally.
 * - `succeed(input)` asserts the decoded output equals `input` (identity).
 * - `succeed(input, expected)` asserts the decoded output equals `expected`.
 * - `fail(input, message)` asserts decoding fails and the stringified issue
 *   equals `message`.
 * - `provide(key, impl)` returns a new `Decoding` with the service injected
 *   into the decoding context.
 *
 * **Example** (Decoding with service provision)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { TestSchema } from "effect/testing"
 *
 * const asserts = new TestSchema.Asserts(Schema.String)
 * const decoding = asserts.decoding()
 * await decoding.succeed("hello")
 * ```
 *
 * @see {@link Asserts}
 * @see {@link Encoding}
 *
 * @since 4.0.0
 */
export class Decoding<S extends Schema.Top> {
  readonly schema: S
  readonly decodeUnknownEffect: (
    input: unknown,
    options?: AST.ParseOptions
  ) => Effect.Effect<S["Type"], Issue.Issue, S["DecodingServices"]>
  readonly options?: {
    readonly parseOptions?: AST.ParseOptions | undefined
  } | undefined
  constructor(schema: S, options?: {
    readonly parseOptions?: AST.ParseOptions | undefined
  }) {
    this.schema = schema
    this.decodeUnknownEffect = Parser.decodeUnknownEffect(schema)
    this.options = options
  }
  /**
   * Asserts that decoding `input` succeeds. With one argument, asserts the
   * output equals the input. With two arguments, asserts the output equals
   * `expected`.
   *
   * **Example** (Identity and transformed decoding)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const decoding = new TestSchema.Asserts(Schema.NumberFromString).decoding()
   * await decoding.succeed("1", 1) // transformed
   * ```
   */
  async succeed<S extends Schema.Decoder<unknown, never>>(
    this: Decoding<S>,
    input: unknown
  ): Promise<void>
  async succeed<S extends Schema.Decoder<unknown, never>>(
    this: Decoding<S>,
    input: unknown,
    expected: S["Type"]
  ): Promise<void>
  async succeed<S extends Schema.Decoder<unknown, never>>(
    this: Decoding<S>,
    input: unknown,
    expected?: S["Type"]
  ) {
    const r = await Effect.runPromise(
      this.decodeUnknownEffect(input, this.options?.parseOptions).pipe(
        Effect.mapError((issue) => issue.toString()),
        Effect.result
      )
    )
    expected = arguments.length === 1 ? input : expected
    assert.deepStrictEqual(r, Result.succeed(expected))
  }
  /**
   * Asserts that decoding `input` fails and the stringified issue equals
   * `message`.
   *
   * **Example** (Asserting a decoding failure)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const decoding = new TestSchema.Asserts(Schema.String).decoding()
   * await decoding.fail(42, "Expected string, got 42")
   * ```
   */
  async fail<S extends Schema.Decoder<unknown, never>>(
    this: Decoding<S>,
    input: unknown,
    message: string
  ) {
    const r = await Effect.runPromise(
      this.decodeUnknownEffect(input, this.options?.parseOptions).pipe(
        Effect.mapError((issue) => issue.toString()),
        Effect.result
      )
    )
    assert.deepStrictEqual(r, Result.fail(message))
  }
  /**
   * Returns a new {@link Decoding} instance with the given service injected
   * into the decoding effect context. Use this when the schema's decoder
   * requires a service dependency.
   *
   * - Does not mutate the current instance; returns a new one.
   *
   * @see {@link Encoding.provide}
   */
  provide<Id, Service>(
    service: ServiceMap.Key<Id, Service>,
    implementation: Service
  ): Decoding<Schema.middlewareDecoding<S, Exclude<S["DecodingServices"], Id>>> {
    return new Decoding(
      this.schema.pipe(Schema.middlewareDecoding(Effect.provideService(service, implementation))),
      this.options
    )
  }
}

/**
 * Encoding test helper. Mirrors {@link Decoding} but exercises the schema's
 * encoder direction.
 *
 * When to use:
 * - You want to assert that specific values encode to expected outputs.
 * - You want to assert that invalid inputs produce specific error messages
 *   during encoding.
 * - You need to provide services required by the schema's encoding pipeline.
 *
 * Behavior:
 * - All assertions are async and use `assert.deepStrictEqual` internally.
 * - `succeed(input)` asserts the encoded output equals `input` (identity).
 * - `succeed(input, expected)` asserts the encoded output equals `expected`.
 * - `fail(input, message)` asserts encoding fails and the stringified issue
 *   equals `message`.
 * - `provide(key, impl)` returns a new `Encoding` with the service injected
 *   into the encoding context.
 *
 * **Example** (Encoding assertions)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { TestSchema } from "effect/testing"
 *
 * const encoding = new TestSchema.Asserts(Schema.NumberFromString).encoding()
 * await encoding.succeed(42, "42")
 * ```
 *
 * @see {@link Asserts}
 * @see {@link Decoding}
 *
 * @since 4.0.0
 */
class Encoding<S extends Schema.Top> {
  readonly schema: S
  readonly encodeUnknownEffect: (
    input: unknown,
    options?: AST.ParseOptions
  ) => Effect.Effect<S["Type"], Issue.Issue, S["EncodingServices"]>
  readonly options?: {
    readonly parseOptions?: AST.ParseOptions | undefined
  } | undefined
  constructor(schema: S, options?: {
    readonly parseOptions?: AST.ParseOptions | undefined
  }) {
    this.schema = schema
    this.encodeUnknownEffect = Parser.encodeUnknownEffect(schema)
    this.options = options
  }
  /**
   * Asserts that encoding `input` succeeds. With one argument, asserts the
   * output equals the input. With two arguments, asserts the output equals
   * `expected`.
   *
   * **Example** (Identity and transformed encoding)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const encoding = new TestSchema.Asserts(Schema.NumberFromString).encoding()
   * await encoding.succeed(1, "1") // transformed
   * ```
   */
  async succeed<S extends Schema.Encoder<unknown, never>>(
    this: Encoding<S>,
    input: unknown
  ): Promise<void>
  async succeed<S extends Schema.Encoder<unknown, never>>(
    this: Encoding<S>,
    input: unknown,
    expected: S["Encoded"]
  ): Promise<void>
  async succeed<S extends Schema.Encoder<unknown, never>>(
    this: Encoding<S>,
    input: unknown,
    expected?: S["Encoded"]
  ) {
    const r = await Effect.runPromise(
      this.encodeUnknownEffect(input, this.options?.parseOptions).pipe(
        Effect.mapError((issue) => issue.toString()),
        Effect.result
      )
    )
    expected = arguments.length === 1 ? input : expected
    assert.deepStrictEqual(r, Result.succeed(expected))
  }
  /**
   * Asserts that encoding `input` fails and the stringified issue equals
   * `message`.
   *
   * **Example** (Asserting an encoding failure)
   *
   * ```ts
   * import { Schema } from "effect"
   * import { TestSchema } from "effect/testing"
   *
   * const encoding = new TestSchema.Asserts(Schema.NumberFromString).encoding()
   * await encoding.fail("not-a-number", "Expected number, got \"not-a-number\"")
   * ```
   */
  async fail<S extends Schema.Encoder<unknown, never>>(
    this: Encoding<S>,
    input: unknown,
    message: string
  ) {
    const r = await Effect.runPromise(
      this.encodeUnknownEffect(input, this.options?.parseOptions).pipe(
        Effect.mapError((issue) => issue.toString()),
        Effect.result
      )
    )
    assert.deepStrictEqual(r, Result.fail(message))
  }
  /**
   * Returns a new {@link Encoding} instance with the given service injected
   * into the encoding effect context. Use this when the schema's encoder
   * requires a service dependency.
   *
   * - Does not mutate the current instance; returns a new one.
   *
   * @see {@link Decoding.provide}
   */
  provide<Id, Service>(
    service: ServiceMap.Key<Id, Service>,
    implementation: Service
  ): Encoding<Schema.middlewareEncoding<S, Exclude<S["EncodingServices"], Id>>> {
    return new Encoding(
      this.schema.pipe(Schema.middlewareEncoding(Effect.provideService(service, implementation))),
      this.options
    )
  }
}
