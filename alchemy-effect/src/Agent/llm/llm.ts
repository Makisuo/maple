import {
  createAnthropic,
  type AnthropicProviderOptions,
} from "@ai-sdk/anthropic";
import {
  createOpenAI,
  type OpenAIResponsesProviderOptions,
} from "@ai-sdk/openai";
import { jsonSchema, tool, ToolLoopAgent, type ModelMessage } from "ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import type { IsUnknown } from "../../Util/unknown.ts";
import type { Tool } from "../tool/tool.ts";
import { fromAnyError, type LLMError } from "./error.ts";
import type { StreamTextPart } from "./stream-text-part.ts";

export class LLM extends Context.Service<LLM, LLMService>()("LLM") {}

export type StreamTextOptions<T extends Tool = Tool> = {
  messages: ModelMessage[];
  model?: string;
  system: string;
  tools: T[];
};

export interface LLMService {
  stream: <Tools extends Tool>(
    input: StreamTextOptions<Tools>,
  ) => Stream.Stream<
    StreamTextPart,
    IsUnknown<Tool.Error<Tools>> extends true
      ? LLMError
      : LLMError | Tool.Error<Tools>,
    Exclude<Tool.Context<Tools>, unknown>
  >;
}

export interface LLMConfig {
  anthropic?: {
    apiKey: Redacted.Redacted<string>;
  };
  openai?: {
    apiKey: Redacted.Redacted<string>;
  };
}

export const llm = (config: LLMConfig) =>
  Layer.sync(LLM, () => {
    const anthropic = config.anthropic?.apiKey
      ? createAnthropic({
          apiKey: Redacted.value(config.anthropic?.apiKey),
        })
      : undefined;
    const openai = config.openai?.apiKey
      ? createOpenAI({ apiKey: Redacted.value(config.openai?.apiKey) })
      : undefined;

    return {
      stream: <T extends Tool>(input: StreamTextOptions<T>) => {
        const modelId = input.model ?? "anthropic/claude-opus-4.5";
        const modelProvider = modelId.split("/")[0];
        const model = modelId.includes("anthropic")
          ? anthropic?.(modelId)
          : openai?.(modelId);

        if (!model) {
          return Stream.die(`No model found for ${modelId}`);
        }

        return Stream.fromEffect(
          Effect.gen(function* () {
            // we need to get the caller's context so we can construct async functions
            const context = yield* Effect.context<never>();
            const tools: any = {};
            for (const t of input.tools) {
              const decode = S.decodeEffect(t.schema);
              tools[t.props.alias?.(modelId) ?? t.id] = tool({
                inputSchema: jsonSchema(S.toJsonSchemaDocument(t.schema)),
                description: "TODO",
                execute: (params) =>
                  Effect.runPromise(
                    decode(params as any).pipe(
                      Effect.flatMap(t.handle),
                      // provide the caller's context so the tool can access it
                      Effect.provide(context),
                    ) as Effect.Effect<any>,
                  ),
              });
            }
            return tools;
          }).pipe(
            Effect.flatMap((tools) =>
              Effect.promise((abortSignal) =>
                new ToolLoopAgent({
                  model,
                  instructions: input.system,
                  // never stop, build the world!!!
                  stopWhen: () => false,
                  tools,
                  providerOptions:
                    modelProvider === "anthropic"
                      ? {
                          anthropic: {
                            effort: "high",
                            thinking: { type: "enabled", budgetTokens: 12000 },
                          } satisfies AnthropicProviderOptions,
                        }
                      : {
                          openai: {
                            reasoningEffort: "high",
                          } satisfies OpenAIResponsesProviderOptions,
                        },
                })
                  .stream({
                    messages: input.messages,
                    abortSignal,
                  })
                  .then((s) => s.fullStream),
              ),
            ),
          ),
        ).pipe(
          Stream.flatMap((it) => Stream.fromAsyncIterable(it, fromAnyError)),
        );
      },
    };
  });
