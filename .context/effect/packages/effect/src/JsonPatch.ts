/**
 * JSON Patch operations for transforming JSON documents.
 *
 * This module implements a subset of RFC 6902, providing operations that can be applied deterministically without additional context. It supports computing structural diffs between JSON values and applying patches to transform documents.
 *
 * ## Mental model
 *
 * - **JSON Patch**: An ordered sequence of operations that transform a document from one state to another
 * - **JSON Pointer**: Path syntax for targeting specific locations in a JSON document (e.g., `/users/0/name`)
 * - **Operations**: Three types - `add` (insert value), `remove` (delete value), `replace` (update value)
 * - **Immutable transformations**: All operations return new values; inputs are never mutated
 * - **Sequential application**: Operations are applied in order, with later operations observing changes from earlier ones
 * - **Structural diff**: The `get` function computes differences by comparing structure, not content semantics
 *
 * ## Common tasks
 *
 * - Computing diffs between JSON values → {@link get}
 * - Applying patches to transform documents → {@link apply}
 * - Creating patches manually → {@link JsonPatchOperation}
 * - Storing and validating patch documents → {@link JsonPatch}
 *
 * ## Gotchas
 *
 * - Array removals are emitted from highest index to lowest to avoid index shifting during application
 * - Root operations use an empty string path `""` to target the entire document
 * - Array append operations use `-` as the last token in the path (e.g., `/items/-`)
 * - Generated patches are deterministic but not guaranteed to be minimal
 * - Empty patches return the original document reference (no allocation)
 * - Invalid paths or operations throw errors rather than returning a result type
 *
 * ## Quickstart
 *
 * **Example** (Computing and applying a patch)
 *
 * ```ts
 * import * as JsonPatch from "effect/JsonPatch"
 *
 * const oldValue = { name: "Alice", age: 30 }
 * const newValue = { name: "Alice", age: 31, city: "NYC" }
 *
 * const patch = JsonPatch.get(oldValue, newValue)
 * // [{ op: "replace", path: "/age", value: 31 }, { op: "add", path: "/city", value: "NYC" }]
 *
 * const result = JsonPatch.apply(patch, oldValue)
 * // { name: "Alice", age: 31, city: "NYC" }
 * ```
 *
 * ## See also
 *
 * - {@link JsonPointer} - Utilities for working with JSON Pointer paths
 * - {@link Schema.Json} - The JSON value type used by this module
 *
 * @since 4.0.0
 */
import { format } from "./Formatter.ts"
import { escapeToken, unescapeToken } from "./JsonPointer.ts"
import * as Predicate from "./Predicate.ts"
import type * as Schema from "./Schema.ts"

/**
 * A single JSON Patch operation.
 *
 * Represents one transformation step in a JSON Patch document. This is a subset of RFC 6902, restricted to operations that can be applied deterministically without additional context.
 *
 * ## When to use this
 *
 * - Defining patch operation types in your code
 * - Manually constructing patch operations
 * - Type-checking patch operation structures
 *
 * ## Behavior
 *
 * - All fields are readonly; operations are immutable value objects
 * - Paths use JSON Pointer syntax; empty string `""` refers to the root document
 * - The `description` field is optional and can be used for documentation
 * - Operations are discriminated unions based on the `op` field
 *
 * **Example** (All operation types)
 *
 * ```ts
 * import * as JsonPatch from "effect/JsonPatch"
 *
 * const addOp: JsonPatch.JsonPatchOperation = {
 *   op: "add",
 *   path: "/users/-",
 *   value: { id: 1, name: "Alice" }
 * }
 *
 * const removeOp: JsonPatch.JsonPatchOperation = {
 *   op: "remove",
 *   path: "/users/0"
 * }
 *
 * const replaceOp: JsonPatch.JsonPatchOperation = {
 *   op: "replace",
 *   path: "/users/0/name",
 *   value: "Bob"
 * }
 * ```
 *
 * ## See also
 *
 * - {@link JsonPatch} - Array of operations forming a complete patch
 * - {@link get} - Computes operations automatically from value differences
 * - {@link apply} - Applies operations to transform documents
 *
 * @category Model
 * @since 4.0.0
 */
