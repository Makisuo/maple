/**
 * @since 4.0.0
 */
import * as Layer from "../../Layer.ts"
import * as Socket from "../socket/Socket.ts"
import * as DevToolsClient from "./DevToolsClient.ts"

/**
 * @since 4.0.0
 * @category layers
 */
export const layerSocket: Layer.Layer<never, never, Socket.Socket> = DevToolsClient.layerTracer

/**
 * @since 4.0.0
 * @category layers
 */
export const layerWebSocket = (
  url = "ws://localhost:34437"
): Layer.Layer<never, never, Socket.WebSocketConstructor> =>
  DevToolsClient.layerTracer.pipe(
    Layer.provide(Socket.layerWebSocket(url))
  )

/**
 * @since 4.0.0
 * @category layers
 */
export const layer = (url = "ws://localhost:34437"): Layer.Layer<never> =>
  layerWebSocket(url).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal)
  )
