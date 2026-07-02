import { randomBytes } from "node:crypto"

const SERVICES = ["demo-api", "demo-frontend", "demo-worker", "demo-db"] as const
type DemoServiceName = (typeof SERVICES)[number]

const HTTP_ROUTES: Array<{ method: string; route: string; service: DemoServiceName }> = [
	{ method: "GET", route: "/api/users", service: "demo-api" },
	{ method: "GET", route: "/api/users/:id", service: "demo-api" },
	{ method: "POST", route: "/api/users", service: "demo-api" },
	{ method: "GET", route: "/api/orders", service: "demo-api" },
	{ method: "POST", route: "/api/orders", service: "demo-api" },
	{ method: "GET", route: "/api/products", service: "demo-api" },
	{ method: "GET", route: "/", service: "demo-frontend" },
	{ method: "GET", route: "/dashboard", service: "demo-frontend" },
	{ method: "GET", route: "/checkout", service: "demo-frontend" },
]

const DB_QUERIES = [
	"SELECT * FROM users WHERE id = $1",
	"SELECT * FROM orders WHERE user_id = $1",
	"INSERT INTO orders (user_id, total) VALUES ($1, $2)",
	"SELECT * FROM products LIMIT 50",
	"UPDATE users SET last_seen = NOW() WHERE id = $1",
]

const WORKER_JOBS = ["send_email", "process_payment", "sync_inventory", "generate_report", "refresh_cache"]

// ---------------------------------------------------------------------------
// Demo data is written straight to the `traces` / `logs` datasources via
// WarehouseQueryService.ingest (bypassing the billing-enforced ingest gateway),
// so each row must match those datasources' ingestion JSON — the OpenTelemetry
// Collector Tinybird exporter shape (snake_case keys, jsonPath-mapped). See
// packages/domain/src/tinybird/datasources.ts.
//
// Org scoping is derived from `resource_attributes.maple_org_id`, so every row
// MUST carry it. `SampleRate` / `IsEntryPoint` are computed by datasource
// DEFAULT expressions, so they are intentionally omitted here.
// ---------------------------------------------------------------------------

type Attrs = Record<string, string>

/** One row in the `traces` datasource (collector Tinybird exporter shape). */
interface TraceRow {
	start_time: string
	trace_id: string
	span_id: string
	parent_span_id: string
	trace_state: string
	span_name: string
	span_kind: string
	service_name: string
	resource_schema_url: string
	resource_attributes: Attrs
	scope_schema_url: string
	scope_name: string
	scope_version: string
	scope_attributes: Attrs
	duration: number
	status_code: string
	status_message: string
	span_attributes: Attrs
	events_timestamp: string[]
	events_name: string[]
	events_attributes: Attrs[]
	links_trace_id: string[]
	links_span_id: string[]
	links_trace_state: string[]
	links_attributes: Attrs[]
}

/** One row in the `logs` datasource (collector Tinybird exporter shape). */
interface LogRow {
	timestamp: string
	trace_id: string
	span_id: string
	flags: number
	severity_text: string
	severity_number: number
	service_name: string
	body: string
	resource_schema_url: string
	resource_attributes: Attrs
	scope_schema_url: string
	scope_name: string
	scope_version: string
	scope_attributes: Attrs
	log_attributes: Attrs
}

/**
 * One row in the `metrics_gauge` datasource (collector Tinybird exporter
 * shape — see metricsGauge in packages/domain/src/tinybird/datasources.ts).
 */
interface MetricGaugeRow {
	timestamp: string
	start_timestamp: string
	metric_name: string
	metric_description: string
	metric_unit: string
	metric_attributes: Attrs
	service_name: string
	resource_schema_url: string
	resource_attributes: Attrs
	scope_schema_url: string
	scope_name: string
	scope_version: string
	scope_attributes: Attrs
	value: number
	flags: number
	exemplars_trace_id: string[]
	exemplars_span_id: string[]
	exemplars_timestamp: string[]
	exemplars_value: number[]
	exemplars_filtered_attributes: Attrs[]
}

