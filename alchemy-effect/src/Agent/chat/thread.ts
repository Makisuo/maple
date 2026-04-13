import * as S from "effect/Schema";

export type ThreadId = string;
export const ThreadId = S.String.annotate({
  description: "The ID of the thread",
});

export class Thread extends S.Class<Thread>("Thread")({
  threadId: ThreadId,
  participants: S.Array(S.String).annotate({
    description: "The agent participants in the thread",
  }),
  messages: S.Array(S.String).annotate({
    description: "The messages in the thread",
  }),
  parent: S.optional(S.suspend((): S.Schema<Thread> => Thread)),
}) {}
