import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { AgentId } from "../Agent.ts";
import { StreamTextPart } from "../llm/stream-text-part.ts";
import { Task, TaskId } from "../process/task.ts";
import { ChannelId } from "./channel.ts";
import { Message, MessageId } from "./message.ts";
import { Thread, ThreadId } from "./thread.ts";

export type SenderId = string;
export const SenderId = S.String.annotate({
  description: "The ID of the Agent or User who sent the message",
});

export class GetThreadRequest extends S.Class<GetThreadRequest>(
  "GetThreadRequest",
)({
  threadId: ThreadId,
}) {}

export class GetThreadResponse extends S.Class<GetThreadResponse>(
  "GetThreadResponse",
)({
  thread: S.optional(Thread),
}) {}

export class CreateThreadRequest extends S.Class<CreateThreadRequest>(
  "CreateThreadRequest",
)({
  channelId: ChannelId,
  parentThreadId: S.optional(ThreadId),
}) {}

export class CreateThreadResponse extends S.Class<CreateThreadResponse>(
  "CreateThreadResponse",
)({
  thread: Thread,
}) {}

export class SendMessageRequest extends S.Class<SendMessageRequest>(
  "SendMessageRequest",
)({
  threadId: ThreadId,
  sender: SenderId,
  content: S.String,
}) {}

export class SendMessageResponse extends S.Class<SendMessageResponse>(
  "SendMessageResponse",
)({
  messageId: MessageId,
}) {}

export class ListMessagesRequest extends S.Class<ListMessagesRequest>(
  "ListMessagesRequest",
)({
  threadId: ThreadId,
  nextToken: S.optional(S.String),
}) {}

export class ListMessagesResponse extends S.Class<ListMessagesResponse>(
  "ListMessagesResponse",
)({
  messages: S.Array(Message),
  nextToken: S.optional(S.String),
}) {}

export class ListThreadsRequest extends S.Class<ListThreadsRequest>(
  "ListThreadsRequest",
)({
  channelId: ChannelId,
  nextToken: S.optional(S.String),
}) {}

export class ListThreadsResponse extends S.Class<ListThreadsResponse>(
  "ListThreadsResponse",
)({
  threads: S.Array(Thread),
  nextToken: S.optional(S.String),
}) {}

export class AppendRequest extends S.Class<AppendRequest>("AppendRequest")({
  taskId: TaskId,
  part: StreamTextPart,
}) {}

export class SubscribeRequest extends S.Class<SubscribeRequest>(
  "SubscribeRequest",
)({
  taskId: TaskId,
}) {}

export class CreateTaskRequest extends S.Class<CreateTaskRequest>(
  "CreateTaskRequest",
)({
  threadId: ThreadId,
  agentId: AgentId,
}) {}

/**
 * The ChatService is the central service for managing Channels, Threads, and Messages.
 */
export class Chat extends Context.Service<
  Chat,
  {
    getThread: (request: GetThreadRequest) => Effect.Effect<GetThreadResponse>;
    createThread: (
      request: CreateThreadRequest,
    ) => Effect.Effect<CreateThreadResponse>;
    listThreads: (
      request: ListThreadsRequest,
    ) => Effect.Effect<ListThreadsResponse>;
    sendMessage: (
      request: SendMessageRequest,
    ) => Effect.Effect<SendMessageResponse>;
    listMessages: (
      request: ListMessagesRequest,
    ) => Effect.Effect<ListMessagesResponse>;
    subscribe: (request: SubscribeRequest) => Effect.Effect<StreamTextPart>;
    createTask: (request: CreateTaskRequest) => Effect.Effect<Task>;
    appendTask: (request: AppendRequest) => Effect.Effect<void>;
    subscribeTask: (request: SubscribeRequest) => Effect.Effect<StreamTextPart>;
    sinkTask: (
      taskId: TaskId,
      sink: (part: StreamTextPart) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
    sinkThreadDriver: (
      threadId: ThreadId,
      sink: (part: StreamTextPart) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
  }
>()("Chat") {}
