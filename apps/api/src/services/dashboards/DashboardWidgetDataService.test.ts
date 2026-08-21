import { describe, expect, it } from "@effect/vitest"
import { DashboardDocument, DashboardId, IsoDateTimeString, OrgId } from "@maple/domain/http"
import { MAX_LIST_RANGE_SECONDS } from "@maple/query-engine"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { DashboardWidgetDataService } from "./DashboardWidgetDataService"

const asDashboardId = Schema.decodeUnknownSync(DashboardId)
const asIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)
const asOrgId = Schema.decodeUnknownSync(OrgId)

const ORG = asOrgId("org_share_widgets")
const NOW = asIsoDateTimeString(new Date("2026-01-01T00:00:00.000Z").toISOString())

const die = () => Effect.die("unexpected call")

/**
 * Records the window every executed query actually ran over, which is how the
 * clamp is asserted: the point is not that the resolver *reports* narrowing but
 * that the SQL it issued was narrowed.
 */
const makeHarness = (
	// Error channel is `unknown`, not `never`: a stub that fails is how the
	// execution-failure mapping is asserted, and pinning this to `never` forces
	// the caller into a cast at exactly the point the test is about.
	execute: (request: { startTime: string; endTime: string }) => Effect.Effect<unknown, unknown>,
) => {
	const windows: Array<{ startTime: string; endTime: string }> = []
	const queryEngine = Layer.succeed(QueryEngineService, {
		execute: (_tenant: unknown, request: { startTime: string; endTime: string }) => {
			windows.push({ startTime: request.startTime, endTime: request.endTime })
			return execute(request).pipe(Effect.map((result) => ({ result })))
		},
		evaluate: die,
		evaluateSeries: die,
		cachedDirect: die,
		// oxlint-disable-next-line typescript/no-explicit-any
	} as any)

	// oxlint-disable-next-line typescript/no-explicit-any
	const warehouse = Layer.succeed(WarehouseQueryService, { rawSqlQuery: die } as any)

	const runtime = ManagedRuntime.make(
		DashboardWidgetDataService.layer.pipe(Layer.provide(Layer.mergeAll(queryEngine, warehouse))),
	)
	return { runtime, windows }
}

const document = (widgets: ReadonlyArray<Record<string, unknown>>): DashboardDocument =>
	new DashboardDocument({
		id: asDashboardId("dash-share"),
		name: "Shared",
		timeRange: { type: "relative", value: "12h" },
		// oxlint-disable-next-line typescript/no-explicit-any
		widgets: widgets as any,
		createdAt: NOW,
		updatedAt: NOW,
	})

const widget = (id: string, dataSource: Record<string, unknown>) => ({
	id,
	visualization: "stat",
	dataSource,
	display: {},
	layout: { x: 0, y: 0, w: 3, h: 4 },
})

const WINDOW = { startTime: "2026-01-01 00:00:00", endTime: "2026-01-31 00:00:00" }

