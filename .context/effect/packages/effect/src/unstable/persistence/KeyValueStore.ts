/**
 * @since 4.0.0
 */
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as Encoding from "../../Encoding.ts"
import * as FileSystem from "../../FileSystem.ts"
import { dual, identity, type LazyArg } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import * as Path from "../../Path.ts"
import type { PlatformError } from "../../PlatformError.ts"
import * as Predicate from "../../Predicate.ts"
import * as Result from "../../Result.ts"
import * as Schema from "../../Schema.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as UndefinedOr from "../../UndefinedOr.ts"

const TypeId = "~effect/persistence/KeyValueStore" as const

/**
 * @since 4.0.0
 * @category Models
 */
export interface KeyValueStore {
  readonly [TypeId]: typeof TypeId
  /**
   * Returns the value of the specified key if it exists.
   */
  readonly get: (key: string) => Effect.Effect<string | undefined, KeyValueStoreError>

  /**
   * Returns the value of the specified key if it exists.
   */
  readonly getUint8Array: (key: string) => Effect.Effect<Uint8Array | undefined, KeyValueStoreError>

  /**
   * Sets the value of the specified key.
   */
  readonly set: (key: string, value: string | Uint8Array) => Effect.Effect<void, KeyValueStoreError>

  /**
   * Removes the specified key.
   */
  readonly remove: (key: string) => Effect.Effect<void, KeyValueStoreError>

  /**
   * Removes all entries.
   */
  readonly clear: Effect.Effect<void, KeyValueStoreError>

  /**
   * Returns the number of entries.
   */
  readonly size: Effect.Effect<number, KeyValueStoreError>

  /**
   * Updates the value of the specified key if it exists.
   */
  readonly modify: (
    key: string,
    f: (value: string) => string
  ) => Effect.Effect<string | undefined, KeyValueStoreError>

  /**
   * Updates the value of the specified key if it exists.
   */
  readonly modifyUint8Array: (
    key: string,
    f: (value: Uint8Array) => Uint8Array
  ) => Effect.Effect<Uint8Array | undefined, KeyValueStoreError>

  /**
   * Returns true if the KeyValueStore contains the specified key.
   */
  readonly has: (key: string) => Effect.Effect<boolean, KeyValueStoreError>

  /**
   * Checks if the KeyValueStore contains any entries.
   */
  readonly isEmpty: Effect.Effect<boolean, KeyValueStoreError>
}

/**
 * @since 4.0.0
 * @category Models
 */
export type MakeOptions = Partial<KeyValueStore> & {
  /**
   * Returns the value of the specified key if it exists.
   */
  readonly get: (key: string) => Effect.Effect<string | undefined, KeyValueStoreError>

  /**
   * Returns the value of the specified key if it exists.
   */
  readonly getUint8Array: (key: string) => Effect.Effect<Uint8Array | undefined, KeyValueStoreError>

  /**
   * Sets the value of the specified key.
   */
  readonly set: (key: string, value: string | Uint8Array) => Effect.Effect<void, KeyValueStoreError>

  /**
   * Removes the specified key.
   */
  readonly remove: (key: string) => Effect.Effect<void, KeyValueStoreError>

  /**
   * Removes all entries.
   */
  readonly clear: Effect.Effect<void, KeyValueStoreError>

  /**
   * Returns the number of entries.
   */
  readonly size: Effect.Effect<number, KeyValueStoreError>
}

/**
 * @since 4.0.0
 * @category Models
 */
export type MakeStringOptions = Partial<Omit<KeyValueStore, "set">> & {
  /**
   * Returns the value of the specified key if it exists.
   */
  readonly get: (key: string) => Effect.Effect<string | undefined, KeyValueStoreError>

  /**
   * Sets the value of the specified key.
   */
  readonly set: (key: string, value: string) => Effect.Effect<void, KeyValueStoreError>

  /**
   * Removes the specified key.
   */
  readonly remove: (key: string) => Effect.Effect<void, KeyValueStoreError>

  /**
   * Removes all entries.
   */
  readonly clear: Effect.Effect<void, KeyValueStoreError>

  /**
   * Returns the number of entries.
   */
  readonly size: Effect.Effect<number, KeyValueStoreError>
}

