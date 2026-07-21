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
 * Must support function/tool calling — eve's default harness is tool-driven.
 * Override with WORKERS_AI_MODEL without editing code.
 */
const modelId = process.env.WORKERS_AI_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Direct (non-Gateway) models carry no AI Gateway context-window metadata, which
 * eve's compaction needs — so declare it here. Llama 3.3 70B is 128K; override
 * with WORKERS_AI_CONTEXT_WINDOW if you switch models.
 */
const contextWindowTokens = Number(process.env.WORKERS_AI_CONTEXT_WINDOW ?? 128_000);

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
