import { Effect, FileSystem, Layer, ManagedRuntime, Path } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { AllRoutes, ApiAuthLive, ApiObservabilityLive, MainLive } from "./app"
import { serveWorkerRequest } from "./lib/serve-worker-request"
import { DatabaseD1Live } from "./services/DatabaseD1Live"
import { WorkerBindings } from "./services/WorkerBindings"

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

const ApiHttpApp = HttpRouter.toHttpEffect(AllRoutes)

const buildRuntime = (env: Record<string, unknown>) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      WorkerPlatformLive,
      ApiObservabilityLive,
      MainLive,
      ApiAuthLive,
    ).pipe(
      Layer.provide(DatabaseD1Live),
      Layer.provide(WorkerBindings.layer(env)),
    ),
  )

const runtimeCache = new WeakMap<
  object,
  ReturnType<typeof buildRuntime>
>()

const getRuntime = (env: Record<string, unknown>) => {
  const key = env as object
  const existing = runtimeCache.get(key)
  if (existing) return existing
  const rt = buildRuntime(env)
  runtimeCache.set(key, rt)
  return rt
}

const handleRequest = (
  request: Request,
  env: Record<string, unknown>,
) => {
  const runtime = getRuntime(env)
  return runtime.runPromise(
    ApiHttpApp.pipe(
      Effect.flatMap((httpApp) =>
        serveWorkerRequest(request, httpApp, {
          remoteAddress:
            request.headers.get("cf-connecting-ip") ?? undefined,
        }),
      ),
      Effect.scoped,
    ),
  )
}

export default {
  fetch(request: Request, env: Record<string, unknown>) {
    return handleRequest(request, env)
  },
}
