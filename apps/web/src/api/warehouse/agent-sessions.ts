import { Clock, Effect, Schema } from "effect"
import {
	AgentSessionsFacetsRequest,
	AgentSessionsListRequest,
	AgentTracesListRequest,
} from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"
import { formatWarehouseDateTime } from "@maple/query-engine"

// Agent Sessions (AI-classified spans) — throwaway product-scratchpad feature.
// Thin pass-throughs to /internal/agent-sessions; the durable read interface is
// @maple/query-engine/observability, which those routes adapt.

const AgentSessionsFilterInput = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	vendors: Schema.optional(Schema.Array(Schema.String)),
	serviceNames: Schema.optional(Schema.Array(Schema.String)),
	hasErrors: Schema.optional(Schema.Boolean),
})

const ListAgentSessionsInput = Schema.Struct({
	...AgentSessionsFilterInput.fields,
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
})
export type ListAgentSessionsInput = Schema.Schema.Type<typeof ListAgentSessionsInput>

const AgentSessionsFacetsInput = Schema.Struct({
	...AgentSessionsFilterInput.fields,
	tab: Schema.Literals(["sessions", "traces"]),
})
export type AgentSessionsFacetsInput = Schema.Schema.Type<typeof AgentSessionsFacetsInput>

const defaultTimeRange = (nowMs: number) => ({
	startTime: formatWarehouseDateTime(nowMs - 24 * 60 * 60 * 1000),
	endTime: formatWarehouseDateTime(nowMs),
})

export const listAgentSessions = Effect.fn("AgentSessions.list")(function* ({
	data,
}: {
	data: ListAgentSessionsInput
}) {
	const input = yield* decodeInput(ListAgentSessionsInput, data ?? {}, "listAgentSessions")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("listAgentSessions", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.agentSessionsInternal.list({
				payload: new AgentSessionsListRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					vendors: input.vendors,
					serviceNames: input.serviceNames,
					hasErrors: input.hasErrors,
					limit: input.limit ?? 50,
					offset: input.offset ?? 0,
				}),
			})
		}),
	)
	return { data: result.data }
})

export const listAgentTraces = Effect.fn("AgentSessions.traces")(function* ({
	data,
}: {
	data: ListAgentSessionsInput
}) {
	const input = yield* decodeInput(ListAgentSessionsInput, data ?? {}, "listAgentTraces")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("listAgentTraces", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.agentSessionsInternal.traces({
				payload: new AgentTracesListRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					vendors: input.vendors,
					serviceNames: input.serviceNames,
					hasErrors: input.hasErrors,
					limit: input.limit ?? 50,
					offset: input.offset ?? 0,
				}),
			})
		}),
	)
	return { data: result.data }
})

export const getAgentSessionsFacets = Effect.fn("AgentSessions.facets")(function* ({
	data,
}: {
	data: AgentSessionsFacetsInput
}) {
	const input = yield* decodeInput(AgentSessionsFacetsInput, data ?? {}, "agentSessionsFacets")
	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("agentSessionsFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.agentSessionsInternal.facets({
				payload: new AgentSessionsFacetsRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					vendors: input.vendors,
					serviceNames: input.serviceNames,
					hasErrors: input.hasErrors,
					tab: input.tab,
				}),
			})
		}),
	)
	return { vendors: result.vendors, services: result.services, errorCount: result.errorCount }
})