export type JsonPatchOperation =
  | {
    readonly op: "add"
    /**
     * JSON Pointer to the target location.
     *
     * For arrays, the last token may be `-` to append.
     */
    readonly path: string
    readonly value: Schema.Json
    readonly description?: string
  }
  | {
    readonly op: "remove"
    /** JSON Pointer to the target location. */
    readonly path: string
    readonly description?: string
  }
  | {
    readonly op: "replace"
    /** JSON Pointer to the target location. Use `""` to replace the root document. */
    readonly path: string
    readonly value: Schema.Json
    readonly description?: string
  }

/**
 * A JSON Patch document (an ordered list of operations).
 *
 * Represents a complete transformation as a sequence of operations. Operations are applied in order, and later operations observe the changes made by earlier ones.
 *
 * ## When to use this
 *
 * - Storing or serializing patch documents
 * - Passing patches between functions or systems
 * - Type-checking patch arrays
 * - Validating patch structure
 *
 * ## Behavior
 *
 * - Operations are applied sequentially from first to last
 * - Empty arrays represent no-op patches (return original document)
 * - Later operations see the document state after earlier operations
 * - The array is readonly; individual operations are immutable
 *
 * **Example** (Multi-operation patch)
 *
 * ```ts
 * import * as JsonPatch from "effect/JsonPatch"
 *
 * const patch: JsonPatch.JsonPatch = [
 *   { op: "add", path: "/items/-", value: "apple" },
 *   { op: "replace", path: "/count", value: 5 },
 *   { op: "remove", path: "/oldField" }
 * ]
 *
 * const result = JsonPatch.apply(patch, { count: 3, oldField: "value" })
 * // { count: 5, items: ["apple"] }
 * ```
 *
 * ## See also
 *
 * - {@link JsonPatchOperation} - Individual operation types
 * - {@link get} - Generates patches from value differences
 * - {@link apply} - Executes patches to transform documents
 *
 * @category Model
 * @since 4.0.0
 */
export type JsonPatch = ReadonlyArray<JsonPatchOperation>

/**
 * Compute a patch that transforms `oldValue` into `newValue`.
 *
 * Generates a structural diff between two JSON values, producing a patch that when applied to `oldValue` yields `newValue`.
 *
 * ## When to use this
 *
 * - Computing differences between JSON documents
 * - Detecting changes in data structures
 * - Generating patches for synchronization or version control
 * - Creating minimal update operations from before/after states
 *
 * ## Behavior
 *
 * - Returns an empty array if values are identical (same reference or deep equal)
 * - Does not mutate inputs; returns a new patch array
 * - Primitives (numbers, strings, booleans, null) result in a root `replace` operation
 * - Arrays are compared by index position; no move or copy detection
 * - Objects are compared by key; keys processed in sorted order for stable output
 * - Array removals emitted from highest to lowest index to prevent index shifting
 * - Output is deterministic but not guaranteed to be minimal
 * - Nested structures are recursively diffed
 *
 * **Example** (Computing object diff)
 *
 * ```ts
 * import * as JsonPatch from "effect/JsonPatch"
 *
 * const oldValue = { users: [{ id: 1, name: "Alice" }], count: 1 }
 * const newValue = { users: [{ id: 1, name: "Bob" }, { id: 2, name: "Charlie" }], count: 2 }
 *
 * const patch = JsonPatch.get(oldValue, newValue)
 * // [
 * //   { op: "replace", path: "/users/0/name", value: "Bob" },
 * //   { op: "add", path: "/users/1", value: { id: 2, name: "Charlie" } },
 * //   { op: "replace", path: "/count", value: 2 }
 * // ]
 * ```
 *
 * ## See also
 *
 * - {@link apply} - Applies the generated patch to a document
 * - {@link JsonPatchOperation} - The operation types in the patch
 *
 * @since 4.0.0
 */
