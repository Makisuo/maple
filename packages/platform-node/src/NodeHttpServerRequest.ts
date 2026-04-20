/**
 * @since 1.0.0
 */
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import type * as Http from "node:http"

/**
 * @since 1.0.0
 * @category Accessors
 */
export const toIncomingMessage = (self: HttpServerRequest): Http.IncomingMessage => self.source as any

/**
 * @since 1.0.0
 * @category Accessors
 */
export const toServerResponse = (self: HttpServerRequest): Http.ServerResponse => {
  const res = (self as any).response
  return typeof res === "function" ? res() : res
}
