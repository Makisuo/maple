/**
 * Utilities for converting arbitrary JavaScript values into human-readable
 * strings, with support for circular references, redaction, and common JS
 * types that `JSON.stringify` handles poorly.
 *
 * Mental model:
 * - A `Formatter<Value, Format>` is a callable `(value: Value) => Format`.
 * - {@link format} is the general-purpose pretty-printer: it handles
 *   primitives, arrays, objects, `BigInt`, `Symbol`, `Date`, `RegExp`,
 *   `Set`, `Map`, class instances, and circular references.
 * - {@link formatJson} is a safe `JSON.stringify` wrapper that silently
 *   drops circular references and applies redaction.
 * - Both functions accept a `space` option for indentation control.
 *
 * Common tasks:
 * - Pretty-print any value for debugging / logging -> {@link format}
 * - Serialize to JSON safely (no circular throws) -> {@link formatJson}
 * - Format a single object property key -> {@link formatPropertyKey}
 * - Format a property path like `["a"]["b"]` -> {@link formatPath}
 * - Format a `Date` to ISO string safely -> {@link formatDate}
 *
 * Gotchas:
 * - {@link format} output is **not** valid JSON; use {@link formatJson} when
 *   you need parseable JSON.
 * - {@link format} calls `toString()` on objects by default; pass
 *   `ignoreToString: true` to disable.
 * - {@link formatJson} silently omits circular references (the key is
 *   dropped from the output).
 * - Values implementing the `Redactable` protocol are automatically
 *   redacted by both {@link format} and {@link formatJson}.
 *
 * **Example** (Pretty-print a value)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * const obj = { name: "Alice", scores: [100, 97] }
 * console.log(Formatter.format(obj))
 * // {"name":"Alice","scores":[100,97]}
 *
 * console.log(Formatter.format(obj, { space: 2 }))
 * // {
 * //   "name": "Alice",
 * //   "scores": [
 * //     100,
 * //     97
 * //   ]
 * // }
 * ```
 *
 * See also: {@link Formatter}, {@link format}, {@link formatJson}
 *
 * @since 4.0.0
 */
import * as Predicate from "./Predicate.ts"
import { getRedacted, redact, symbolRedactable } from "./Redactable.ts"

/**
 * A callable interface representing a function that converts a `Value` into a
 * `Format` (defaults to `string`).
 *
 * When to use:
 * - You want to type a formatting / rendering function generically.
 * - You are building a pipeline that accepts pluggable formatters.
 *
 * Behavior:
 * - Pure callable type; carries no runtime implementation.
 * - Contravariant in `Value`, covariant in `Format`.
 *
 * **Example** (Define a custom formatter)
 *
 * ```ts
 * import type { Formatter } from "effect"
 *
 * const upper: Formatter.Formatter<string> = (s) => s.toUpperCase()
 *
 * console.log(upper("hello"))
 * // HELLO
 * ```
 *
 * See also: {@link format}, {@link formatJson}
 *
 * @category Model
 * @since 4.0.0
 */
export interface Formatter<in Value, out Format = string> {
  (value: Value): Format
}

/**
 * Converts any JavaScript value into a human-readable string.
 *
 * When to use:
 * - Pretty-printing values for debugging, logging, or error messages.
 * - You need to handle `BigInt`, `Symbol`, `Set`, `Map`, `Date`, `RegExp`,
 *   or class instances that `JSON.stringify` cannot represent.
 * - You want circular references shown as `"[Circular]"` instead of
 *   throwing.
 *
 * Behavior:
 * - Does not mutate input.
 * - Output is **not** valid JSON; use {@link formatJson} when you need
 *   parseable JSON.
 * - Primitives: stringified naturally (`null`, `undefined`, `123`, `true`).
 *   Strings are JSON-quoted.
 * - Objects with a custom `toString` (not `Object.prototype.toString`):
 *   `toString()` is called unless `ignoreToString` is `true`.
 * - Errors with a `cause`: formatted as `"<message> (cause: <cause>)"`.
 * - Iterables (`Set`, `Map`, etc.): formatted as
 *   `ClassName([...elements])`.
 * - Class instances: wrapped as `ClassName({...})`.
 * - `Redactable` values are automatically redacted.
 * - Arrays/objects with 0–1 entries are inline; larger ones are
 *   pretty-printed when `space` is set.
 * - Circular references are replaced with `"[Circular]"`.
 *
 * Options:
 * - `space` — indentation unit (number of spaces, or a string like
 *   `"\t"`). Defaults to `0` (compact).
 * - `ignoreToString` — skip calling `toString()`. Defaults to `false`.
 *
 * **Example** (Compact output)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * console.log(Formatter.format({ a: 1, b: [2, 3] }))
 * // {"a":1,"b":[2,3]}
 * ```
 *
 * **Example** (Pretty-printed output)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * console.log(Formatter.format({ a: 1, b: [2, 3] }, { space: 2 }))
 * // {
 * //   "a": 1,
 * //   "b": [
 * //     2,
 * //     3
 * //   ]
 * // }
 * ```
 *
 * **Example** (Circular reference handling)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * const obj: any = { name: "loop" }
 * obj.self = obj
 * console.log(Formatter.format(obj))
 * // {"name":"loop","self":[Circular]}
 * ```
 *
 * See also: {@link formatJson}, {@link Formatter}
 *
 * @since 4.0.0
 */
