# Module Organization Patterns - Effect Library

## OVERVIEW

Established patterns for organizing modules in the Effect library, based on analysis of the core codebase structure and conventions.

## DIRECTORY STRUCTURE PATTERNS

### Core Module Organization

```
packages/effect/src/
├── encoding/             # Encoding utilities (Base64, Hex, etc.)
│   ├── Base64.ts
│   ├── Base64Url.ts
│   ├── EncodingError.ts
│   ├── Hex.ts
│   └── index.ts
├── internal/             # Private implementation details (~27 files)
│   ├── array.ts
│   ├── concurrency.ts
│   ├── core.ts
│   ├── effect.ts
│   ├── layer.ts
│   ├── schema/
│   └── ...
├── testing/              # Test utilities
│   ├── FastCheck.ts
│   ├── TestClock.ts
│   ├── TestConsole.ts
│   ├── TestSchema.ts
│   └── index.ts
├── unstable/             # Experimental features (17 subdirectories)
│   ├── ai/
│   ├── cli/
│   ├── cluster/
│   ├── http/
│   ├── httpapi/
│   ├── persistence/
│   ├── rpc/
│   ├── schema/
│   ├── sql/
│   ├── workers/
│   ├── workflow/
│   └── ...
├── index.ts              # Main export file
└── [module].ts           # 122+ top-level modules (flat structure)
```

### Flat Module Structure

The Effect library uses a **flat module structure** where core modules are top-level `.ts` files:

```
packages/effect/src/
├── Array.ts
├── BigDecimal.ts
├── Boolean.ts
├── Brand.ts
├── Cache.ts
├── Cause.ts
├── Channel.ts
├── Chunk.ts
├── Clock.ts
├── Config.ts
├── Console.ts
├── Data.ts
├── DateTime.ts
├── Deferred.ts
├── Duration.ts
├── Effect.ts
├── Equal.ts
├── Exit.ts
├── Fiber.ts
├── FiberSet.ts
├── FiberMap.ts
├── FileSystem.ts
├── Function.ts
├── Graph.ts
├── Hash.ts
├── HashMap.ts
├── HashSet.ts
├── HKT.ts
├── Layer.ts
├── Logger.ts
├── Option.ts
├── Pool.ts
├── Queue.ts
├── Ref.ts
├── Request.ts
├── Result.ts
├── Schedule.ts
├── Schema.ts
├── Scope.ts
├── Stream.ts
├── ...
```

### Export Pattern Structure

**Main index file pattern (packages/effect/src/index.ts):**

```typescript
/**
 * @since 2.0.0
 */

export {
  /**
   * @since 2.0.0
   */
  absurd,
  /**
   * @since 2.0.0
   */
  flow,
  /**
   * @since 2.0.0
   */
  identity,
  /**
   * @since 2.0.0
   */
  pipe
} from "./Function.ts"

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * This module provides utility functions for working with arrays in TypeScript.
 *
 * @since 2.0.0
 */
export * as Array from "./Array.ts"

/**
 * @since 2.0.0
 */
export * as BigDecimal from "./BigDecimal.ts"

/**
 * @since 2.0.0
 */
export * as Effect from "./Effect.ts"

// ... flat namespace exports for all modules
```

**Key observations:**

- Uses `.ts` extensions in imports (not `.js`)
- Flat namespace exports (`export * as ModuleName from "./Module.ts"`)
- No nested index files for collections/concurrency/etc.
- Barrel exports are auto-generated

## MODULE STRUCTURE PATTERNS

### Standard Module File Structure

```typescript
/**
 * Module description with @since version
 *
 * @since 2.0.0
 */

// Imports (organized by category) - use .ts extensions
import * as Cause from "./Cause.ts"
import * as Deferred from "./Deferred.ts"
import * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import type * as Inspectable from "./Inspectable.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import { type Pipeable } from "./Pipeable.ts"
import * as Predicate from "./Predicate.ts"
import type * as Scope from "./Scope.ts"

// TypeId - string literal pattern (NOT Symbol.for)
const TypeId = "~effect/ModuleName"

/**
 * @since 2.0.0
 * @category models
 */
export interface ModuleName<out A = unknown, out E = unknown> extends Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId
  // Interface members
}

// Type guard using Predicate.hasProperty
/**
 * @since 2.0.0
 * @category refinements
 */
export const isModuleName = (u: unknown): u is ModuleName<unknown, unknown> => Predicate.hasProperty(u, TypeId)

// Prototype pattern for implementation
const Proto = {
  [TypeId]: TypeId
  // ... implementation
}
```

### Internal Module Pattern

**Internal organization (packages/effect/src/internal/array.ts):**

