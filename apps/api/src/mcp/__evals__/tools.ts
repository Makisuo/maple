import { jsonSchema, tool, type ToolSet } from "ai"
import { Effect, Layer, Schema, type ManagedRuntime } from "effect"
import { mapleToolDefinitions, toInputSchema } from "@/mcp/tools/registry"

/**
 * Every Maple MCP tool's name/description/schema exposed to a model WITHOUT an
 * `execute`. The model emits tool calls but the AI SDK never runs them, so
 * tool-selection evals need no warehouse, tenant, or runtime — just the registry.
 */
export const buildPredictionToolSet = (): ToolSet =>
	Object.fromEntries(
		mapleToolDefinitions.map((definition) => [
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
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	requestLayer: Layer.Layer<any>,
): ToolSet =>
	Object.fromEntries(
		mapleToolDefinitions.map((definition) => [
			definition.name,
			tool({
				description: definition.description,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				inputSchema: jsonSchema(toInputSchema(definition.schema) as any),
				execute: async (input: unknown) => {
					const decoded = Schema.decodeUnknownSync(definition.schema)(input)
					return runtime.runPromise(definition.handler(decoded).pipe(Effect.provide(requestLayer)))
				},
			}),
		]),
	)