export function format(input: unknown, options?: {
  readonly space?: number | string | undefined
  readonly ignoreToString?: boolean | undefined
}): string {
  const space = options?.space ?? 0
  const seen = new WeakSet<object>()
  const gap = !space ? "" : (typeof space === "number" ? " ".repeat(space) : space)
  const ind = (d: number) => gap.repeat(d)

  const wrap = (v: unknown, body: string): string => {
    const ctor = (v as any)?.constructor
    return ctor && ctor !== Object.prototype.constructor && ctor.name ? `${ctor.name}(${body})` : body
  }

  const ownKeys = (o: object): Array<PropertyKey> => {
    try {
      return Reflect.ownKeys(o)
    } catch {
      return ["[ownKeys threw]"]
    }
  }

  function recur(v: unknown, d = 0): string {
    if (Array.isArray(v)) {
      if (seen.has(v)) return CIRCULAR
      seen.add(v)
      if (!gap || v.length <= 1) return `[${v.map((x) => recur(x, d)).join(",")}]`
      const inner = v.map((x) => recur(x, d + 1)).join(",\n" + ind(d + 1))
      return `[\n${ind(d + 1)}${inner}\n${ind(d)}]`
    }

    if (v instanceof Date) return formatDate(v)

    if (
      !options?.ignoreToString &&
      Predicate.hasProperty(v, "toString") &&
      typeof v["toString"] === "function" &&
      v["toString"] !== Object.prototype.toString &&
      v["toString"] !== Array.prototype.toString
    ) {
      const s = safeToString(v)
      if (v instanceof Error && v.cause) {
        return `${s} (cause: ${recur(v.cause, d)})`
      }
      return s
    }

    if (typeof v === "string") return JSON.stringify(v)

    if (
      typeof v === "number" ||
      v == null ||
      typeof v === "boolean" ||
      typeof v === "symbol"
    ) return String(v)

    if (typeof v === "bigint") return String(v) + "n"

    if (typeof v === "object" || typeof v === "function") {
      if (seen.has(v)) return CIRCULAR
      seen.add(v)

      if (symbolRedactable in v) return format(getRedacted(v as any))

      if (Symbol.iterator in v) {
        return `${v.constructor.name}(${recur(Array.from(v as any), d)})`
      }

      const keys = ownKeys(v)
      if (!gap || keys.length <= 1) {
        const body = `{${keys.map((k) => `${formatPropertyKey(k)}:${recur((v as any)[k], d)}`).join(",")}}`
        return wrap(v, body)
      }
      const body = `{\n${
        keys.map((k) => `${ind(d + 1)}${formatPropertyKey(k)}: ${recur((v as any)[k], d + 1)}`).join(",\n")
      }\n${ind(d)}}`
      return wrap(v, body)
    }

    return String(v)
  }

  return recur(input, 0)
}

const CIRCULAR = "[Circular]"

/**
 * Formats a single property key for display.
 *
 * When to use:
 * - You are building a custom formatter that needs to render object keys.
 *
 * Behavior:
 * - String keys are JSON-quoted (e.g. `"foo"`).
 * - Symbol and number keys are converted with `String()`.
 * - Pure function; does not mutate input.
 *
 * **Example** (Format property keys)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * console.log(Formatter.formatPropertyKey("name"))
 * // "name"
 *
 * console.log(Formatter.formatPropertyKey(Symbol.for("id")))
 * // Symbol(id)
 * ```
 *
 * See also: {@link formatPath}, {@link format}
 *
 * @internal
 */