describe("DashboardWidgetDataService", () => {
	it("refuses a widget that is not on the document", async () => {
		const { runtime } = makeHarness(() => Effect.succeed({ kind: "list", data: [] }))

		const outcome = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolve(ORG, document([]), { widgetId: "nope", source: "primary" }, WINDOW, {}),
			).pipe(Effect.flip),
		)

		expect(outcome._tag).toBe("@maple/http/errors/ShareWidgetNotFoundError")
		await runtime.dispose()
	})

	it("serves a static tile as data-less success, not as an unsupported widget", async () => {
		const { runtime, windows } = makeHarness(() => Effect.succeed({ kind: "list", data: [] }))

		const outcome = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolve(
					ORG,
					document([widget("w-static", { kind: "static" })]),
					{ widgetId: "w-static", source: "primary" },
					WINDOW,
					{},
				),
			),
		)

		expect(outcome.data).toBeNull()
		// A markdown tile must not reach the warehouse at all.
		expect(windows).toHaveLength(0)
		await runtime.dispose()
	})

	it("refuses a route endpoint that has no server-side plan", async () => {
		const { runtime } = makeHarness(() => Effect.succeed({ kind: "list", data: [] }))

		const outcome = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolve(
					ORG,
					document([widget("w-facets", { kind: "route", endpoint: "traces_facets", params: {} })]),
					{ widgetId: "w-facets", source: "primary" },
					WINDOW,
					{},
				),
			).pipe(Effect.flip),
		)

		// The allowlist is the point: an endpoint nobody deliberately enabled for
		// sharing is refused rather than served through some generic fallback.
		expect(outcome._tag).toBe("@maple/http/errors/ShareUnsupportedWidgetError")
		expect(outcome).toMatchObject({ widgetId: "w-facets", kind: "traces_facets" })
		await runtime.dispose()
	})

	it("reports a query that ran and failed as retryable, not as unsupported", async () => {
		// The distinction is the whole point: "unsupported" draws a permanent muted
		// tile, so a warehouse timeout landing there tells a viewer the chart will
		// never work and offers them no retry.
		const { runtime } = makeHarness(() => Effect.fail("warehouse timeout"))

		const outcome = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolve(
					ORG,
					document([
						widget("w-chart", {
							kind: "query",
							resultShape: "timeseries",
							queries: [{ id: "q1", name: "A", aggregation: "count", dataSource: "traces" }],
						}),
					]),
					{ widgetId: "w-chart", source: "primary" },
					WINDOW,
					{},
				),
			).pipe(Effect.flip),
		)

		expect(outcome._tag).toBe("@maple/http/errors/ShareWidgetExecutionError")
		expect(outcome).toMatchObject({ widgetId: "w-chart" })
		await runtime.dispose()
	})

	it("keeps a defect inside the per-widget envelope", async () => {
		// A driver throwing on an unexpected row shape is a defect, not a failure,
		// and an escaping defect 500s the whole batch — blanking every other tile
		// on the board, which is exactly what the envelope exists to prevent.
		const { runtime } = makeHarness(() => Effect.die("driver threw"))

		const outcome = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolve(
					ORG,
					document([
						widget("w-chart", {
							kind: "query",
							resultShape: "timeseries",
							queries: [{ id: "q1", name: "A", aggregation: "count", dataSource: "traces" }],
						}),
					]),
					{ widgetId: "w-chart", source: "primary" },
					WINDOW,
					{},
				),
			).pipe(Effect.flip),
		)

		expect(outcome._tag).toBe("@maple/http/errors/ShareWidgetExecutionError")
		await runtime.dispose()
	})

	it("clamps a list widget's window before issuing the query", async () => {
		const { runtime, windows } = makeHarness(() =>
			Effect.succeed({ kind: "list", data: [], meta: { columns: [] } }),
		)

		const outcome = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolve(
					ORG,
					document([
						widget("w-list", {
							kind: "query",
							resultShape: "list",
							queries: [{ id: "q1", name: "A", aggregation: "count", dataSource: "traces" }],
						}),
					]),
					{ widgetId: "w-list", source: "primary" },
					// 30 days, well past the raw-row list ceiling.
					WINDOW,
					{},
				),
			),
		)

		expect(outcome.narrowedToSeconds).toBe(MAX_LIST_RANGE_SECONDS)

		// The clamp has to reach the SQL, not just the response envelope — a
		// resolver that reported narrowing while still scanning 30 days would be
		// the exact bug this asserts against.
		expect(windows.length).toBeGreaterThan(0)
		const executed = windows[0]!
		const spanSeconds = (Date.parse(`${executed.endTime}Z`) - Date.parse(`${executed.startTime}Z`)) / 1000
		expect(spanSeconds).toBe(MAX_LIST_RANGE_SECONDS)
		expect(executed.endTime).toBe(WINDOW.endTime)

		await runtime.dispose()
	})

	it("leaves a chart widget's window alone", async () => {
		const { runtime, windows } = makeHarness(() =>
			Effect.succeed({
				kind: "timeseries",
				data: [{ bucket: "2026-01-01 00:00:00", series: { A: 1 } }],
			}),
		)

		const outcome = await runtime.runPromise(
			DashboardWidgetDataService.use((service) =>
				service.resolve(
					ORG,
					document([
						widget("w-chart", {
							kind: "query",
							resultShape: "timeseries",
							queries: [{ id: "q1", name: "A", aggregation: "count", dataSource: "traces" }],
						}),
					]),
					{ widgetId: "w-chart", source: "primary" },
					WINDOW,
					{},
				),
			),
		)

		expect(outcome.narrowedToSeconds).toBeUndefined()
		expect(windows[0]).toMatchObject({ startTime: WINDOW.startTime, endTime: WINDOW.endTime })
		await runtime.dispose()
	})
})
