import { Schema } from "effect"

export class AgentHarnessStoreError extends Schema.TaggedErrorClass<AgentHarnessStoreError>()(
  "@maple/agent-harness/StoreError",
  { message: Schema.String },
) {}

export class AgentHarnessModelError extends Schema.TaggedErrorClass<AgentHarnessModelError>()(
  "@maple/agent-harness/ModelError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect),
  },
) {}

export class AgentHarnessCompactionError extends Schema.TaggedErrorClass<AgentHarnessCompactionError>()(
  "@maple/agent-harness/CompactionError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect),
  },
) {}

export type AgentHarnessError =
  | AgentHarnessStoreError
  | AgentHarnessModelError
  | AgentHarnessCompactionError
