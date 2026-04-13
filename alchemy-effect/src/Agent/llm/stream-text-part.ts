import type { TextStreamPart } from "ai";
import * as S from "effect/Schema";

export type StreamTextPart = TextStreamPart<any>;

// TODO(sam): build out the schema for this
export const StreamTextPart = S.suspend((): S.Schema<StreamTextPart> => S.Any);