const ErrorTypeId = "~effect/persistence/KeyValueStore/KeyValueStoreError" as const

/**
 * @since 4.0.0
 * @category Errors
 */
export class KeyValueStoreError extends Data.TaggedError("KeyValueStoreError")<{
  message: string
  method: string
  key?: string
  cause?: unknown
}> {
  /**
   * @since 4.0.0
   */
  readonly [ErrorTypeId]: typeof ErrorTypeId = ErrorTypeId
}

/**
 * @since 4.0.0
 * @category tags
 */
export const KeyValueStore: ServiceMap.Service<
  KeyValueStore,
  KeyValueStore
> = ServiceMap.Service("effect/persistence/KeyValueStore")

/**
 * @since 4.0.0
 * @category constructors
 */
export const make = (options: MakeOptions): KeyValueStore =>
  KeyValueStore.of({
    [TypeId]: TypeId,
    has: (key) => Effect.map(options.get(key), Predicate.isNotUndefined),
    isEmpty: Effect.map(options.size, (size) => size === 0),
    modify: (key, f) =>
      Effect.flatMap(
        options.get(key),
        (o) => {
          if (o === undefined) {
            return Effect.undefined
          }
          const newValue = f(o)
          return Effect.as(
            options.set(key, newValue),
            newValue
          )
        }
      ),
    modifyUint8Array: (key, f) =>
      Effect.flatMap(
        options.getUint8Array(key),
        (o) => {
          if (o === undefined) {
            return Effect.undefined
          }
          const newValue = f(o)
          return Effect.as(options.set(key, newValue), newValue)
        }
      ),
    ...options
  })

/**
 * @since 4.0.0
 * @category constructors
 */
export const makeStringOnly = (
  options: MakeStringOptions
): KeyValueStore => {
  const encoder = new TextEncoder()
  return make({
    ...options,
    getUint8Array: (key) =>
      options.get(key).pipe(
        Effect.map(UndefinedOr.map((value) =>
          Result.match(Encoding.decodeBase64(value), {
            onFailure: () => encoder.encode(value),
            onSuccess: identity
          })
        ))
      ),
    set: (key, value) =>
      typeof value === "string"
        ? options.set(key, value)
        : Effect.suspend(() => options.set(key, Encoding.encodeBase64(value)))
  })
}

/**
 * @since 4.0.0
 * @category combinators
 */
export const prefix: {
  (prefix: string): (self: KeyValueStore) => KeyValueStore
  (self: KeyValueStore, prefix: string): KeyValueStore
} = dual(2, (self: KeyValueStore, prefix: string): KeyValueStore => ({
  ...self,
  get: (key) => self.get(`${prefix}${key}`),
  getUint8Array: (key) => self.getUint8Array(`${prefix}${key}`),
  set: (key, value) => self.set(`${prefix}${key}`, value),
  remove: (key) => self.remove(`${prefix}${key}`),
  has: (key) => self.has(`${prefix}${key}`),
  modify: (key, f) => self.modify(`${prefix}${key}`, f),
  modifyUint8Array: (key, f) => self.modifyUint8Array(`${prefix}${key}`, f)
}))

/**
 * @since 4.0.0
 * @category layers
 */
