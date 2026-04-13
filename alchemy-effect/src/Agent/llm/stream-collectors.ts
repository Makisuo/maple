import * as Sink from "effect/Sink";
import type { StreamTextPart } from "./stream-text-part.ts";

// Extract specific part types from the StreamTextPart union
export type TextDeltaPart = Extract<StreamTextPart, { type: "text-delta" }>;
export type TextStartPart = Extract<StreamTextPart, { type: "text-start" }>;
export type TextEndPart = Extract<StreamTextPart, { type: "text-end" }>;
export type ReasoningDeltaPart = Extract<
  StreamTextPart,
  { type: "reasoning-delta" }
>;
export type ReasoningStartPart = Extract<
  StreamTextPart,
  { type: "reasoning-start" }
>;
export type ReasoningEndPart = Extract<
  StreamTextPart,
  { type: "reasoning-end" }
>;
export type ToolCallPart = Extract<StreamTextPart, { type: "tool-call" }>;
export type ToolResultPart = Extract<StreamTextPart, { type: "tool-result" }>;
export type ToolErrorPart = Extract<StreamTextPart, { type: "tool-error" }>;

/**
 * Creates a sink that collects the text from the last complete text message.
 * A complete message is one that has received a text-end event.
 * Returns undefined if no complete text messages are present.
 *
 * @example
 * ```typescript
 * const lastText = yield* llm.stream({ ... }).pipe(
 *   Stream.run(collectLastText())
 * );
 * if (lastText) {
 *   yield* Console.log(`Last message: ${lastText}`);
 * }
 * ```
 */
export const lastMessageText: Sink.Sink<string | undefined, StreamTextPart> =
  Sink.reduce(
    () => ({
      currentId: undefined as string | undefined,
      text: "",
      lastComplete: undefined as string | undefined,
    }),
    (acc, part: StreamTextPart) => {
      if (part.type === "text-start") {
        return { currentId: part.id, text: "", lastComplete: acc.lastComplete };
      }
      if (part.type === "text-delta" && acc.currentId === part.id) {
        return { ...acc, text: acc.text + part.text };
      }
      if (part.type === "text-end" && acc.currentId === part.id) {
        return { ...acc, lastComplete: acc.text };
      }
      return acc;
    },
  ).pipe(Sink.map((acc) => acc.lastComplete));