export function get(oldValue: Schema.Json, newValue: Schema.Json): JsonPatch {
  if (Object.is(oldValue, newValue)) return []
  const patches: Array<JsonPatchOperation> = []

  if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    const len1 = oldValue.length
    const len2 = newValue.length

    // Compare shared prefix by index
    const shared = Math.min(len1, len2)
    for (let i = 0; i < shared; i++) {
      const path = `/${i}`
      const patch = get(oldValue[i], newValue[i])
      for (const op of patch) {
        prefixPathInPlace(op, path)
        patches.push(op)
      }
    }

    // Remove from end to start so later indices do not shift.
    for (let i = len1 - 1; i >= len2; i--) {
      patches.push({ op: "remove", path: `/${i}` })
    }

    // Add from beginning to end.
    for (let i = len1; i < len2; i++) {
      patches.push({ op: "add", path: `/${i}`, value: newValue[i] })
    }

    return patches
  }

  if (isJsonObject(oldValue) && isJsonObject(newValue)) {
    const keys1 = Object.keys(oldValue)
    const keys2 = Object.keys(newValue)
    const allKeys = Array.from(new Set([...keys1, ...keys2])).sort()

    for (const key of allKeys) {
      const esc = escapeToken(key)
      const path = `/${esc}`
      const hasKey1 = Object.hasOwn(oldValue, key)
      const hasKey2 = Object.hasOwn(newValue, key)

      if (hasKey1 && hasKey2) {
        const patch = get(oldValue[key], newValue[key])
        for (const op of patch) {
          prefixPathInPlace(op, path)
          patches.push(op)
        }
      } else if (!hasKey1 && hasKey2) {
        patches.push({ op: "add", path, value: newValue[key] })
      } else if (hasKey1 && !hasKey2) {
        patches.push({ op: "remove", path })
      }
    }

    return patches
  }

  patches.push({ op: "replace", path: "", value: newValue })
  return patches
}

/**
 * Apply a JSON Patch to a document.
 *
 * Executes a sequence of patch operations on a JSON document, returning a new document with all transformations applied.
 *
 * ## When to use this
 *
 * - Applying patches generated by {@link get}
 * - Transforming documents with manually constructed patches
 * - Implementing patch-based update mechanisms
 * - Processing patch operations from external sources
 *
 * ## Behavior
 *
 * - Never mutates the input document; returns a new value
 * - Returns the original reference if patch is empty (no allocation)
 * - Operations applied sequentially; later operations see earlier changes
 * - Root replace (`path: ""`) returns the provided value directly
 * - Throws errors for invalid paths, missing properties, or out-of-bounds array indices
 * - Array operations preserve immutability by copying affected arrays
 * - Object operations preserve immutability by copying affected objects
 *
 * **Example** (Applying a patch)
 *
 * ```ts
 * import * as JsonPatch from "effect/JsonPatch"
 *
 * const document = { items: [1, 2, 3], total: 6 }
 * const patch: JsonPatch.JsonPatch = [
 *   { op: "add", path: "/items/-", value: 4 },
 *   { op: "replace", path: "/total", value: 10 }
 * ]
 *
 * const result = JsonPatch.apply(patch, document)
 * // { items: [1, 2, 3, 4], total: 10 }
 * ```
 *
 * ## See also
 *
 * - {@link get} - Generates patches from value differences
 * - {@link JsonPatchOperation} - The operation types being applied
 *
 * @since 4.0.0
 */
export function apply(patch: JsonPatch, oldValue: Schema.Json): Schema.Json {
  let doc = oldValue

  for (const op of patch) {
    switch (op.op) {
      case "replace": {
        doc = op.path === "" ? op.value : setAt(doc, op.path, op.value, "replace")
        break
      }
      case "add": {
        doc = addAt(doc, op.path, op.value)
        break
      }
      case "remove": {
        doc = setAt(doc, op.path, undefined, "remove")
        break
      }
    }
  }

  return doc
}

// Mutates op.path in place for perf; safe because child ops are freshly created and not shared.
function prefixPathInPlace(op: JsonPatchOperation, parent: string): void {
  ;(op as any).path = op.path === "" ? parent : parent + op.path
}

function isJsonObject(value: unknown): value is Schema.JsonObject {
  return Predicate.isObject(value)
}

/**
 * Tokenize a JSON Pointer into unescaped reference tokens.
 *
 * - `""` (empty pointer) refers to the root and returns `[]`
 * - Non-empty pointers must start with `/`
 */
function tokenize(pointer: string): Array<string> {
  if (pointer === "") return []
  if (pointer.charCodeAt(0) !== 47 /* "/" */) {
    throw new Error(`Invalid JSON Pointer, it must start with "/": ${format(pointer)}`)
  }
  return pointer.split("/").slice(1).map(unescapeToken)
}

