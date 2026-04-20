/**
 * @since 1.0.0
 */
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as EtagImpl from "effect/unstable/http/Etag"
import * as Headers from "effect/unstable/http/Headers"
import * as Platform from "effect/unstable/http/HttpPlatform"
import * as ServerResponse from "effect/unstable/http/HttpServerResponse"
import * as Fs from "node:fs"
import { Readable } from "node:stream"
import Mime from "./Mime.ts"
import * as NodeFileSystem from "./NodeFileSystem.ts"

/**
 * @since 1.0.0
 * @category Constructors
 */
export const make = Platform.make({
  fileResponse(path, status, statusText, headers, start, end, contentLength) {
    const stream = contentLength === 0
      ? Readable.from([])
      : Fs.createReadStream(path, { start, end: end === undefined ? undefined : end - 1 })
    return ServerResponse.raw(stream, {
      headers: {
        ...headers,
        "content-type": headers["content-type"] ?? Mime.getType(path) ?? "application/octet-stream",
        "content-length": contentLength.toString()
      },
      status,
      statusText
    })
  },
  fileWebResponse(file, status, statusText, headers, _options) {
    return ServerResponse.raw(Readable.fromWeb(file.stream() as any), {
      headers: Headers.merge(
        headers,
        Headers.fromRecordUnsafe({
          "content-type": headers["content-type"] ?? Mime.getType(file.name) ?? "application/octet-stream",
          "content-length": file.size.toString()
        })
      ),
      status,
      statusText
    })
  }
})

/**
 * @since 1.0.0
 * @category Layers
 */
export const layer: Layer.Layer<Platform.HttpPlatform> = pipe(
  Layer.effect(Platform.HttpPlatform)(make),
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(EtagImpl.layer)
)
