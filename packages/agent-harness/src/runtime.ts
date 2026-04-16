import type { ModelMessage, StreamTextOnFinishCallback, StreamTextResult, ToolSet } from "ai"
import { Effect, Queue, Ref } from "effect"
import { AgentHarnessModelError, type AgentHarnessError } from "./errors"
import { compactSnapshot } from "./compaction"
import {
  buildSessionContext,
  createEmptySnapshot,
  estimateMessageTokens,
  estimateTextTokens,
  toSessionUsage,
} from "./session-context"
import type {
  AgentModelGatewayShape,
  AgentPromptInput,
  AgentSessionStoreShape,
  AgentToolRegistryShape,
  HarnessCommand,
  SessionEntry,
  SessionSnapshot,
} from "./types"

export interface AgentHarnessRuntime {
  readonly prompt: <TOOLS extends ToolSet>(
    input: AgentPromptInput & {
      readonly tools: TOOLS
      readonly onFinish?: StreamTextOnFinishCallback<TOOLS>
    },
  ) => Effect.Effect<{
    readonly result: StreamTextResult<TOOLS, any>
    readonly snapshot: SessionSnapshot
  }, AgentHarnessModelError>
  readonly compactNow: (turnId: string, abortSignal?: AbortSignal) => Effect.Effect<SessionSnapshot, AgentHarnessError>
  readonly continue: (text: string) => Effect.Effect<void>
  readonly steer: (text: string) => Effect.Effect<void>
  readonly followUp: (text: string) => Effect.Effect<void>
  readonly abort: () => Effect.Effect<void>
  readonly state: Effect.Effect<SessionSnapshot>
}

const appendUserMessage = (
  snapshot: SessionSnapshot,
  turnId: string,
  text: string,
): ReadonlyArray<SessionEntry> => [{
  id: `${snapshot.sessionId}:${turnId}:user`,
  createdAt: Date.now(),
  turnId,
  type: "message",
  message: {
    role: "user",
    content: [{ type: "text", text }],
  } satisfies ModelMessage,
  estimatedTokens: estimateTextTokens(text),
}]

const toResponseEntries = (
  sessionId: string,
  turnId: string,
  messages: ReadonlyArray<ModelMessage>,
): ReadonlyArray<SessionEntry> =>
  messages.map((message, index) => ({
    id: `${sessionId}:${turnId}:response:${index}`,
    createdAt: Date.now(),
    turnId,
    type: "message" as const,
    message,
    estimatedTokens: estimateMessageTokens(message),
  }))

const enqueueCommand = <K extends HarnessCommand["kind"]>(
  queue: Queue.Queue<HarnessCommand>,
  kind: K,
  text: string,
) => Queue.offer(queue, {
  id: `${kind}:${Date.now()}`,
  kind,
  text,
  createdAt: Date.now(),
} satisfies HarnessCommand)

export const makeAgentHarnessRuntime = (
  sessionId: string,
  store: AgentSessionStoreShape,
  modelGateway: AgentModelGatewayShape,
  _toolRegistry: AgentToolRegistryShape,
): AgentHarnessRuntime =>
  Effect.runSync(
    Effect.gen(function* () {
      const commandQueue = yield* Queue.unbounded<HarnessCommand>()
      const snapshotRef = yield* Ref.make<SessionSnapshot>(createEmptySnapshot(sessionId))
      const activeAbortRef = yield* Ref.make<AbortController | undefined>(undefined)

      const loadSnapshot = store.load(sessionId).pipe(
        Effect.tap((snapshot) => Ref.set(snapshotRef, snapshot)),
      )

      const compactNow = (turnId: string, abortSignal?: AbortSignal) =>
        Effect.gen(function* () {
          const snapshot = yield* Ref.get(snapshotRef)
          const compaction = yield* compactSnapshot(snapshot, turnId, modelGateway, abortSignal)
          if (!compaction) return snapshot
          const persisted = yield* store.appendEntries(snapshot, [compaction.entry])
          yield* Ref.set(snapshotRef, persisted)
          return persisted
        })

      return {
        state: Ref.get(snapshotRef),
        compactNow,
        continue: (text: string) => enqueueCommand(commandQueue, "continue", text).pipe(Effect.asVoid),
        steer: (text: string) => enqueueCommand(commandQueue, "steer", text).pipe(Effect.asVoid),
        followUp: (text: string) => enqueueCommand(commandQueue, "follow_up", text).pipe(Effect.asVoid),
        abort: () =>
          Ref.get(activeAbortRef).pipe(
            Effect.flatMap((controller) => Effect.sync(() => controller?.abort())),
          ),
        prompt: <TOOLS extends ToolSet>({ text, turnId, system, tools, abortSignal, onFinish }: AgentPromptInput & {
          tools: TOOLS
          onFinish?: StreamTextOnFinishCallback<TOOLS>
        }) =>
          Effect.gen(function* () {
            const loaded = yield* loadSnapshot
            const snapshotAfterCompaction = yield* compactNow(turnId, abortSignal)
            const userEntries = appendUserMessage(snapshotAfterCompaction, turnId, text)
            const withUser = yield* store.appendEntries(snapshotAfterCompaction, userEntries, {
              nextTurnIndex: snapshotAfterCompaction.nextTurnIndex + 1,
            })
            yield* Ref.set(snapshotRef, withUser)

            const controller = new AbortController()
            if (abortSignal) {
              abortSignal.addEventListener("abort", () => controller.abort(), { once: true })
            }
            yield* Ref.set(activeAbortRef, controller)

            const result = modelGateway.streamTurn({
              system,
              messages: buildSessionContext(withUser),
              tools,
              abortSignal: controller.signal,
              onFinish,
            })

            void Promise.resolve(result.steps).then(
              (steps) => {
                const finalStep = steps[steps.length - 1]
                if (!finalStep) return
                const responseEntries = toResponseEntries(
                  sessionId,
                  turnId,
                  finalStep.response.messages as ReadonlyArray<ModelMessage>,
                )
                const usage = toSessionUsage(finalStep.usage, responseEntries.at(-1)?.id ?? `${sessionId}:${turnId}:usage`)
                void Effect.runPromise(
                  store.appendEntries(withUser, responseEntries, {
                    lastSuccessfulUsage: usage,
                  }).pipe(
                    Effect.tap((nextSnapshot) => Ref.set(snapshotRef, nextSnapshot)),
                  ),
                ).catch(() => undefined)
              },
              () => undefined,
            ).finally(() => {
              void Effect.runPromise(Ref.set(activeAbortRef, undefined)).catch(() => undefined)
            })

            return { result, snapshot: loaded }
          }).pipe(
            Effect.mapError((error) =>
              new AgentHarnessModelError({
                message: error instanceof Error ? error.message : String(error),
              }),
            ),
          ),
      } satisfies AgentHarnessRuntime
    }),
  )
