import * as S from "effect/Schema";
import { CreatedAt, UpdatedAt } from "../../Schema.ts";
import { IssueId } from "./issue.ts";

export type ReplyId = number;
export const ReplyId = S.Int.check(S.isGreaterThan(0)).annotate({
  description: "The ID of the reply",
});

export type ReplyContent = string;
export const ReplyContent = S.String.annotate({
  description: "The content of the reply",
});

export class Reply extends S.Class<Reply>("Reply")({
  replyId: ReplyId,
  issueId: IssueId,
  content: ReplyContent,
  createdAt: CreatedAt,
  updatedAt: UpdatedAt,
}) {}