export const layerMemory: Layer.Layer<KeyValueStore> = Layer.sync(KeyValueStore)(() => {
  const store = new Map<string, string | Uint8Array>()
  const encoder = new TextEncoder()

  return make({
    get: (key: string) =>
      Effect.sync(() => {
        const value = store.get(key)
        return value === undefined ? undefined : typeof value === "string" ? value : Encoding.encodeBase64(value)
      }),
    getUint8Array: (key: string) =>
      Effect.sync(() => {
        const value = store.get(key)
        return value === undefined ? undefined : typeof value === "string" ? encoder.encode(value) : value
      }),
    set: (key: string, value: string | Uint8Array) => Effect.sync(() => store.set(key, value)),
    remove: (key: string) => Effect.sync(() => store.delete(key)),
    clear: Effect.sync(() => store.clear()),
    size: Effect.sync(() => store.size)
  })
})

/**
 * @since 4.0.0
 * @category layers
 */
export const layerFileSystem = (
  directory: string
): Layer.Layer<KeyValueStore, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(KeyValueStore)(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const keyPath = (key: string) => path.join(directory, encodeURIComponent(key))

    if (!(yield* fs.exists(directory))) {
      yield* fs.makeDirectory(directory, { recursive: true })
    }

    return make({
      get: (key: string) =>
        Effect.catchTag(
          fs.readFileString(keyPath(key)),
          "PlatformError",
          (cause) =>
            cause.reason._tag === "NotFound" ? Effect.undefined : Effect.fail(
              new KeyValueStoreError({
                method: "get",
                key,
                message: `Unable to get item with key ${key}`,
                cause
              })
            )
        ),
      getUint8Array: (key: string) =>
        Effect.catchTag(
          fs.readFile(keyPath(key)),
          "PlatformError",
          (cause) =>
            cause.reason._tag === "NotFound" ? Effect.undefined : Effect.fail(
              new KeyValueStoreError({
                method: "getUint8Array",
                key,
                message: `Unable to get item with key ${key}`,
                cause
              })
            )
        ),
      set: (key: string, value: string | Uint8Array) =>
        Effect.mapError(
          typeof value === "string" ? fs.writeFileString(keyPath(key), value) : fs.writeFile(keyPath(key), value),
          (cause) =>
            new KeyValueStoreError({
              method: "set",
              key,
              message: `Unable to set item with key ${key}`,
              cause
            })
        ),
      remove: (key: string) =>
        Effect.mapError(fs.remove(keyPath(key)), (cause) =>
          new KeyValueStoreError({
            method: "remove",
            key,
            message: `Unable to remove item with key ${key}`,
            cause
          })),
      has: (key: string) =>
        Effect.mapError(fs.exists(keyPath(key)), (cause) =>
          new KeyValueStoreError({
            method: "has",
            key,
            message: `Unable to check existence of item with key ${key}`,
            cause
          })),
      clear: Effect.mapError(
        Effect.andThen(
          fs.remove(directory, { recursive: true }),
          fs.makeDirectory(directory, { recursive: true })
        ),
        (cause) =>
          new KeyValueStoreError({
            method: "clear",
            message: `Unable to clear storage`,
            cause
          })
      ),
      size: Effect.matchEffect(
        fs.readDirectory(directory),
        {
          onSuccess: (files) => Effect.succeed(files.length),
          onFailure: (cause) =>
            Effect.fail(
              new KeyValueStoreError({
                method: "size",
                message: `Unable to get size`,
                cause
              })
            )
        }
      )
    })
  }))

const SchemaStoreTypeId = "~effect/persistence/KeyValueStore/SchemaStore" as const

/**
 * @since 4.0.0
 * @category SchemaStore
 */
export interface SchemaStore<S extends Schema.Top> {
  readonly [SchemaStoreTypeId]: typeof SchemaStoreTypeId
  /**
   * Returns the value of the specified key if it exists.
   */
  readonly get: (
    key: string
  ) => Effect.Effect<Option.Option<S["Type"]>, KeyValueStoreError | Schema.SchemaError, S["DecodingServices"]>

  /**
   * Sets the value of the specified key.
   */
  readonly set: (
    key: string,
    value: S["Type"]
  ) => Effect.Effect<void, KeyValueStoreError | Schema.SchemaError, S["EncodingServices"]>

