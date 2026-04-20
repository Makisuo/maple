/**
 * This module provides utilities for making values inspectable and debuggable in TypeScript.
 *
 * The Inspectable interface provides a standard way to implement custom string representations
 * for objects, making them easier to debug and inspect. It includes support for JSON
 * serialization, Node.js inspection, and safe circular reference handling.
 *
 * The module also includes redaction capabilities for sensitive data, allowing objects
 * to provide different representations based on the current execution context.
 *
 * @example
 * ```ts
 * import { Inspectable } from "effect"
 * import { format } from "effect/Formatter"
 *
 * class User extends Inspectable.Class {
 *   constructor(
 *     public readonly name: string,
 *     public readonly email: string
 *   ) {
 *     super()
 *   }
 *
 *   toJSON() {
 *     return {
 *       _tag: "User",
 *       name: this.name,
 *       email: this.email
 *     }
 *   }
 * }
 *
 * const user = new User("Alice", "alice@example.com")
 * console.log(user.toString()) // Pretty printed JSON
 * console.log(format(user)) // Same as toString()
 * ```
 *
 * @since 2.0.0
 */
import { format } from "./Formatter.ts"
import * as Predicate from "./Predicate.ts"
import * as Redactable from "./Redactable.ts"
import { redact } from "./Redactable.ts"

/**
 * Symbol used by Node.js for custom object inspection.
 *
 * This symbol is recognized by Node.js's `util.inspect()` function and the REPL
 * for custom object representation. When an object has a method with this symbol,
 * it will be called to determine how the object should be displayed.
 *
 * @example
 * ```ts
 * import { Inspectable } from "effect"
 *
 * class CustomObject {
 *   constructor(private value: string) {}
 *
 *   [Inspectable.NodeInspectSymbol]() {
 *     return `CustomObject(${this.value})`
 *   }
 * }
 *
 * const obj = new CustomObject("hello")
 * console.log(obj) // Displays: CustomObject(hello)
 * ```
 *
 * @since 2.0.0
 * @category symbols
 */
export const NodeInspectSymbol = Symbol.for("nodejs.util.inspect.custom")

/**
 * The type of the Node.js inspection symbol used for custom object inspection.
 * This symbol type is used to implement custom inspection behavior in Node.js
 * environments.
 *
 * @example
 * ```ts
 * import { Inspectable } from "effect"
 *
 * class CustomObject {
 *   constructor(private value: string) {}
 *
 *   [Inspectable.NodeInspectSymbol]() {
 *     return `CustomObject(${this.value})`
 *   }
 * }
 *
 * const obj = new CustomObject("test")
 * console.log(obj) // CustomObject(test)
 * ```
 *
 * @since 2.0.0
 * @category symbols
 */
export type NodeInspectSymbol = typeof NodeInspectSymbol

/**
 * Interface for objects that can be inspected and provide custom string representations.
 *
 * Objects implementing this interface can control how they appear in debugging contexts,
 * JSON serialization, and Node.js inspection. This is particularly useful for creating
 * custom data types that display meaningful information during development.
 *
 * @example
 * ```ts
 * import { Inspectable } from "effect"
 * import { format } from "effect/Formatter"
 *
 * class Result implements Inspectable.Inspectable {
 *   constructor(
 *     private readonly tag: "Success" | "Failure",
 *     private readonly value: unknown
 *   ) {}
 *
 *   toString(): string {
 *     return format(this.toJSON())
 *   }
 *
 *   toJSON() {
 *     return { _tag: this.tag, value: this.value }
 *   }
 *
 *   [Inspectable.NodeInspectSymbol]() {
 *     return this.toJSON()
 *   }
 * }
 *
 * const success = new Result("Success", 42)
 * console.log(success.toString()) // Pretty formatted JSON
 * ```
 *
 * @since 2.0.0
 * @category models
 */
export interface Inspectable {
  toString(): string
  toJSON(): unknown
  [NodeInspectSymbol](): unknown
}