/** One row in the `metrics_sum` datasource. */
interface MetricSumRow extends MetricGaugeRow {
	aggregation_temporality: number
	is_monotonic: boolean
}

interface DemoTraceBatch {
	traceRows: TraceRow[]
	logRows: LogRow[]
}

export interface DemoRows extends DemoTraceBatch {
	metricGaugeRows: MetricGaugeRow[]
	metricSumRows: MetricSumRow[]
}

const SCOPE_NAME = "@maple/demo-instr"

const traceIdHex = () => randomBytes(16).toString("hex")
const spanIdHex = () => randomBytes(8).toString("hex")

function pick<T>(arr: readonly T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]!
}

function gaussian(mean: number, stddev: number): number {
	const u1 = Math.random()
	const u2 = Math.random()
	const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
	return mean + z * stddev
}

function latencyMs(): number {
	const base = Math.max(5, gaussian(60, 40))
	if (Math.random() < 0.05) return base + Math.random() * 800
	return base
}

function dbLatencyMs(): number {
	return Math.max(1, gaussian(8, 5))
}

// ClickHouse DateTime64 wire format: "YYYY-MM-DD HH:MM:SS.mmm" in UTC.
const fmtTs = (epochMs: number) => new Date(epochMs).toISOString().replace("T", " ").replace("Z", "")

const resourceAttrs = (service: DemoServiceName, orgId: string): Attrs => ({
	maple_org_id: orgId,
	"service.name": service,
	"service.version": "1.0.0",
	"deployment.environment": "production",
	"telemetry.sdk.name": "maple-demo",
	"telemetry.sdk.language": "nodejs",
	"maple.demo": "true",
})

const makeTraceRow = (
	over: Partial<TraceRow> & {
		start_time: string
		trace_id: string
		span_id: string
		span_name: string
		span_kind: string
		service_name: string
		duration: number
		status_code: string
		resource_attributes: Attrs
		span_attributes: Attrs
	},
): TraceRow => ({
	parent_span_id: "",
	trace_state: "",
	resource_schema_url: "",
	scope_schema_url: "",
	scope_name: SCOPE_NAME,
	scope_version: "",
	scope_attributes: {},
	status_message: "",
	events_timestamp: [],
	events_name: [],
	events_attributes: [],
	links_trace_id: [],
	links_span_id: [],
	links_trace_state: [],
	links_attributes: [],
	...over,
})

const makeLogRow = (
	over: Partial<LogRow> & {
		timestamp: string
		severity_text: string
		severity_number: number
		service_name: string
		body: string
		resource_attributes: Attrs
	},
): LogRow => ({
	trace_id: "",
	span_id: "",
	flags: 0,
	resource_schema_url: "",
	scope_schema_url: "",
	scope_name: SCOPE_NAME,
	scope_version: "",
	scope_attributes: {},
	log_attributes: {},
	...over,
})

