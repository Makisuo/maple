import { jsonSchema, tool, type ToolSet } from "ai"
import { Effect, type ManagedRuntime } from "effect"
import { McpToolExecutor } from "@/mcp/dispatcher"
import { mapleToolCatalog, toInputSchema } from "@/mcp/tools/registry"
import type { TenantContext } from "@/services/auth/tenant-context"

/**
 * Every Maple MCP tool's name/description/schema exposed to a model WITHOUT an
 * `execute`. The model emits tool calls but the AI SDK never runs them, so
 * tool-selection evals need no warehouse, tenant, or runtime — just the registry.
 */
export const buildPredictionToolSet = (): ToolSet =>
	Object.fromEntries(
		mapleToolCatalog.map((definition) => [
			definition.name,
			tool({
				description: definition.description,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				inputSchema: jsonSchema(toInputSchema(definition.schema) as any),
			}),
		]),
	)

/**
 * Like `buildPredictionToolSet` but with a real `execute` that runs the tool
 * handler through the given runtime (which must provide the app services) and a
 * request layer (which carries the resolved tenant). Mirrors
 * apps/chat-agent/src/services/direct-tools.ts `createMapleAiTools`, but the
 * runtime is wired with a FAKE warehouse for full-execution evals.
 */
export const buildExecutionToolSet = (
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	runtime: ManagedRuntime.ManagedRuntime<any, never>,
	tenant: TenantContext,
): ToolSet =>
	Object.fromEntries(
		mapleToolCatalog.map((definition) => [
			definition.name,
			tool({
				description: definition.description,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				inputSchema: jsonSchema(toInputSchema(definition.schema) as any),
				execute: async (input: unknown) =>
					runtime.runPromise(
						McpToolExecutor.pipe(
							Effect.flatMap((executor) => executor.execute(tenant, definition.name, input, "mcp")),
						),
					),
			}),
		]),
	)
