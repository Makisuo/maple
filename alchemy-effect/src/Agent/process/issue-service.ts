import * as Context from "effect/Context";
import type { Effect } from "effect/Effect";
import * as S from "effect/Schema";
import { Issue, IssueId } from "./issue.ts";
import { Reply, ReplyId } from "./reply.ts";

export class CreateIssueRequest extends S.Class<CreateIssueRequest>(
  "CreateIssueRequest",
)({
  title: S.String,
  description: S.String,
}) {}

export class UpdateIssueRequest extends S.Class<UpdateIssueRequest>(
  "UpdateIssueRequest",
)({
  issueId: IssueId,
  title: S.String.pipe(S.optional),
  description: S.String.pipe(S.optional),
}) {}

export class SendReplyRequest extends S.Class<SendReplyRequest>(
  "SendReplyRequest",
)({
  issueId: IssueId,
  content: S.String,
}) {}

export class UpdateReplyRequest extends S.Class<UpdateReplyRequest>(
  "UpdateReplyRequest",
)({
  replyId: ReplyId,
  content: S.String.pipe(S.optional),
}) {}

export class Issues extends Context.Service<
  Issues,
  {
    listIssues: () => Effect<Issue[]>;
    readIssue: (issueId: IssueId) => Effect<Issue>;
    createIssue: (input: CreateIssueRequest) => Effect<Issue>;
    updateIssue: (input: UpdateIssueRequest) => Effect<Issue>;
    closeIssue: (issueId: IssueId) => Effect<Issue>;
    sendReply: (input: SendReplyRequest) => Effect<Reply>;
    updateReply: (input: UpdateReplyRequest) => Effect<Reply>;
    deleteReply: (replyId: ReplyId) => Effect<void>;
  }
>()("Issues") {}
