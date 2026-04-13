import * as S from "effect/Schema";
import { Task } from "../process/task.ts";
import { Message } from "./message.ts";
import { Thread } from "./thread.ts";

export class MessageCreatedEvent extends S.Class<MessageCreatedEvent>(
  "MessageCreatedEvent",
)({
  message: Message,
}) {}

export class ThreadCreatedEvent extends S.Class<ThreadCreatedEvent>(
  "ThreadCreatedEvent",
)({
  thread: Thread,
}) {}

export class ThreadUpdatedEvent extends S.Class<ThreadUpdatedEvent>(
  "ThreadUpdatedEvent",
)({
  thread: Thread,
}) {}

export class TaskStartedEvent extends S.Class<TaskStartedEvent>(
  "TaskStartedEvent",
)({
  task: Task,
}) {}

export class TaskCompletedEvent extends S.Class<TaskCompletedEvent>(
  "TaskCompletedEvent",
)({
  task: Task,
}) {}

export type ChatEvent = S.Schema.Type<typeof ChatEvent>;
export const ChatEvent = S.Union([
  MessageCreatedEvent,
  ThreadCreatedEvent,
  ThreadUpdatedEvent,
  TaskStartedEvent,
  TaskCompletedEvent,
]);
