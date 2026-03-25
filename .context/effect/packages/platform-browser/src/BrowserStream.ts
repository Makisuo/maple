/**
 * @since 1.0.0
 */

import * as Stream from "effect/Stream"

/**
 * Creates a `Stream` from `window.addEventListener`.
 *
 * By default, the underlying buffer is unbounded in size. You can customize the
 * buffer size an object as the second argument with the `bufferSize` field.
 *
 * @since 1.0.0
 * @category Streams
 */
export const fromEventListenerWindow = <K extends keyof WindowEventMap>(
  type: K,
  options?: boolean | {
    readonly capture?: boolean
    readonly passive?: boolean
    readonly once?: boolean
    readonly bufferSize?: number | undefined
  } | undefined
): Stream.Stream<WindowEventMap[K], never, never> => Stream.fromEventListener<WindowEventMap[K]>(window, type, options)

/**
 * Creates a `Stream` from `document.addEventListener`.
 *
 * By default, the underlying buffer is unbounded in size. You can customize the
 * buffer size an object as the second argument with the `bufferSize` field.
 *
 * @since 1.0.0
 * @category Streams
 */
export const fromEventListenerDocument = <K extends keyof DocumentEventMap>(
  type: K,
  options?: boolean | {
    readonly capture?: boolean
    readonly passive?: boolean
    readonly once?: boolean
    readonly bufferSize?: number | undefined
  } | undefined
): Stream.Stream<DocumentEventMap[K], never, never> =>
  Stream.fromEventListener<DocumentEventMap[K]>(document, type, options)
