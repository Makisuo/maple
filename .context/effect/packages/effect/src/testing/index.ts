/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * This module provides a re-export of the fast-check library for property-based testing.
 * Fast-check is a property-based testing framework that generates random test cases
 * to validate that properties hold true for a wide range of inputs.
 *
 * Property-based testing is a testing methodology where you specify properties that
 * should hold true for your functions, and the framework generates many random test
 * cases to try to find counterexamples.
 *
 * @since 3.10.0
 */
export * as FastCheck from "./FastCheck.ts"

/**
 * @since 2.0.0
 */
export * as TestClock from "./TestClock.ts"

/**
 * @since 4.0.0
 */
export * as TestConsole from "./TestConsole.ts"

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
export * as TestSchema from "./TestSchema.ts"