function generateHttpTrace(timestamp: Date, orgId: string): DemoTraceBatch {
	const route = pick(HTTP_ROUTES)
	const traceId = traceIdHex()
	const rootSpanId = spanIdHex()
	const dbSpanId = spanIdHex()

	const isError = Math.random() < 0.012
	const totalLatency = latencyMs() + (isError ? 100 : 0)
	const dbLatency = Math.min(totalLatency * 0.6, dbLatencyMs())
	const startMs = timestamp.getTime()
	const endMs = startMs + totalLatency
	const dbStartMs = startMs + Math.floor((totalLatency - dbLatency) / 2)

	const httpStatus = isError ? (Math.random() < 0.5 ? 500 : 503) : Math.random() < 0.04 ? 404 : 200

	const apiRow = makeTraceRow({
		start_time: fmtTs(startMs),
		trace_id: traceId,
		span_id: rootSpanId,
		span_name: `${route.method} ${route.route}`,
		span_kind: "Server",
		service_name: route.service,
		duration: Math.round(totalLatency * 1_000_000),
		status_code: isError ? "Error" : "Ok",
		status_message: isError ? "Internal server error" : "",
		resource_attributes: resourceAttrs(route.service, orgId),
		span_attributes: {
			"http.method": route.method,
			"http.route": route.route,
			"http.status_code": String(httpStatus),
			"http.scheme": "https",
			"http.host": "api.demo.maple.dev",
			"net.peer.name": "client",
			"maple.demo": "true",
		},
		...(isError
			? {
					events_timestamp: [fmtTs(endMs)],
					events_name: ["exception"],
					events_attributes: [
						{
							"exception.type": "ConnectionResetError",
							"exception.message": `Unhandled error in ${route.method} ${route.route}: connection reset`,
						},
					],
				}
			: {}),
	})

	const dbRow = makeTraceRow({
		start_time: fmtTs(dbStartMs),
		trace_id: traceId,
		span_id: dbSpanId,
		parent_span_id: rootSpanId,
		span_name: "pg.query",
		span_kind: "Client",
		service_name: "demo-db",
		duration: Math.round(dbLatency * 1_000_000),
		status_code: "Ok",
		resource_attributes: resourceAttrs("demo-db", orgId),
		span_attributes: {
			"db.system": "postgresql",
			"db.statement": pick(DB_QUERIES),
			"db.name": "demo",
			"maple.demo": "true",
		},
	})

	const logRows: LogRow[] = []
	if (isError) {
		logRows.push(
			makeLogRow({
				timestamp: fmtTs(endMs),
				trace_id: traceId,
				span_id: rootSpanId,
				severity_text: "Error",
				severity_number: 17,
				service_name: route.service,
				body: `Unhandled error in ${route.method} ${route.route}: connection reset`,
				resource_attributes: resourceAttrs(route.service, orgId),
				log_attributes: {
					"http.route": route.route,
					"error.type": "ConnectionResetError",
					"maple.demo": "true",
				},
			}),
		)
	}

	return { traceRows: [apiRow, dbRow], logRows }
}

function generateWorkerTrace(timestamp: Date, orgId: string): DemoTraceBatch {
	const job = pick(WORKER_JOBS)
	const traceId = traceIdHex()
	const spanId = spanIdHex()
	const isError = Math.random() < 0.008
	const total = Math.max(20, gaussian(180, 90)) + (isError ? 50 : 0)
	const startMs = timestamp.getTime()
	const endMs = startMs + total

	const row = makeTraceRow({
		start_time: fmtTs(startMs),
		trace_id: traceId,
		span_id: spanId,
		span_name: `worker.${job}`,
		span_kind: "Internal",
		service_name: "demo-worker",
		duration: Math.round(total * 1_000_000),
		status_code: isError ? "Error" : "Ok",
		status_message: isError ? "Job processing failed" : "",
		resource_attributes: resourceAttrs("demo-worker", orgId),
		span_attributes: {
			"messaging.operation": "process",
			"messaging.system": "demo-queue",
			"job.name": job,
			"maple.demo": "true",
		},
		...(isError
			? {
					events_timestamp: [fmtTs(endMs)],
					events_name: ["exception"],
					events_attributes: [
						{
							"exception.type": "JobProcessingError",
							"exception.message": `worker.${job} failed`,
						},
					],
				}
			: {}),
	})

	return { traceRows: [row], logRows: [] }
}

// ---------------------------------------------------------------------------
// Demo runtime metrics — Node.js process gauges/counters for demo-api and
// demo-worker, one point per service per minute. These make the metric-based
// dashboard templates (Node.js Runtime, Metric Overview) show real data
// instead of rendering empty against demo orgs.
// ---------------------------------------------------------------------------

const METRIC_SERVICES = ["demo-api", "demo-worker"] as const satisfies readonly DemoServiceName[]
const METRIC_INTERVAL_MS = 60_000

