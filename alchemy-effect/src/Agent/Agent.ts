import * as S from "effect/Schema";
import { defineAspect, type Aspect } from "./Aspect.ts";

export type AgentId = string;
export const AgentId = S.String.annotate({
  description: "The ID of the agent",
});

export interface Agent<
  ID extends string = string,
  References extends any[] = any[],
> extends Aspect<Agent, "agent", ID, References> {}

export const Agent =
  defineAspect<
    <const Name extends string>(
      name: Name,
    ) => <References extends any[]>(
      template: TemplateStringsArray,
      ...references: References
    ) => Agent<Name, References>
  >("agent");

export const agentContext = Agent.plugin.context.succeed({
  context: (agent) => `@${agent.id}`,
});