```typescript
/** @internal */

import { identity } from "../Function.ts"
import { pipeArguments } from "../Pipeable.ts"

// Private implementation details
const ArrayProto = {
  pipe() {
    return pipeArguments(this, arguments)
  }
}

// Internal implementation functions
/** @internal */
export const make = <A>(...elements: ReadonlyArray<A>): Array<A> => {
  const arr = [...elements]
  Object.setPrototypeOf(arr, ArrayProto)
  return arr
}

/** @internal */
export const map = <A, B>(
  self: ReadonlyArray<A>,
  f: (a: A, i: number) => B
): Array<B> => {
  const result = new globalThis.Array(self.length)
  for (let i = 0; i < self.length; i++) {
    result[i] = f(self[i]!, i)
  }
  Object.setPrototypeOf(result, ArrayProto)
  return result
}
```

## NAMING CONVENTIONS

### Function Naming Patterns

```typescript
// Constructors - create new instances
export const make = <A>(value: A): Effect<A>
export const of = <A>(value: A): Effect<A>
export const empty = (): Effect<never>
export const fromIterable = <A>(iterable: Iterable<A>): Effect<A>

// Combinators - transform existing instances
export const map = dual<...>()
export const flatMap = dual<...>()
export const filter = dual<...>()
export const zip = dual<...>()

// Predicates - boolean-returning functions
export const isSome = <A>(option: Option<A>): boolean
export const isNone = <A>(option: Option<A>): boolean
export const isEffect = (value: unknown): value is Effect<unknown>

// Destructors - extract or convert values
export const getOrElse = dual<...>()
export const match = dual<...>()
export const toArray = <A>(chunk: Chunk<A>): ReadonlyArray<A>

// Utilities - helper functions
export const reverse = <A>(array: ReadonlyArray<A>): Array<A>
export const sort = dual<...>()
export const partition = dual<...>()
```

### Type Naming Patterns

```typescript
// Core types use PascalCase
export interface Effect<A, E = never, R = never>
export interface Option<A>
export interface Either<E, A>

// Type lambdas have TypeLambda suffix
export interface EffectTypeLambda extends TypeLambda
export interface OptionTypeLambda extends TypeLambda

// Non-empty variants use NonEmpty prefix
export type NonEmptyArray<A> = readonly [A, ...Array<A>]
export type NonEmptyString = string & { readonly NonEmptyString: unique symbol }

// Readonly variants
export type ReadonlyArray<A> = readonly A[]
export type ReadonlyRecord<K extends string | symbol, V> = { readonly [P in K]: V }
```

## DUAL FUNCTION PATTERN

### Standard Dual Implementation

````typescript
/**
 * Maps over a structure using the provided function.
 *
 * @example
 * ```ts
 * import { Array } from "effect"
 *
 * // Data-first usage
 * const result1 = Array.map([1, 2, 3], x => x * 2)
 *
 * // Data-last usage (pipeable)
 * const result2 = [1, 2, 3].pipe(
 *   Array.map(x => x * 2)
 * )
 * ```
 *
 * @since 2.0.0
 * @category combinators
 */
export const map = dual<
  <A, B>(f: (a: A, index: number) => B) => (self: ReadonlyArray<A>) => Array<B>,
  <A, B>(self: ReadonlyArray<A>, f: (a: A, index: number) => B) => Array<B>
>(2, (self, f) => self.map(f))
````

### Arity-Based Dual Pattern

```typescript
// When the number of parameters is fixed
export const filter = dual<
  <A, B extends A>(predicate: (a: A) => a is B) => (self: ReadonlyArray<A>) => Array<B>,
  <A, B extends A>(self: ReadonlyArray<A>, predicate: (a: A) => a is B) => Array<B>
>(2, internalArray.filter)

// When using predicate-based dual
export const update = dual<
  <A>(index: number, f: (a: A) => A) => (self: ReadonlyArray<A>) => Array<A>,
  <A>(self: ReadonlyArray<A>, index: number, f: (a: A) => A) => Array<A>
>((args) => Array.isArray(args[0]), internalArray.update)
```

## TYPE IDENTIFICATION PATTERN

### TypeId Pattern (String Literals)

The Effect library uses **string literal TypeIds** (NOT `Symbol.for`):

```typescript
/**
 * The type identifier for this data type.
 * Uses string literal format: "~effect/ModuleName"
 */
const TypeId = "~effect/ModuleName"

/**
 * @category symbols
 * @since 2.0.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 2.0.0
 */
export interface ModuleName<A> {
  readonly [TypeId]: typeof TypeId
  // other properties
}
```

### TypeId Naming Conventions

