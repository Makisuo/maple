import { assert, describe, expect, it } from "@effect/vitest"
import { Context, Effect, Schema, Tracer } from "effect"
import type { InternalRpcToolNotFoundError } from "@maple/domain/internal-rpc"
import { McpToolExecutor, listMcpTools } from "./dispatcher"
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "./expected-failures"
import { mapleToolCatalog, toInputSchema } from "./tools/registry"
import type { McpToolRuntimeRequirements } from "./tools/runtime-requirements"
import type { TenantContext } from "@/services/auth/tenant-context"
import { AuditLogService, makeMemoryAuditLog } from "@/services/audit/AuditLogService"

const TENANT: TenantContext = {
	orgId: "org_test" as TenantContext["orgId"],
	userId: "user_test" as TenantContext["userId"],
	roles: [],
	authMode: "self_hosted",
}

// These cases stop at registry lookup/schema decoding, before a tool service is read.
const makeValidationExecutor = McpToolExecutor.make.pipe(
	// Every tool call is audited, so the executor needs the audit service even here.
	Effect.provide(Context.make(AuditLogService, makeMemoryAuditLog()) as Context.Context<McpToolRuntimeRequirements>),
)

const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

describe("MCP dispatcher", () => {
	it("publishes an object input schema for every tool", () => {
		// Strict MCP clients (the Vercel AI SDK's `tools/list` validator) drop the
		// WHOLE connection when any tool's inputSchema.type is not "object" — the
		// offending tool names are collected so a failure names them.
		const invalidSchemas = mapleToolCatalog
			.map((definition) => ({
				name: definition.name,
				type: toInputSchema(definition.schema).type,
			}))
			.filter(({ type }) => type !== "object")

		expect(invalidSchemas).toEqual([])
	})

	it.effect("publishes the same names, descriptions, and schemas used by HTTP MCP", () =>
		Effect.gen(function* () {
			const descriptors = yield* listMcpTools
			expect(descriptors).toEqual(
				mapleToolCatalog.map((definition) => ({
					name: definition.name,
					description: definition.description,
					inputSchema: toInputSchema(definition.schema),
				})),
			)
		}),
	)

	it("normalizes an empty Struct root and rejects a non-object root", () => {
		// Effect emits `{ anyOf: [{type:"object"},{type:"array"}] }` — no `type` —
		// for a no-parameter tool; that exact shape is normalized.
		expect(toInputSchema(Schema.Struct({}))).toEqual({
			type: "object",
			properties: {},
			additionalProperties: false,
		})

		// Anything else with a non-object root has parameters an empty object
		// schema would erase, so registration fails loudly instead.
		expect(() => toInputSchema(Schema.Literals(["a", "b"]))).toThrow(/object root/)
		expect(() => toInputSchema(Schema.Array(Schema.String))).toThrow(/object root/)
	})

	it.effect("returns MCP validation feedback for invalid model tool input", () =>
		Effect.gen(function* () {
			const executor = yield* makeValidationExecutor
			const result = yield* executor.execute(TENANT, "inspect_trace", {}, "mcp")
			expect(result.isError).toBe(true)
			expect(result.content[0]?.text).toContain("Invalid parameters")
			expect(result.content[0]?.text).toContain("inspect_trace")
		}),
	)

	it.effect("fails unknown RPC tool names with a typed error", () =>
		Effect.gen(function* () {
			const executor = yield* makeValidationExecutor
			const error = yield* Effect.flip(
				executor.execute(TENANT, "not_a_maple_tool", {}, "mcp") as Effect.Effect<
					never,
					InternalRpcToolNotFoundError,
					never
				>,
			)
			expect(error._tag).toBe("@maple/internal-rpc/ToolNotFoundError")
			expect(error.name).toBe("not_a_maple_tool")
		}),
	)

	// Before these attributes existed the tool name lived only in a log annotation,
	// so every usage query had to recover it from the per-handler span NAME with
	// `substring(SpanName, 9)`, and the calling surface was not recoverable at all.
	describe("tool-call attribution", () => {
		it.effect("records the tool and surface on the executor span", () =>
			Effect.gen(function* () {
				const executor = yield* makeValidationExecutor
				const { spans, tracer } = makeRecordingTracer()

				yield* executor
					.execute(TENANT, "inspect_trace", {}, "workflow")
					.pipe(Effect.withTracer(tracer))

				const executorSpan = spans.find((s) => s.name === "McpToolExecutor.execute")
				assert.isDefined(executorSpan)
				expect(executorSpan.attributes.get("maple.mcp.tool")).toBe("inspect_trace")
				expect(executorSpan.attributes.get("maple.mcp.surface")).toBe("workflow")
			}),
		)

		it.effect("marks a failed tool call on the dispatcher span", () =>
			Effect.gen(function* () {
				const executor = yield* makeValidationExecutor
				const { spans, tracer } = makeRecordingTracer()

				// Empty input fails schema decoding, which the dispatcher converts into
				// an in-band `isError` result rather than an error-channel failure — so
				// span STATUS stays Ok and only this attribute records the outcome.
				const result = yield* executor
					.execute(TENANT, "inspect_trace", {}, "mcp")
					.pipe(Effect.withTracer(tracer))
				expect(result.isError).toBe(true)

				const dispatchSpan = spans.find((s) => s.name === "McpToolDispatcher.call")
				assert.isDefined(dispatchSpan)
				expect(dispatchSpan.attributes.get("maple.mcp.tool")).toBe("inspect_trace")
				expect(dispatchSpan.attributes.get("result.isError")).toBe(true)
			}),
		)

		// Expected 4xx (bad parameters, bad credentials) must not be Error spans —
		// only 5xx is, per CLAUDE.md. Prod was recording `@maple/mcp/decode-error`
		// and `McpAuthInvalidError` as Error status + exception events.
		it.effect("records an expected 4xx as span attributes and a Warn log, not an error", () =>
			Effect.gen(function* () {
				const executor = yield* makeValidationExecutor
				const { spans, tracer } = makeRecordingTracer()

				yield* executor.execute(TENANT, "inspect_trace", {}, "mcp").pipe(Effect.withTracer(tracer))

				const dispatchSpan = spans.find((s) => s.name === "McpToolDispatcher.call")
				assert.isDefined(dispatchSpan)
				expect(dispatchSpan.attributes.get("error.type")).toBe("@maple/mcp/decode-error")
				expect(dispatchSpan.attributes.get("http.response.status_code")).toBe(400)

				// The inner registry span still FAILS with the decode error (the typed
				// error stays in the error channel); the SDK exporter is what turns it
				// into an Ok span, keyed off the identifier list below.
				const registrySpan = spans.find((s) => s.name === "McpToolRegistry.execute")
				assert.isDefined(registrySpan)
				expect(MCP_ANTICIPATED_ERROR_IDENTIFIERS).toContain("@maple/mcp/decode-error")
			}),
		)

		it("lists both MCP auth failures as anticipated so their spans export as Ok", () => {
			// `@maple/domain/anticipated-errors` derives its set from domain HTTP
			// exports and cannot see these apps/api classes.
			expect(MCP_ANTICIPATED_ERROR_IDENTIFIERS).toEqual(
				expect.arrayContaining([
					"@maple/mcp/errors/McpAuthMissingError",
					"@maple/mcp/errors/McpAuthInvalidError",
				]),
			)
			// Genuine failures must keep their Error spans.
			expect(MCP_ANTICIPATED_ERROR_IDENTIFIERS).not.toContain(
				"@maple/mcp/errors/McpAuthUnavailableError",
			)
			expect(MCP_ANTICIPATED_ERROR_IDENTIFIERS).not.toContain("@maple/mcp/errors/McpQueryError")
		})

		it.effect("records result.isError as false for a call that succeeds", () =>
			Effect.gen(function* () {
				const executor = yield* makeValidationExecutor
				const { spans, tracer } = makeRecordingTracer()

				// `describe_warehouse_tables` reads a static catalog — no warehouse — so it
				// reaches a real result under the empty runtime context.
				yield* executor
					.execute(TENANT, "describe_warehouse_tables", {}, "rpc")
					.pipe(Effect.withTracer(tracer))

				const dispatchSpan = spans.find((s) => s.name === "McpToolDispatcher.call")
				assert.isDefined(dispatchSpan)
				expect(dispatchSpan.attributes.get("result.isError")).toBe(false)
			}),
		)
	})
})
