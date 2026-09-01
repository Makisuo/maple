import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Database } from "@/platform/DatabaseLive"
import type { PgConnectionScopeApi } from "@/platform/pg-connection-scope"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "@/platform/test-pglite"
import {
	loadOptionalFeatureState,
	runWithDb,
	type WorkflowStepLike,
} from "./ClickHouseSchemaApplyWorkflow.run"

describe("loadOptionalFeatureState", () => {
	const successfulReads = {
		readServerVersion: async () => "26.2.1",
		readAppliedFeatureRevisions: async () => new Map([["search_text_v1", 1]]),
	}

	it("turns feature bookkeeping creation failure into an unavailable optional state", async () => {
		const state = await loadOptionalFeatureState({
			...successfulReads,
			ensureBookkeeping: async () => {
				throw new Error("CREATE TABLE denied")
			},
		})

		expect(state).toEqual({ available: false, reason: "CREATE TABLE denied" })
	})

	it("turns feature bookkeeping read failure into an unavailable optional state", async () => {
		const state = await loadOptionalFeatureState({
			...successfulReads,
			ensureBookkeeping: async () => {},
			readAppliedFeatureRevisions: async () => {
				throw new Error("SELECT denied")
			},
		})

		expect(state).toEqual({ available: false, reason: "SELECT denied" })
	})

	it("returns the server and applied revisions only after every optional read succeeds", async () => {
		const state = await loadOptionalFeatureState({
			...successfulReads,
			ensureBookkeeping: async () => {},
		})

		expect(state.available).toBe(true)
		if (state.available) {
			expect(state.serverVersion).toBe("26.2.1")
			expect([...state.appliedFeatureRevisions]).toEqual([["search_text_v1", 1]])
		}
	})
})

describe("runWithDb failure bookkeeping", () => {
	const trackedDbs: TestDb[] = []
	afterEach(() => cleanupTestDbs(trackedDbs))

	/** Runs each durable step's callback directly — no retries, no persistence. */
	const inlineStep: WorkflowStepLike = {
		do: <T>(
			_name: string,
			configOrCallback: { retries?: unknown } | (() => Promise<T>),
			callback?: () => Promise<T>,
		): Promise<T> => {
			if (typeof configOrCallback === "function") return configOrCallback()
			if (callback === undefined) return Promise.reject(new Error("missing step callback"))
			return callback()
		},
	}

	it("marks the run failed when config loading fails, instead of leaving it queued", async () => {
		const testDb = createTestDb(trackedDbs)
		const database = await Effect.runPromise(Effect.provide(Database, testDb.layer))
		const connection: PgConnectionScopeApi = {
			run: (fn) => database.execute(fn),
			close: () => Promise.resolve(),
		}
		// A queued claim exists, but the org's settings row does not (deleted
		// after queueing) — loadConfig throws before any migration work starts.
		await executeSql(
			testDb,
			`INSERT INTO org_clickhouse_schema_apply_runs (org_id, status, phase, created_at, updated_at)
			 VALUES ('org_wf_cfg', 'queued', 'queued', now(), now())`,
		)

		await expect(
			runWithDb(
				connection,
				{ MAPLE_DB: null, MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64") },
				{ payload: { orgId: "org_wf_cfg" } },
				inlineStep,
			),
		).rejects.toThrow("No ClickHouse settings configured")

		// Without the failed transition, OrgClickHouseSettingsService reads the
		// leftover "queued" as already_running forever.
		const row = await queryFirstRow<{ status: string; error_message: string | null }>(
			testDb,
			"SELECT status, error_message FROM org_clickhouse_schema_apply_runs WHERE org_id = 'org_wf_cfg'",
		)
		expect(row?.status).toBe("failed")
		expect(row?.error_message).toContain("No ClickHouse settings configured")
	})
})