const makeMetricBase = (service: DemoServiceName, orgId: string, startMs: number, tsMs: number) => ({
	timestamp: fmtTs(tsMs),
	start_timestamp: fmtTs(startMs),
	metric_description: "",
	metric_attributes: { "maple.demo": "true" } as Attrs,
	service_name: service,
	resource_schema_url: "",
	resource_attributes: resourceAttrs(service, orgId),
	scope_schema_url: "",
	scope_name: SCOPE_NAME,
	scope_version: "",
	scope_attributes: {} as Attrs,
	flags: 0,
	exemplars_trace_id: [] as string[],
	exemplars_span_id: [] as string[],
	exemplars_timestamp: [] as string[],
	exemplars_value: [] as number[],
	exemplars_filtered_attributes: [] as Attrs[],
})

function generateRuntimeMetrics(
	orgId: string,
	startMs: number,
	endMs: number,
): { metricGaugeRows: MetricGaugeRow[]; metricSumRows: MetricSumRow[] } {
	const metricGaugeRows: MetricGaugeRow[] = []
	const metricSumRows: MetricSumRow[] = []

	for (const [serviceIdx, service] of METRIC_SERVICES.entries()) {
		// Cumulative monotonic GC counter, per service.
		let gcCount = 0
		let point = 0
		for (let tsMs = startMs; tsMs <= endMs; tsMs += METRIC_INTERVAL_MS, point++) {
			const base = makeMetricBase(service, orgId, startMs, tsMs)
			// Slow sine around ~120MB with per-service phase offset + jitter.
			const heapUsed =
				120e6 + 30e6 * Math.sin(point / 20 + serviceIdx * 1.7) + (Math.random() - 0.5) * 8e6
			metricGaugeRows.push({
				...base,
				metric_name: "process.runtime.nodejs.memory.heap.used",
				metric_unit: "By",
				value: Math.max(40e6, Math.round(heapUsed)),
			})
			metricGaugeRows.push({
				...base,
				metric_name: "process.runtime.nodejs.handles",
				metric_unit: "{handles}",
				value: Math.max(
					8,
					Math.round(50 + 18 * Math.sin(point / 12 + serviceIdx) + (Math.random() - 0.5) * 10),
				),
			})
			// Event loop lag gauge in ms — calm ~8ms baseline with occasional
			// spikes so the Node.js Runtime template's "Event Loop Lag (Max)"
			// panel shows visible structure against demo orgs.
			const lagSpikeMs = Math.random() < 0.06 ? 20 + Math.random() * 60 : 0
			metricGaugeRows.push({
				...base,
				metric_name: "process.runtime.nodejs.eventloop.lag",
				metric_unit: "ms",
				value: Math.max(
					1,
					Math.round(
						8 + 3 * Math.sin(point / 15 + serviceIdx * 2.3) + (Math.random() - 0.5) * 4 + lagSpikeMs,
					),
				),
			})
			gcCount += Math.max(0, Math.round(gaussian(4, 2)))
			metricSumRows.push({
				...base,
				metric_name: "process.runtime.nodejs.gc.count",
				metric_unit: "{collections}",
				value: gcCount,
				aggregation_temporality: 2, // cumulative
				is_monotonic: true,
			})
		}
	}

	return { metricGaugeRows, metricSumRows }
}

export function generateDemoRows({
	orgId,
	hours,
	ratePerHour,
}: {
	orgId: string
	hours: number
	ratePerHour: number
}): DemoRows {
	const now = Date.now()
	const traceRows: TraceRow[] = []
	const logRows: LogRow[] = []

	const totalTraces = hours * ratePerHour
	const startMs = now - hours * 3600 * 1000
	for (let i = 0; i < totalTraces; i++) {
		const offsetMs = Math.floor((i / totalTraces) * hours * 3600 * 1000)
		const ts = new Date(startMs + offsetMs)

		const isWorker = Math.random() < 0.25
		const result = isWorker ? generateWorkerTrace(ts, orgId) : generateHttpTrace(ts, orgId)

		traceRows.push(...result.traceRows)
		logRows.push(...result.logRows)
	}

	const { metricGaugeRows, metricSumRows } = generateRuntimeMetrics(orgId, startMs, now)

	return { traceRows, logRows, metricGaugeRows, metricSumRows }
}
