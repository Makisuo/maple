import { generateText, stepCountIs, streamText, type LanguageModelUsage, type ModelMessage, type StreamTextOnFinishCallback, type ToolSet } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { Effect } from "effect"
import {
  AgentHarnessModelError,
  renderCompactionPrompt,
  type AgentModelGatewayShape,
} from "@maple/agent-harness"

const DEFAULT_MODEL_ID = "moonshotai/kimi-k2.5:nitro"
const DEFAULT_CONTEXT_WINDOW = 128_000

const parseCompactionSummary = (raw: string) => {
  try {
    const parsed = JSON.parse(raw) as {
      summary?: string
      turnContextSummary?: string
    }
    if (typeof parsed.summary === "string") {
      return {
        summary: parsed.summary,
        turnContextSummary:
          typeof parsed.turnContextSummary === "string"
            ? parsed.turnContextSummary
            : undefined,
      }
    }
  } catch {
    // fall through to the text fallback
  }

  const [summary, turnContextSummary] = raw.split(/\nTURN_CONTEXT:\s*/i)
  return {
    summary: summary.replace(/^SUMMARY:\s*/i, "").trim() || raw.trim(),
    turnContextSummary: turnContextSummary?.trim() || undefined,
  }
}

export interface CreateModelGatewayOptions {
  readonly onCompactionUsage?: (usage: LanguageModelUsage) => void
}

export const createModelGateway = (
  apiKey: string,
  options: CreateModelGatewayOptions = {},
): AgentModelGatewayShape => {
  const openrouter = createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
  })

  const model = openrouter.chatModel(DEFAULT_MODEL_ID)

  return {
    modelId: DEFAULT_MODEL_ID,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    summarizeCompaction: ({ snapshot, preparation, abortSignal }) =>
      Effect.tryPromise({
        try: async () => {
          const result = await generateText({
            model,
            abortSignal,
            temperature: 0,
            system: [
              "Return a compact JSON object with keys `summary` and optional `turnContextSummary`.",
              "The summary must preserve user intent, constraints, prior findings, and important operational details.",
              "Use `turnContextSummary` only when the cut removed the prefix of the current turn.",
            ].join(" "),
            prompt: renderCompactionPrompt(snapshot, preparation),
          })

          options.onCompactionUsage?.(result.usage)

          return parseCompactionSummary(result.text)
        },
        catch: (error) =>
          new AgentHarnessModelError({
            message: error instanceof Error ? error.message : String(error),
          }),
      }),
    streamTurn: <TOOLS extends ToolSet>({
      system,
      messages,
      tools,
      abortSignal,
      onFinish,
    }: {
      readonly system: string
      readonly messages: ReadonlyArray<ModelMessage>
      readonly tools: TOOLS
      readonly abortSignal?: AbortSignal
      readonly onFinish?: StreamTextOnFinishCallback<TOOLS>
    }) =>
      streamText({
        model,
        system,
        messages: [...messages],
        tools,
        stopWhen: stepCountIs(20),
        abortSignal,
        onFinish,
      }),
  }
}
