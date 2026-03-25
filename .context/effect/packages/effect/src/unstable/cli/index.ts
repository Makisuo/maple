/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * @since 4.0.0
 */
export * as Argument from "./Argument.ts"

/**
 * @since 4.0.0
 */
export * as CliError from "./CliError.ts"

/**
 * @since 4.0.0
 */
export * as CliOutput from "./CliOutput.ts"

/**
 * @since 4.0.0
 */
export * as Command from "./Command.ts"

/**
 * @since 4.0.0
 */
export * as Completions from "./Completions.ts"

/**
 * @since 4.0.0
 */
export * as Flag from "./Flag.ts"

/**
 * @since 4.0.0
 */
export * as GlobalFlag from "./GlobalFlag.ts"

/**
 * @since 4.0.0
 */
export * as HelpDoc from "./HelpDoc.ts"

/**
 * @internal
 *
 * Param is the polymorphic implementation shared by Argument.ts and Flag.ts.
 * The `Kind` type parameter ("argument" | "flag") enables type-safe separation
 * while sharing parsing logic and combinators.
 *
 * Users should import from `Argument` and `Flag` modules, not this module directly.
 * This module is not exported from the public API.
 *
 * @since 4.0.0
 */
export * as Param from "./Param.ts"

/**
 * Primitive types for CLI parameter parsing.
 *
 * Primitives handle the low-level parsing of string input into typed values.
 * Most users should use the higher-level `Argument` and `Flag` modules instead.
 *
 * This module is primarily useful for:
 * - Creating custom primitive types
 * - Understanding how CLI parsing works internally
 * - Advanced customization of parsing behavior
 *
 * @since 4.0.0
 */
export * as Primitive from "./Primitive.ts"

/**
 * @since 4.0.0
 */
export * as Prompt from "./Prompt.ts"