export function formatPropertyKey(name: PropertyKey): string {
  return typeof name === "string" ? JSON.stringify(name) : String(name)
}

/**
 * Formats an array of property keys as a bracket-notation path string.
 *
 * When to use:
 * - You need to display a path through a nested object (e.g. in error
 *   messages or schema validation output).
 *
 * Behavior:
 * - Each key is wrapped in brackets and formatted via
 *   {@link formatPropertyKey}.
 * - Returns an empty string for an empty path.
 * - Pure function; does not mutate input.
 *
 * **Example** (Render a property path)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * console.log(Formatter.formatPath(["users", 0, "name"]))
 * // ["users"][0]["name"]
 * ```
 *
 * See also: {@link formatPropertyKey}, {@link format}
 *
 * @internal
 */
export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((key) => `[${formatPropertyKey(key)}]`).join("")
}

/**
 * Formats a `Date` as an ISO 8601 string, returning `"Invalid Date"` for
 * invalid dates instead of throwing.
 *
 * When to use:
 * - You want a safe `toISOString()` that never throws.
 *
 * Behavior:
 * - Returns `date.toISOString()` on success.
 * - Returns `"Invalid Date"` if `toISOString()` throws (e.g. for
 *   `new Date(NaN)`).
 * - Pure function; does not mutate input.
 *
 * **Example** (Safe date formatting)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * console.log(Formatter.formatDate(new Date("2024-01-15T10:30:00Z")))
 * // 2024-01-15T10:30:00.000Z
 *
 * console.log(Formatter.formatDate(new Date("invalid")))
 * // Invalid Date
 * ```
 *
 * See also: {@link format}
 *
 * @internal
 */
export function formatDate(date: Date): string {
  try {
    return date.toISOString()
  } catch {
    return "Invalid Date"
  }
}

function safeToString(input: any): string {
  try {
    const s = input.toString()
    return typeof s === "string" ? s : String(s)
  } catch {
    return "[toString threw]"
  }
}

/**
 * Safely stringifies a value to JSON, silently dropping circular references.
 *
 * When to use:
 * - You need valid JSON output (unlike {@link format}).
 * - The input may contain circular references and you want them silently
 *   omitted rather than throwing a `TypeError`.
 *
 * Behavior:
 * - Does not mutate input.
 * - Uses `JSON.stringify` internally with a replacer that tracks seen
 *   objects.
 * - Circular references are replaced with `undefined` (omitted from
 *   output).
 * - `Redactable` values are automatically redacted before serialization.
 * - Types not supported by JSON (`BigInt`, `Symbol`, `undefined`,
 *   functions) follow standard `JSON.stringify` behavior (omitted or
 *   `null` in arrays).
 *
 * Options:
 * - `space` — indentation unit (number of spaces, or a string like
 *   `"\t"`). Defaults to `0` (compact).
 *
 * **Example** (Compact JSON)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * console.log(Formatter.formatJson({ name: "Alice", age: 30 }))
 * // {"name":"Alice","age":30}
 * ```
 *
 * **Example** (Circular reference handling)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * const obj: any = { name: "test" }
 * obj.self = obj
 * console.log(Formatter.formatJson(obj))
 * // {"name":"test"}
 * ```
 *
 * **Example** (Pretty-printed JSON)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * console.log(Formatter.formatJson({ name: "Alice", age: 30 }, { space: 2 }))
 * // {
 * //   "name": "Alice",
 * //   "age": 30
 * // }
 * ```
 *
 * See also: {@link format}, {@link Formatter}
 *
 * @since 4.0.0
 */
export function formatJson(input: unknown, options?: {
  readonly space?: number | string | undefined
}): string {
  let cache: Array<unknown> = []
  const out = JSON.stringify(
    input,
    (_key, value) =>
      typeof value === "object" && value !== null
        ? cache.includes(value)
          ? undefined // circular reference
          : cache.push(value) && redact(value)
        : value,
    options?.space
  )
  ;(cache as any) = undefined
  return out
}