/** Convert a reference token to a non-negative array index (rejects `-` and negatives). */
function toIndex(token: string): number {
  if (!/^(0|[1-9]\d*)$/.test(token)) {
    throw new Error(`Invalid array index: "${token}"`)
  }
  return Number(token)
}

function addAt(doc: Schema.Json, pointer: string, val: Schema.Json): Schema.Json {
  if (pointer === "") return val

  const resolved = resolveParent(doc, pointer)
  if (resolved === null) {
    throw new Error(`Cannot add at "${pointer}" (parent not found or not a container).`)
  }

  const { lastToken, parent, stack } = resolved

  if (Array.isArray(parent)) {
    const idx = lastToken === "-" ? parent.length : toIndex(lastToken)
    if (idx < 0 || idx > parent.length) throw new Error(`Array index out of bounds at "${pointer}".`)
    const updated = parent.slice()
    updated.splice(idx, 0, val)
    return rebuildFromStack(stack, updated)
  }

  if (isJsonObject(parent)) {
    const updated = { ...parent }
    updated[lastToken] = val
    return rebuildFromStack(stack, updated)
  }

  throw new Error(`Cannot add at "${pointer}" (parent not found or not a container).`)
}

function setAt(
  doc: Schema.Json,
  pointer: string,
  val: Schema.Json | undefined,
  mode: "replace" | "remove"
): Schema.Json {
  if (pointer === "") {
    if (mode === "remove" || val === undefined) throw new Error("Unsupported operation at the root")
    return val
  }

  const resolved = resolveParent(doc, pointer)
  if (resolved === null) {
    throw new Error(`Cannot ${mode} at "${pointer}" (parent not found or not a container).`)
  }

  const { lastToken, parent, stack } = resolved

  if (Array.isArray(parent)) {
    if (lastToken === "-") throw new Error(`"-" is not valid for ${mode} at "${pointer}".`)
    const idx = toIndex(lastToken)
    if (idx < 0 || idx >= parent.length) throw new Error(`Array index out of bounds at "${pointer}".`)
    const updated = parent.slice()
    if (mode === "remove") updated.splice(idx, 1)
    else updated[idx] = val
    return rebuildFromStack(stack, updated)
  }

  if (isJsonObject(parent)) {
    if (!Object.hasOwn(parent, lastToken)) {
      throw new Error(`Property "${lastToken}" does not exist at "${pointer}".`)
    }
    const updated = { ...parent }
    if (mode === "remove") delete updated[lastToken]
    else updated[lastToken] = val!
    return rebuildFromStack(stack, updated)
  }

  throw new Error(`Cannot ${mode} at "${pointer}" (parent not found or not a container).`)
}

type StackEntry = { readonly container: unknown; readonly token: number | string }

// Walk to the parent of `pointer`, recording the path.
// Returns null if the parent path cannot be resolved.
function resolveParent(
  doc: Schema.Json,
  pointer: string
): { readonly stack: ReadonlyArray<StackEntry>; readonly parent: unknown; readonly lastToken: string } | null {
  const tokens = tokenize(pointer)
  if (tokens.length === 0) return null // caller handles root

  const lastToken = tokens[tokens.length - 1]
  const stack: Array<StackEntry> = []
  let cur: unknown = doc

  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]

    if (cur == null) return null

    if (Array.isArray(cur)) {
      const idx = toIndex(token)
      if (idx < 0 || idx >= cur.length) return null
      stack.push({ container: cur, token: idx })
      cur = cur[idx]
      continue
    }

    if (cur && typeof cur === "object") {
      if (!Object.hasOwn(cur, token)) return null
      stack.push({ container: cur, token })
      cur = (cur as any)[token]
      continue
    }

    return null
  }

  return { stack, parent: cur, lastToken }
}

// Rebuild the document by writing `newParent` back through `stack`.
function rebuildFromStack(stack: ReadonlyArray<StackEntry>, newParent: Schema.Json): Schema.Json {
  let acc: Schema.Json = newParent

  for (let i = stack.length - 1; i >= 0; i--) {
    const { container, token } = stack[i]

    if (Array.isArray(container)) {
      const copy = container.slice()
      copy[token as number] = acc
      acc = copy
    } else {
      const copy = { ...(container as Schema.JsonObject) }
      copy[token as string] = acc
      acc = copy
    }
  }

  return acc
}
