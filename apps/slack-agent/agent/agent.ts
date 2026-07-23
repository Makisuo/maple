import { defineAgent } from "eve";
import { createWorkersAI } from "workers-ai-provider";

/**
 * Cloudflare Workers AI over its REST API (no Workers runtime / AI binding
 * required).
 */
const workersai = createWorkersAI({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  apiKey: process.env.CLOUDFLARE_API_TOKEN ?? "",
});

/**
 * Make sure no envs are missing on startup.
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
 * always streams.
 */
const modelId = process.env.WORKERS_AI_MODEL ?? "@cf/zai-org/glm-5.2";
const contextWindowTokens = Number(process.env.WORKERS_AI_CONTEXT_WINDOW ?? 262_144);

/**
 * Durable workflow state ("world").
 */
const workflowWorld = process.env.EVE_WORKFLOW_WORLD;

export default defineAgent({
  model: workersai(modelId),
  modelContextWindowTokens: contextWindowTokens,
  ...(workflowWorld
    ? { experimental: { workflow: { world: workflowWorld } } }
    : {}),
});
