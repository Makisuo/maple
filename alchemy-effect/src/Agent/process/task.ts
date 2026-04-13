import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { AgentId } from "../Agent.ts";
import { ThreadId } from "../chat/thread.ts";

export type TaskId = string;
export const TaskId = S.String.annotate({
  description: "The ID of the task",
});

export class Task extends S.Class<Task>("Task")({
  taskId: TaskId,
  threadId: ThreadId.annotate({
    description: "The thread that the task belongs to",
  }),
  agent: AgentId.annotate({
    description: "The agent that is working on the task",
  }),
}) {}

export class CreateTaskRequest extends S.Class<CreateTaskRequest>(
  "CreateTaskRequest",
)({
  threadId: ThreadId,
  agentId: AgentId,
}) {}

export class Tasks extends Context.Service<
  Tasks,
  {
    createTask: (input: CreateTaskRequest) => Effect.Effect<Task>;
  }
>()("Tasks") {}
