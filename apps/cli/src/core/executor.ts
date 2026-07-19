import { Effect, Schema } from "effect"
import { OrgId, UserId } from "@maple/domain/http"
import { makeWarehouseExecutor, type WarehouseSqlClient } from "@maple/query-engine/execution"
import type { WarehouseExecutorShape } from "@maple/query-engine/observability"
import { executeLocalQuery } from "@maple/query-engine/local"
import { debugLog } from "../lib/debug"

// Local mode is single-tenant: the local binary writes every row under this
// OrgId, and every compiled query filters on it. `OrgId` is a non-empty trimmed
// branded string, so "local" decodes cleanly (no cast needed).
const LOCAL_ORG_ID = Schema.decodeUnknownSync(OrgId)("local")
const LOCAL_USER_ID = Schema.decodeUnknownSync(UserId)("local")

const LOCAL_TENANT = { orgId: LOCAL_ORG_ID, userId: LOCAL_USER_ID, authMode: "local" }

// The chDB driver: POST `/local/query` on the local binary. Runs the SQL,
// timing the round-trip and (under --debug) printing the SQL + elapsed ms to
// stderr. The `finally` logs even on failure so a failing query still shows
// its SQL.
const localChdbClient = (baseUrl: string): WarehouseSqlClient => ({
	sql: async (sql) => {
		const started = performance.now()
		try {
			return { data: await executeLocalQuery<Record<string, unknown>>(sql, baseUrl) }
		} finally {
			debugLog(`local query · ${Math.round(performance.now() - started)}ms`, sql)
		}
	},
	insert: async () => {
		// Local mode ingests via OTLP into the embedded chDB, never through the
		// warehouse `ingest` path.
		throw new Error("local mode is read-only through the warehouse executor — ingest via OTLP")
	},
})

/**
 * A `WarehouseExecutor` backed by the local Maple binary's `/local/query`
 * endpoint — the REAL `makeWarehouseExecutor` from `@maple/query-engine`
 * (spans, error classification, OrgId scoping) with a chDB client and a
 * constant single-tenant route injected. The `chdb` backend dialect strips the
 * trailing `FORMAT` (the local server owns the output format) and skips
 * Tinybird's restricted-settings policy.
 *
 * This makes every `@maple/query-engine/observability` function — which only
 * depends on a `WarehouseExecutor` — work unchanged against local mode, with
 * the same `warehouse.backend="chdb"` span contract as the cloud.
 */
export const makeLocalWarehouseExecutorShape = (baseUrl: string): WarehouseExecutorShape =>
	makeWarehouseExecutor({
		createClient: () => localChdbClient(baseUrl),
		resolveRoute: () =>
			Effect.succeed({
				source: "managed" as const,
				config: {
					kind: "chdb" as const,
					url: baseUrl,
					username: "",
					password: "",
					database: "default",
				},
				clientCacheKey: "local",
			}),
	}).asExecutor(LOCAL_TENANT)
