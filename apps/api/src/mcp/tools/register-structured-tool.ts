import type { StructuredToolOutput } from "@maple/domain"
import { chatToolMetadata } from "@maple/domain"
import { Effect, Schema } from "effect"
import { createStructuredToolResult } from "../lib/structured-output"
import type { McpToolError, McpToolRegistrar } from "./types"

type StructuredToolName = Exclude<
  keyof typeof chatToolMetadata,
  "add_dashboard_widget" | "remove_dashboard_widget"
>

export function registerStructuredTool<
  TName extends StructuredToolName,
  TSchema extends Schema.Top & { readonly DecodingServices: never },
  TResult extends Extract<StructuredToolOutput, { tool: TName }>,
>(
  server: McpToolRegistrar,
  name: TName,
  schema: TSchema,
  execute: (params: Schema.Schema.Type<TSchema>) => Effect.Effect<TResult, McpToolError, unknown>,
): void {
  server.tool(
    name,
    chatToolMetadata[name].description,
    schema,
    (params) => execute(params).pipe(Effect.map(createStructuredToolResult)),
  )
}
