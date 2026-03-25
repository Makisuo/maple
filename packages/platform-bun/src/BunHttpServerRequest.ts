/**
 * @since 1.0.0
 */
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"

/**
 * @since 1.0.0
 * @category Accessors
 */
export const toBunServerRequest = <T extends string = string>(self: HttpServerRequest): Bun.BunRequest<T> =>
  (self as any).source