  /**
   * Removes the specified key.
   */
  readonly remove: (key: string) => Effect.Effect<void, KeyValueStoreError>

  /**
   * Removes all entries.
   */
  readonly clear: Effect.Effect<void, KeyValueStoreError>

  /**
   * Returns the number of entries.
   */
  readonly size: Effect.Effect<number, KeyValueStoreError>

  /**
   * Updates the value of the specified key if it exists.
   */
  readonly modify: (
    key: string,
    f: (value: S["Type"]) => S["Type"]
  ) => Effect.Effect<
    Option.Option<S["Type"]>,
    KeyValueStoreError | Schema.SchemaError,
    S["DecodingServices"] | S["EncodingServices"]
  >

  /**
   * Returns true if the KeyValueStore contains the specified key.
   */
  readonly has: (key: string) => Effect.Effect<boolean, KeyValueStoreError>

  /**
   * Checks if the KeyValueStore contains any entries.
   */
  readonly isEmpty: Effect.Effect<boolean, KeyValueStoreError>
}

/**
 * @since 4.0.0
 * @category SchemaStore
 */
export const toSchemaStore = <S extends Schema.Top>(self: KeyValueStore, schema: S): SchemaStore<S> => {
  const serializer = Schema.toCodecJson(schema)
  const jsonSchema = Schema.fromJsonString(serializer)
  const decode = Schema.decodeEffect(jsonSchema)
  const encode = Schema.encodeEffect(jsonSchema)

  const get = (key: string) =>
    Effect.flatMap(
      self.get(key),
      UndefinedOr.match({
        onUndefined: () => Effect.succeedNone,
        onDefined: (value) => Effect.asSome(decode(value))
      })
    )

  const set = (key: string, value: S["Type"]) => Effect.flatMap(encode(value), (json) => self.set(key, json))

  const modify = (key: string, f: (value: S["Type"]) => S["Type"]) =>
    Effect.flatMap(
      get(key),
      (o) => {
        if (Option.isNone(o)) {
          return Effect.succeedNone
        }
        const newValue = f(o.value)
        return Effect.as(
          set(key, newValue),
          Option.some(newValue)
        )
      }
    )

  return {
    [SchemaStoreTypeId]: SchemaStoreTypeId,
    get,
    set,
    modify,
    remove: self.remove,
    clear: self.clear,
    size: self.size,
    has: self.has,
    isEmpty: self.isEmpty
  }
}

/**
 * Creates an KeyValueStorage from an instance of the `Storage` api.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API
 *
 * @since 4.0.0
 * @category layers
 */
export const layerStorage = (
  evaluate: LazyArg<Storage>
): Layer.Layer<KeyValueStore> =>
  Layer.sync(KeyValueStore)(() => {
    const storage = evaluate()
    return makeStringOnly({
      get: (key: string) =>
        Effect.try({
          try: () => storage.getItem(key) ?? undefined,
          catch: () =>
            new KeyValueStoreError({
              key,
              method: "get",
              message: `Unable to get item with key ${key}`
            })
        }),

      set: (key: string, value: string) =>
        Effect.try({
          try: () => storage.setItem(key, value),
          catch: () =>
            new KeyValueStoreError({
              key,
              method: "set",
              message: `Unable to set item with key ${key}`
            })
        }),

      remove: (key: string) =>
        Effect.try({
          try: () => storage.removeItem(key),
          catch: () =>
            new KeyValueStoreError({
              key,
              method: "remove",
              message: `Unable to remove item with key ${key}`
            })
        }),

      clear: Effect.try({
        try: () => storage.clear(),
        catch: () =>
          new KeyValueStoreError({
            method: "clear",
            message: `Unable to clear storage`
          })
      }),

      size: Effect.try({
        try: () => storage.length,
        catch: () =>
          new KeyValueStoreError({
            method: "size",
            message: `Unable to get size`
          })
      })
    })
  })