/**
 * Safely converts a value to a JSON-serializable representation, useful for
 * implementing the `toJSON` method of the {@link Inspectable} interface.
 *
 * This function attempts to extract JSON data from objects that implement the
 * `toJSON` method, recursively processes arrays, and handles errors gracefully.
 * For objects that don't have a `toJSON` method, it applies redaction to
 * protect sensitive information.
 *
 * @since 2.0.0
 */
export const toJson = (input: unknown): unknown => {
  try {
    if (
      Predicate.hasProperty(input, "toJSON") &&
      Predicate.isFunction(input["toJSON"]) &&
      input["toJSON"].length === 0
    ) {
      return input.toJSON()
    } else if (Array.isArray(input)) {
      return input.map(toJson)
    }
  } catch {
    return "[toJSON threw]"
  }
  return redact(input)
}

/**
 * @since 2.0.0
 */
export const toStringUnknown = (u: unknown, whitespace: number | string | undefined = 2): string => {
  if (typeof u === "string") {
    return u
  }
  try {
    return typeof u === "object" ? stringifyCircular(u, whitespace) : String(u)
  } catch {
    return String(u)
  }
}

/**
 * @since 2.0.0
 */
export const stringifyCircular = (obj: unknown, whitespace?: number | string | undefined): string => {
  let cache: Array<unknown> = []
  const retVal = JSON.stringify(
    obj,
    (_key, value) =>
      typeof value === "object" && value !== null
        ? cache.includes(value)
          ? undefined // circular reference
          : cache.push(value) && Redactable.redact(value)
        : value,
    whitespace
  )
  ;(cache as any) = undefined
  return retVal
}

/**
 * A base prototype object that implements the {@link Inspectable} interface.
 *
 * This object provides default implementations for the {@link Inspectable} methods.
 * It can be used as a prototype for objects that want to be inspectable,
 * or as a mixin to add inspection capabilities to existing objects.
 *
 * @example
 * ```ts
 * import { Inspectable } from "effect"
 *
 * // Use as prototype
 * const myObject = Object.create(Inspectable.BaseProto)
 * myObject.name = "example"
 * myObject.value = 42
 *
 * console.log(myObject.toString()) // Pretty printed representation
 *
 * // Or extend in a constructor
 * function MyClass(this: any, name: string) {
 *   this.name = name
 * }
 * MyClass.prototype = Object.create(Inspectable.BaseProto)
 * MyClass.prototype.constructor = MyClass
 * ```
 *
 * @since 2.0.0
 */
export const BaseProto: Inspectable = {
  toJSON() {
    return toJson(this)
  },
  [NodeInspectSymbol]() {
    return this.toJSON()
  },
  toString() {
    return format(this.toJSON())
  }
}

/**
 * Abstract base class that implements the Inspectable interface.
 *
 * This class provides a convenient way to create inspectable objects by extending it.
 * Subclasses only need to implement the `toJSON()` method, and they automatically
 * get proper `toString()` and Node.js inspection support.
 *
 * @example
 * ```ts
 * import { Inspectable } from "effect"
 *
 * class User extends Inspectable.Class {
 *   constructor(
 *     public readonly id: number,
 *     public readonly name: string,
 *     public readonly email: string
 *   ) {
 *     super()
 *   }
 *
 *   toJSON() {
 *     return {
 *       _tag: "User",
 *       id: this.id,
 *       name: this.name,
 *       email: this.email
 *     }
 *   }
 * }
 *
 * const user = new User(1, "Alice", "alice@example.com")
 * console.log(user.toString()) // Pretty printed JSON with _tag, id, name, email
 * console.log(user) // In Node.js, shows the same formatted output
 * ```
 *
 * @since 2.0.0
 * @category classes
 */
export abstract class Class {
  /**
   * Returns a JSON representation of this object.
   *
   * Subclasses must implement this method to define how the object
   * should be serialized for debugging and inspection purposes.
   *
   * @since 2.0.0
   */
  abstract toJSON(): unknown
  /**
   * Node.js custom inspection method.
   *
   * @since 2.0.0
   */
  [NodeInspectSymbol]() {
    return this.toJSON()
  }
  /**
   * Returns a formatted string representation of this object.
   *
   * @since 2.0.0
   */
  toString() {
    return format(this.toJSON())
  }
}
