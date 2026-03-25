/**
 * @since 1.0.0
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ServiceMap from "effect/ServiceMap"

const TypeId = "~@effect/platform-browser/Permissions"
const ErrorTypeId = "~@effect/platform-browser/Permissions/PermissionsError"

/**
 * Wrapper on the Permission API (`navigator.permissions`) with methods for
 * querying status of permissions.
 *
 * @since 1.0.0
 * @category Models
 */
export interface Permissions {
  readonly [TypeId]: typeof TypeId

  /**
   * Returns the state of a user permission on the global scope.
   */
  readonly query: <Name extends PermissionName>(
    name: Name
  ) => Effect.Effect<
    // `name` is identical to the name passed to Permissions.query
    // https://developer.mozilla.org/en-US/docs/Web/API/PermissionStatus
    Omit<PermissionStatus, "name"> & { name: Name },
    PermissionsError
  >
}

/**
 * @since 1.0.0
 * @category errors
 */
export class PermissionsInvalidStateError extends Data.TaggedError("InvalidStateError")<{
  readonly cause: unknown
}> {
  override get message(): string {
    return this._tag
  }
}

/**
 * @since 1.0.0
 * @category errors
 */
export class PermissionsTypeError extends Data.TaggedError("TypeError")<{
  readonly cause: unknown
}> {
  override get message(): string {
    return this._tag
  }
}

/**
 * @since 1.0.0
 * @category errors
 */
export type PermissionsErrorReason = PermissionsInvalidStateError | PermissionsTypeError

/**
 * @since 1.0.0
 * @category errors
 */
export class PermissionsError extends Data.TaggedError("PermissionsError")<{
  readonly reason: PermissionsErrorReason
}> {
  constructor(props: { readonly reason: PermissionsErrorReason }) {
    super({
      ...props,
      cause: props.reason.cause
    } as any)
  }

  readonly [ErrorTypeId] = ErrorTypeId

  override get message(): string {
    return this.reason.message
  }
}

/**
 * @since 1.0.0
 * @category Service
 */
export const Permissions: ServiceMap.Service<Permissions, Permissions> = ServiceMap.Service<Permissions>(TypeId)

/**
 * A layer that directly interfaces with the `navigator.permissions` api
 *
 * @since 1.0.0
 * @category Layers
 */
export const layer: Layer.Layer<Permissions> = Layer.succeed(
  Permissions,
  Permissions.of({
    [TypeId]: TypeId,
    query: (name) =>
      Effect.tryPromise({
        try: () => navigator.permissions.query({ name }) as Promise<any>,
        catch: (cause) =>
          new PermissionsError({
            reason: cause instanceof DOMException
              ? new PermissionsInvalidStateError({ cause })
              : new PermissionsTypeError({ cause })
          })
      })
  })
)
