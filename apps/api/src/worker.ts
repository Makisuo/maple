import { ConfigProvider, FileSystem, Layer, Path } from "effect"
import { HttpMiddleware, HttpRouter } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { AllRoutes, ApiAuthLive, ApiObservabilityLive, MainLive } from "./app"
import { DatabaseD1Live } from "./services/DatabaseD1Live"
import { WorkerEnvironment } from "./services/WorkerEnvironment"

const WorkerFileSystemLive = FileSystem.layerNoop({})

const WorkerHttpPlatformLive = Layer.effect(
  HttpPlatform.HttpPlatform,
  HttpPlatform.make({
    fileResponse: (_path, status, statusText, headers) =>
      HttpServerResponse.text(
        "File responses are unavailable in the worker runtime",
        { status, statusText, headers },
      ),
    fileWebResponse: (_file, status, statusText, headers) =>
      HttpServerResponse.text(
        "File responses are unavailable in the worker runtime",
        { status, statusText, headers },
      ),
  }),
).pipe(
  Layer.provideMerge(WorkerFileSystemLive),
  Layer.provideMerge(Etag.layer),
)

const WorkerPlatformLive = Layer.mergeAll(
  Path.layer,
  Etag.layer,
  WorkerFileSystemLive,
  WorkerHttpPlatformLive,
)

// POST /mcp hangs indefinitely when `toWebHandler` is called with no `middleware`
// option (Cloudflare 1101 worker timeout in prod, miniflare "worker hung" locally).
// Providing ANY middleware — even a pass-through — unsticks it. Suspected Effect
// RpcServer / HttpRouter scope-propagation bug when only the default logger is
// installed. Remove this once upstream fixes it.
const passthroughMiddleware = HttpMiddleware.make((httpApp) => httpApp)

const buildHandler = (env: Record<string, unknown>) =>
  HttpRouter.toWebHandler(
    AllRoutes.pipe(
      Layer.provideMerge(MainLive),
      Layer.provideMerge(ApiAuthLive),
      Layer.provideMerge(ApiObservabilityLive),
      Layer.provideMerge(WorkerPlatformLive),
      Layer.provideMerge(DatabaseD1Live),
      Layer.provideMerge(Layer.succeed(WorkerEnvironment, env)),
      Layer.provideMerge(
        ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
      ),
    ),
    { middleware: passthroughMiddleware },
  )

const handlerCache = new WeakMap<object, ReturnType<typeof buildHandler>>()

const getHandler = (env: Record<string, unknown>) => {
  const key = env as object
  const existing = handlerCache.get(key)
  if (existing) return existing
  const built = buildHandler(env)
  handlerCache.set(key, built)
  return built
}

export { TinybirdSyncWorkflow } from "./workflows/TinybirdSyncWorkflow"

export default {
  fetch(request: Request, env: Record<string, unknown>) {
    // TODO: `toWebHandler` still reports TinybirdService/Scope/HttpServerRequest
    // as unprovided requirements, but they resolve at runtime via MainLive's
    // transitive composition. Re-audit the Layer graph and drop this cast
    // once the residual `R` genuinely becomes `never`.
    const handler = getHandler(env).handler as (request: Request) => Promise<Response>
    return handler(request)
  },
}
