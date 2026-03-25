/**
 * @since 1.0.0
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ServiceMap from "effect/ServiceMap"

const TypeId = "~@effect/platform-browser/Clipboard"
const ErrorTypeId = "~@effect/platform-browser/Clipboard/ClipboardError"

/**
 * @since 1.0.0
 * @category Models
 */
export interface Clipboard {
  readonly [TypeId]: typeof TypeId
  readonly read: Effect.Effect<ClipboardItems, ClipboardError>
  readonly readString: Effect.Effect<string, ClipboardError>
  readonly write: (items: ClipboardItems) => Effect.Effect<void, ClipboardError>
  readonly writeString: (text: string) => Effect.Effect<void, ClipboardError>
  readonly writeBlob: (blob: Blob) => Effect.Effect<void, ClipboardError>
  readonly clear: Effect.Effect<void, ClipboardError>
}

/**
 * @since 1.0.0
 * @category Errors
 */
export class ClipboardError extends Data.TaggedError("ClipboardError")<{
  readonly message: string
  readonly cause: unknown
}> {
  readonly [ErrorTypeId] = ErrorTypeId
}

/**
 * @since 1.0.0
 * @category Service
 */
export const Clipboard: ServiceMap.Service<Clipboard, Clipboard> = ServiceMap.Service<Clipboard>(TypeId)

/**
 * @since 1.0.0
 * @category Constructors
 */
export const make = (
  impl: Omit<Clipboard, "clear" | "writeBlob" | typeof TypeId>
): Clipboard =>
  Clipboard.of({
    ...impl,
    [TypeId]: TypeId,
    clear: impl.writeString(""),
    writeBlob: (blob: Blob) => impl.write([new ClipboardItem({ [blob.type]: blob })])
  })

/**
 * A layer that directly interfaces with the navigator.clipboard api
 *
 * @since 1.0.0
 * @category Layers
 */
export const layer: Layer.Layer<Clipboard> = Layer.succeed(
  Clipboard,
  make({
    read: Effect.tryPromise({
      try: () => navigator.clipboard.read(),
      catch: (cause) =>
        new ClipboardError({
          cause,
          "message": "Unable to read from clipboard"
        })
    }),
    write: (s: Array<ClipboardItem>) =>
      Effect.tryPromise({
        try: () => navigator.clipboard.write(s),
        catch: (cause) =>
          new ClipboardError({
            cause,
            "message": "Unable to write to clipboard"
          })
      }),
    readString: Effect.tryPromise({
      try: () => navigator.clipboard.readText(),
      catch: (cause) =>
        new ClipboardError({
          cause,
          "message": "Unable to read a string from clipboard"
        })
    }),
    writeString: (text: string) =>
      Effect.tryPromise({
        try: () => navigator.clipboard.writeText(text),
        catch: (cause) =>
          new ClipboardError({
            cause,
            "message": "Unable to write a string to clipboard"
          })
      })
  })
)
