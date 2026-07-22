import { defineAgent } from "eve";
import { createWorkersAI } from "workers-ai-provider";

/**
 * Cloudflare Workers AI over its REST API (no Workers runtime / AI binding
 * required), so it works from a plain long-running Node process on Railway.
 * Credentials are read at request time; missing values here do not break
 * `eve build`, only live model calls.
 */
const workersai = createWorkersAI({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  apiKey: process.env.CLOUDFLARE_API_TOKEN ?? "",
});

/**
 * Surface missing model credentials at boot instead of only at the first model
 * call. This module is evaluated both by `eve build` (where the credentials
 * are legitimately absent — the Docker build only passes MAPLE_API_BASE_URL)
 * and again when the compiled server boots, so we suppress the warning when
 * the process is an `eve build` invocation (argv carries "build"; the runtime
 * server is `node .output/server/index.mjs`, and `eve dev` — where the warning
 * is useful — carries "dev"). A warn, never a throw: build-time safety of the
 * empty-string fallback above is intentional.
 */
const missingModelEnv = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"].filter(
  (name) => !process.env[name],
);
const isEveBuildInvocation = process.argv.includes("build");
if (missingModelEnv.length > 0 && !isEveBuildInvocation) {
  console.warn(
    `[startup] ${missingModelEnv.join(" and ")} ${missingModelEnv.length === 1 ? "is" : "are"} not set. ` +
      `The service will start, but every Workers AI model call will fail until ${missingModelEnv.length === 1 ? "it is" : "they are"} configured.`,
  );
}

/**
 * Must support tool calling **while streaming** — eve's harness is tool-driven and
 * always streams. That second half is the real constraint: several Workers AI
 * models parse tool calls only on non-streaming requests and, when streamed, emit
 * the model's raw tool-call JSON as ordinary text deltas. The agent then posts
 * `{"type":"function","name":"ask_question",...}` into Slack verbatim.
 *
 * `@cf/meta/llama-3.3-70b-instruct-fp8-fast` has exactly that bug — non-streaming
 * returns a proper `tool_calls` array, streaming returns the JSON as text (and
 * even in the structured form it stringifies booleans: `"allowFreeform": "true"`).
 * `@cf/zai-org/glm-5.2` streams OpenAI-shaped incremental `delta.tool_calls`
 * chunks (name + id on the first, argument fragments keyed by `index` after) and
 * finishes with `finish_reason: "tool_calls"`, which workers-ai-provider maps
 * correctly. It also emits chain-of-thought on `reasoning_content`, which the
 * provider routes to reasoning parts rather than message text.
 *
 * If you override WORKERS_AI_MODEL, verify streaming tool calls first — hit
 * `/ai/run/<model>` with `stream: true` plus a `tools` array and confirm the SSE
 * carries `delta.tool_calls`, not a JSON blob inside `response`.
 */
const modelId = process.env.WORKERS_AI_MODEL ?? "@cf/zai-org/glm-5.2";

/**
 * Direct (non-Gateway) models carry no AI Gateway context-window metadata, which
 * eve's compaction needs — so declare it here. glm-5.2 is 256K; override
 * with WORKERS_AI_CONTEXT_WINDOW if you switch models.
 */
const contextWindowTokens = Number(process.env.WORKERS_AI_CONTEXT_WINDOW ?? 262_144);

/**
 * Durable workflow state ("world").
 *
 * NOTE: eve resolves this at BUILD time — agent.ts is compiled into eve's
 * manifest, so EVE_WORKFLOW_WORLD must be set when `eve build` runs, not just at
 * runtime. The Dockerfile sets it before building; setting it only as a runtime
 * variable silently leaves you on the ephemeral on-disk local world.
 *
 * - Production (Railway): baked in as @workflow/world-postgres by the Dockerfile.
 * - Local dev: leave it unset to use eve's zero-config on-disk local world, so
 *   you can exercise the model + Slack loop without standing up Postgres.
 */
const workflowWorld = process.env.EVE_WORKFLOW_WORLD;

export default defineAgent({
  model: workersai(modelId),
  modelContextWindowTokens: contextWindowTokens,
  ...(workflowWorld
    ? { experimental: { workflow: { world: workflowWorld } } }
    : {}),
});
