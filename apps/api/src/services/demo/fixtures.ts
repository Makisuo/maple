import { randomBytes } from "node:crypto"

const SERVICES = ["demo-api", "demo-frontend", "demo-worker", "demo-db"] as const
type DemoService = (typeof SERVICES)[number]

const HTTP_ROUTES: Array<{ method: string; route: string; service: DemoService }> = [
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

const WORKER_JOBS = [
	"send_email",
	"process_payment",
	"sync_inventory",
	"generate_report",
	"refresh_cache",
]

export interface DemoSeedSummary {
	spansSent: number
	logsSent: number
	metricsSent: number
}

interface OtlpAttribute {
	key: string
	value: { stringValue?: string; intValue?: string; boolValue?: boolean; doubleValue?: number }
}

interface OtlpSpan {
	traceId: string
	spanId: string
	parentSpanId?: string
	name: string
	kind: number
	startTimeUnixNano: string
	endTimeUnixNano: string
	attributes: OtlpAttribute[]
	status: { code: number; message?: string }
}

interface OtlpResourceSpans {
	resource: { attributes: OtlpAttribute[] }
	scopeSpans: Array<{ scope: { name: string; version?: string }; spans: OtlpSpan[] }>
}

interface OtlpLogRecord {
	timeUnixNano: string
	observedTimeUnixNano: string
	severityNumber: number
	severityText: string
	body: { stringValue: string }
	attributes: OtlpAttribute[]
	traceId?: string
	spanId?: string
}

interface OtlpResourceLogs {
	resource: { attributes: OtlpAttribute[] }
	scopeLogs: Array<{ scope: { name: string }; logRecords: OtlpLogRecord[] }>
}

const stringAttr = (key: string, value: string): OtlpAttribute => ({
	key,
	value: { stringValue: value },
})
const intAttr = (key: string, value: number): OtlpAttribute => ({
	key,
	value: { intValue: String(value) },
})
const boolAttr = (key: string, value: boolean): OtlpAttribute => ({
	key,
	value: { boolValue: value },
})

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

function buildResourceAttrs(service: DemoService): OtlpAttribute[] {
	return [
		stringAttr("service.name", service),
		stringAttr("service.version", "1.0.0"),
		stringAttr("deployment.environment", "production"),
		stringAttr("telemetry.sdk.name", "maple-demo"),
		stringAttr("telemetry.sdk.language", "nodejs"),
		boolAttr("maple.demo", true),
	]
}

interface GeneratedTrace {
	resourceSpans: OtlpResourceSpans[]
	logs: Array<{ service: DemoService; record: OtlpLogRecord }>
}

function generateHttpTrace(timestamp: Date): GeneratedTrace {
	const route = pick(HTTP_ROUTES)
	const traceId = traceIdHex()
	const rootSpanId = spanIdHex()
	const dbSpanId = spanIdHex()

	const isError = Math.random() < 0.012
	const totalLatency = latencyMs() + (isError ? 100 : 0)
	const dbLatency = Math.min(totalLatency * 0.6, dbLatencyMs())
	const dbStart = timestamp.getTime() + Math.floor((totalLatency - dbLatency) / 2)

	const startNs = BigInt(timestamp.getTime()) * 1_000_000n
	const endNs = startNs + BigInt(Math.round(totalLatency * 1_000_000))
	const dbStartNs = BigInt(dbStart) * 1_000_000n
	const dbEndNs = dbStartNs + BigInt(Math.round(dbLatency * 1_000_000))

	const statusCode = isError ? (Math.random() < 0.5 ? 500 : 503) : Math.random() < 0.04 ? 404 : 200

	const apiSpan: OtlpSpan = {
		traceId,
		spanId: rootSpanId,
		name: `${route.method} ${route.route}`,
		kind: 2,
		startTimeUnixNano: startNs.toString(),
		endTimeUnixNano: endNs.toString(),
		attributes: [
			stringAttr("http.method", route.method),
			stringAttr("http.route", route.route),
			intAttr("http.status_code", statusCode),
			stringAttr("http.scheme", "https"),
			stringAttr("http.host", "api.demo.maple.dev"),
			stringAttr("net.peer.name", "client"),
			boolAttr("maple.demo", true),
		],
		status: {
			code: isError ? 2 : 1,
			...(isError ? { message: "Internal server error" } : {}),
		},
	}

	const dbSpan: OtlpSpan = {
		traceId,
		spanId: dbSpanId,
		parentSpanId: rootSpanId,
		name: "pg.query",
		kind: 3,
		startTimeUnixNano: dbStartNs.toString(),
		endTimeUnixNano: dbEndNs.toString(),
		attributes: [
			stringAttr("db.system", "postgresql"),
			stringAttr("db.statement", pick(DB_QUERIES)),
			stringAttr("db.name", "demo"),
			boolAttr("maple.demo", true),
		],
		status: { code: 1 },
	}

	const apiResource: OtlpResourceSpans = {
		resource: { attributes: buildResourceAttrs(route.service) },
		scopeSpans: [{ scope: { name: "@maple/demo-instr" }, spans: [apiSpan] }],
	}

	const dbResource: OtlpResourceSpans = {
		resource: { attributes: buildResourceAttrs("demo-db") },
		scopeSpans: [{ scope: { name: "@maple/demo-instr" }, spans: [dbSpan] }],
	}

	const logs: GeneratedTrace["logs"] = []

	if (isError) {
		logs.push({
			service: route.service,
			record: {
				timeUnixNano: endNs.toString(),
				observedTimeUnixNano: endNs.toString(),
				severityNumber: 17,
				severityText: "ERROR",
				body: {
					stringValue: `Unhandled error in ${route.method} ${route.route}: connection reset`,
				},
				attributes: [
					stringAttr("http.route", route.route),
					stringAttr("error.type", "ConnectionResetError"),
					boolAttr("maple.demo", true),
				],
				traceId,
				spanId: rootSpanId,
			},
		})
	}

	return { resourceSpans: [apiResource, dbResource], logs }
}

function generateWorkerTrace(timestamp: Date): GeneratedTrace {
	const job = pick(WORKER_JOBS)
	const traceId = traceIdHex()
	const spanId = spanIdHex()
	const isError = Math.random() < 0.008
	const total = Math.max(20, gaussian(180, 90)) + (isError ? 50 : 0)
	const startNs = BigInt(timestamp.getTime()) * 1_000_000n
	const endNs = startNs + BigInt(Math.round(total * 1_000_000))

	const span: OtlpSpan = {
		traceId,
		spanId,
		name: `worker.${job}`,
		kind: 1,
		startTimeUnixNano: startNs.toString(),
		endTimeUnixNano: endNs.toString(),
		attributes: [
			stringAttr("messaging.operation", "process"),
			stringAttr("messaging.system", "demo-queue"),
			stringAttr("job.name", job),
			boolAttr("maple.demo", true),
		],
		status: { code: isError ? 2 : 1 },
	}

	return {
		resourceSpans: [
			{
				resource: { attributes: buildResourceAttrs("demo-worker") },
				scopeSpans: [{ scope: { name: "@maple/demo-instr" }, spans: [span] }],
			},
		],
		logs: [],
	}
}

export function generateDemoBatches({ hours, ratePerHour }: { hours: number; ratePerHour: number }) {
	const now = Date.now()
	const tracesByBatch: OtlpResourceSpans[][] = []
	const logsByBatch: OtlpResourceLogs[][] = []

	const totalTraces = hours * ratePerHour
	const batchSize = 50
	let currentBatch: OtlpResourceSpans[] = []
	let currentLogs: Map<DemoService, OtlpLogRecord[]> = new Map()

	for (let i = 0; i < totalTraces; i++) {
		const offsetMs = Math.floor((i / totalTraces) * hours * 3600 * 1000)
		const ts = new Date(now - hours * 3600 * 1000 + offsetMs)

		const isWorker = Math.random() < 0.25
		const result = isWorker ? generateWorkerTrace(ts) : generateHttpTrace(ts)

		currentBatch.push(...result.resourceSpans)
		for (const { service, record } of result.logs) {
			const arr = currentLogs.get(service) ?? []
			arr.push(record)
			currentLogs.set(service, arr)
		}

		if (currentBatch.length >= batchSize) {
			tracesByBatch.push(currentBatch)
			currentBatch = []
			if (currentLogs.size > 0) {
				const resourceLogs: OtlpResourceLogs[] = []
				for (const [service, records] of currentLogs.entries()) {
					resourceLogs.push({
						resource: { attributes: buildResourceAttrs(service) },
						scopeLogs: [{ scope: { name: "@maple/demo-instr" }, logRecords: records }],
					})
				}
				logsByBatch.push(resourceLogs)
				currentLogs = new Map()
			}
		}
	}

	if (currentBatch.length > 0) tracesByBatch.push(currentBatch)
	if (currentLogs.size > 0) {
		const resourceLogs: OtlpResourceLogs[] = []
		for (const [service, records] of currentLogs.entries()) {
			resourceLogs.push({
				resource: { attributes: buildResourceAttrs(service) },
				scopeLogs: [{ scope: { name: "@maple/demo-instr" }, logRecords: records }],
			})
		}
		logsByBatch.push(resourceLogs)
	}

	return { tracesByBatch, logsByBatch }
}
