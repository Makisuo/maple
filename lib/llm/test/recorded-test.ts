import { Effect, Layer } from "effect"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "../src/route"
import type { Service as LLMClientService } from "../src/route/client"
import type { Service as RequestExecutorService } from "../src/route/executor"
import type { Service as WebSocketExecutorService } from "../src/route/transport/websocket"
import { cassetteHttpClientLayer, hasCassette } from "./lib/replay"
import {
  recordedEffectGroup,
  type RecordedCaseOptions as RunnerCaseOptions,
  type RecordedGroupOptions,
} from "./recorded-runner"

type RecordedEnv = RequestExecutorService | WebSocketExecutorService | LLMClientService

/**
 * Upstream typed this as `HttpRecorder.RecorderOptions`. Maple replays cassettes rather than
 * recording them (see `test/lib/replay.ts`), so redaction and matcher config is inert — the type is
 * kept only so upstream's call sites in `provider/golden.recorded.test.ts` still compile verbatim.
 */
export type RecorderOptions = {
  readonly metadata?: Record<string, unknown>
  readonly redact?: Record<string, unknown>
  readonly match?: unknown
}

type RecordedTestsOptions = RecordedGroupOptions & {
  readonly options?: RecorderOptions
}

type RecordedCaseOptions = RunnerCaseOptions & {
  readonly options?: RecorderOptions
}

/**
 * There are no WebSocket cassettes, so every WebSocket target skips before this layer is built.
 * It exists to satisfy `RecordedEnv`; reaching it means a cassette was added without replay support.
 */
const webSocketUnsupported = Layer.succeed(
  WebSocketExecutor.Service,
  WebSocketExecutor.Service.of({
    open: () => Effect.die(new Error("WebSocket cassette replay is not supported — see test/lib/replay.ts")),
  }),
)

export const recordedTests = (options: RecordedTestsOptions) =>
  recordedEffectGroup<RecordedEnv, never, RecordedTestsOptions, RecordedCaseOptions>({
    duplicateLabel: "recorded cassette",
    options,
    cassetteExists: hasCassette,
    layer: ({ cassette }) => {
      const requestExecutor = RequestExecutor.layer.pipe(Layer.provide(cassetteHttpClientLayer(cassette)))
      const deps = Layer.mergeAll(requestExecutor, webSocketUnsupported)
      return Layer.mergeAll(deps, LLMClient.layer.pipe(Layer.provide(deps)))
    },
  })