```typescript
// Standard module TypeId
const TypeId = "~effect/Queue"
const TypeId = "~effect/FiberSet"
const TypeId = "~effect/Pool"
const TypeId = "~effect/Ref"
const TypeId = "~effect/Deferred"

// Nested/namespaced TypeIds for related types
const TypeId = "~effect/Queue/Dequeue"
const FileTypeId = "~effect/platform/FileSystem/File"

// Domain-prefixed TypeIds
const TypeId = "~effect/collections/Chunk"
const TypeId = "~effect/data/Redacted"
const TypeId = "~effect/platform/FileSystem"
const TypeId = "~effect/platform/PlatformError"
const TypeId = "~effect/transactions/TxChunk"
const TypeId = "~effect/transactions/TxSemaphore"
const TypeId = "~effect/cluster/HashRing"

// Versioned TypeIds (for Effect core types)
export const EffectTypeId = `~effect/Effect/${version}` as const
export const ExitTypeId = `~effect/Exit/${version}` as const

// Interface symbols (for Equal, Hash, etc.)
export const symbol = "~effect/interfaces/Equal"
```

### Type Guard Pattern

````typescript
/**
 * Type guard to check if a value is an instance of ModuleName.
 *
 * @example
 * ```ts
 * import { Effect, FiberSet } from "effect"
 *
 * Effect.gen(function*() {
 *   const set = yield* FiberSet.make()
 *
 *   console.log(FiberSet.isFiberSet(set)) // true
 *   console.log(FiberSet.isFiberSet({})) // false
 * })
 * ```
 *
 * @category refinements
 * @since 2.0.0
 */
export const isModuleName = (u: unknown): u is ModuleName<unknown, unknown> => Predicate.hasProperty(u, TypeId)
````

## VARIANCE ANNOTATION PATTERN

### Interface Variance

```typescript
/**
 * Represents the variance of the type parameters.
 * - `in ROut`: Contravariant (input position)
 * - `out E`: Covariant (output position)
 * - `out RIn`: Covariant (output position)
 */
export interface Variance<in ROut, out E, out RIn> {
  readonly [TypeId]: {
    readonly _ROut: Types.Contravariant<ROut>
    readonly _E: Types.Covariant<E>
    readonly _RIn: Types.Covariant<RIn>
  }
}

export interface Layer<in ROut, out E = never, out RIn = never> extends Variance<ROut, E, RIn>, Pipeable {
  // Layer-specific methods
}
```

## PIPEABLE INTEGRATION PATTERN

### Pipeable Implementation

```typescript
import type * as Inspectable from "./Inspectable.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import { pipeArguments } from "./Pipeable.ts"
import type { Pipeable } from "./Pipeable.ts"

const TypeId = "~effect/ModuleName"

/**
 * @category models
 * @since 2.0.0
 */
export interface ModuleName<A> extends Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId
  // other properties
}

// Prototype pattern with pipe support
const Proto = {
  [TypeId]: TypeId,
  ...PipeInspectableProto
  // other methods
}

// Attach to prototype for pipe support
export const make = <A>(value: A): ModuleName<A> => {
  const instance = { value }
  Object.setPrototypeOf(instance, Proto)
  return instance as ModuleName<A>
}
```

## IMPORT CONVENTIONS

### File Extension Rules

**Always use `.ts` extensions in imports:**

```typescript
// CORRECT - use .ts extensions
import * as Array from "./Array.ts"
import * as Effect from "./Effect.ts"
import { dual } from "./Function.ts"
import { PipeInspectableProto } from "./internal/core.ts"
import type * as Scope from "./Scope.ts"

// WRONG - do NOT use .js extensions
// import * as Effect from "./Effect.js"
```

### Import Organization

```typescript
// 1. External imports (if any)

// 2. Effect module imports (alphabetical, .ts extension)
import * as Cause from "./Cause.ts"
import * as Deferred from "./Deferred.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import * as Fiber from "./Fiber.ts"

// 3. Utility imports
import { constVoid, dual } from "./Function.ts"
import { type Pipeable } from "./Pipeable.ts"
import * as Predicate from "./Predicate.ts"

// 4. Internal imports
import { PipeInspectableProto } from "./internal/core.ts"

// 5. Type-only imports
import type * as Inspectable from "./Inspectable.ts"
import type * as Scope from "./Scope.ts"
```

## SUCCESS CRITERIA

### Well-Organized Module Checklist

- [ ] Module placed at correct level (top-level for core, subdirectory for domain-specific)
- [ ] Uses `.ts` file extension in all imports
- [ ] TypeId uses string literal format (`"~effect/ModuleName"`)
- [ ] Proper internal vs public API separation
- [ ] Standard function naming conventions
- [ ] Dual function support for data-first/data-last usage
- [ ] Type guard using `Predicate.hasProperty`
- [ ] Variance annotations for type parameters
- [ ] Pipeable interface integration via prototype
- [ ] Comprehensive JSDoc with examples
- [ ] Version annotations (@since) on all exports

This module organization ensures consistency, discoverability, and maintainability across the entire Effect library codebase.
