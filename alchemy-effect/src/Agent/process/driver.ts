// @ts-nocheck - uncomment this once we are working on AI again
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import * as util from "node:util";
import * as vm from "node:vm";
import { schemaToType } from "../../Util/schema-to-type.ts";
import { Agent, AgentId } from "../Agent.ts";
import { AspectGraph } from "../AspectGraph.ts";
import { Chat } from "../chat/service.ts";
import { Thread } from "../chat/thread.ts";
import { LLM } from "../llm/llm.ts";
import { lastMessageText } from "../llm/stream-collectors.ts";
import { Tool } from "../tool/tool.ts";

/**
 * Called whenever a message is sent by a user to a Thread.
 *
 * This uses an LLM to choose which agents should respond to the message.
 */
export const driveThread = Effect.fn("driveThread")(function* (thread: Thread) {
  const graph = yield* AspectGraph;
  const {
    exprs: [env],
    types,
  } = schemaToType(graph.schema);
  class code extends Tool.input("code")`
JavaScript code to evaluate (must be a valid JavaScript module.
Using modern ESM syntax only.
The code is running in a Bun REPL environment.
Use arbitrary JavaScript code to explore the environment and` {}

  class evaluate extends Tool("eval")`
Evaluates ${code} in a REPL in an Agent's environment and returns the console.log
output and result of the evaluation as a ${S.String}.
Use this tool to explore the Chat environment and find relevant information.
\`\`\`typescript
${types}
/** The environment of the Agent. */
declare const env: ${env};
/** The current issue
declare const issue: Issue;
/** The current prompt to the Agent. */
declare const query: string;
/** A function that can be used to recursively call the LLM to explore the environment. */
declare function recursiveLLM(subQuery: string): Promise<string>;
\`\`\`
`(function* ({ code }) {
    const logs: string[] = [];
    const capture = (...args: unknown[]) =>
      logs.push(
        args
          .map((a) =>
            typeof a === "string" ? a : util.inspect(a, { depth: null }),
          )
          .join(" "),
      );
    const context = vm.createContext({
      env: graph.aspects,
      issue: undefined, // TODO(sam): provide the current issue
      console: {
        log: capture,
        info: capture,
        warn: capture,
        error: capture,
        debug: capture,
      },
    });
    try {
      const script = new vm.Script(code);
      const result = script.runInContext(context);
      return `${logs.join("\n")}${logs.length > 0 ? "\n" : ""}${typeof result === "string" ? result : util.inspect(result, { depth: null })}`;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return `${logs.join("\n")}${logs.length > 0 ? "\n" : ""}${error}`;
    }
  }) {}

  // TODO(sam): use examples of agents in the graph, agents.map((a) => a.id).slice(0, 3).join(", ")
  // or -> make it a literal type of all agent IDs
  class agentId extends Tool.input("agentId", AgentId)`
  The ID of the Agent to create a Task for, e.g. @ceo, @sde, @cfo.` {}

  class prompt extends Tool.input("prompt")`
  The prompt to start the Task with.` {}

  class query extends Tool("query")`
  You are a Recursive Language Model. You interact with context through a JavaScript Bun REPL environment.

  The Aspect environment is stored in the variable \`env\`. 
  IMPORTANT: You cannot see the context directly. You MUST write JavaScript code to search and explore it.
  
  Available in environment:
  \`\`\`typescript
  ${types}
  /** The environment of the Agent. */
  declare const env: ${env};
  // The current Issue (similar to a GitHub Issue)
  declare const issue: Issue;
  /** The current query to answer. */
  declare const query: string;
  /** A function that can be used to recursively call the LLM to explore the environment. */
  declare function query(subQuery: string): Promise<string>;
  \`\`\`
  
  Write JavaScript code to answer the query. The last expression and all console.log() output will be shown to you.
  
  Examples:
  - console.log(issue.messages[issue.messages.length-1]) // See the last message in the issue
  - issue.messages[issue.messages.length-1] // Print the last message in the issue (because this is the last expression in the code)
  - matches = re.findall(r'keyword.*', context); print(matches[:5])
  - idx = context.find('search term'); print(context[idx:idx+200])
  
  CRITICAL: Do NOT guess or make up answers. You MUST search the context first to find the actual information.
  Only finish your response after you have found concrete evidence in the context.
  Finish by providing a detailed textual answer to the query.
  
  Depth: {depth}`(function* () {}) {}

  class reply extends Tool("reply")`
  Prompt an Agent (by ${agentId}) to reply in a Thread. 
  The agent is given a ${prompt} to orient the direction of the task, but is otherwise free to choose how to complete the task.
  Available agents: ${Object.keys(graph.aspects.agent).join(", ")}
  If the reply fails, a ${S.String} message will be returned.
  Use the ${recursiveLLM} tool to explore and query the contextual encironment you are operating in.
  `(function* ({ agentId, prompt }) {
    // TODO(sam): look up in the graph?
    const agent = graph.aspects.agent[agentId] as Agent | undefined;

    if (!agent) {
      return `Agent '${agentId}' not found, available agents: ${Object.keys(graph.aspects.agent).join(", ")}`;
    }

    const task = yield* Chat.createTask({
      threadId: thread.threadId,
      agentId,
    });

    const lastMessage = yield* LLM.stream({
      model: "anthropic/claude-opus-4.5",
      system: ``,
      messages: [{ role: "user", content: prompt }],
      tools: [],
    }).pipe(
      Stream.tapSink(Chat.sinkTask(task.taskId)),
      Stream.run(lastMessageText),
    );

    if (!lastMessage) {
      return yield* Effect.die(`No message returned from agent '${agentId}'`);
    }

    // TODO(sam): submit the result message to the issue
    return lastMessage;
  }) {}

  const stream = Effect.gen(function* () {
    const llm = yield* LLM;
    const chat = yield* Chat;
    return yield* llm
      .stream({
        system: "You are a helpful assistant.",
        messages: [],
        tools: [evaluate, reply],
      })
      .pipe(Stream.tapSink(chat.sinkThreadDriver(thread.threadId)));
  });
});
