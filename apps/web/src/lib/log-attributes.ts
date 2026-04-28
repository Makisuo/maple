import type { Log } from "@/api/tinybird/logs"

export type ChipTone = "error" | "warn" | "info" | "muted"

export interface PickedAttribute {
	key: string
	value: string
	tone: ChipTone
	source: "log" | "resource"
}

const SKIP_KEYS = new Set(["service.name", "service.namespace", "service.instance.id", "service.version"])

const SKIP_PREFIXES = [
	"telemetry.sdk.",
	"process.runtime.",
	"process.executable.",
	"os.",
	"host.arch",
	"host.name",
	"maple_",
]

const PROMOTED_RESOURCE_KEYS = new Set([
	"deployment.environment",
	"deployment.environment.name",
	"k8s.pod.name",
	"k8s.namespace.name",
	"cloud.region",
])

function scoreKey(key: string): number {
	if (key === "error" || key === "exception" || key.startsWith("exception.")) return 100
	if (key === "http.status_code" || key === "http.response.status_code") return 95
	if (key === "rpc.grpc.status_code") return 90
	if (key === "http.method" || key === "http.request.method") return 80
	if (key === "db.system" || key === "db.statement" || key === "db.operation") return 70
	if (key === "rpc.service" || key === "rpc.method") return 68
	if (key === "user.id" || key === "enduser.id" || key === "customer_id" || key === "customer.id") return 66
	if (key === "duration_ms" || key === "latency_ms" || key === "http.duration") return 60
	if (key === "http.url" || key === "http.route" || key === "url.path") return 55
	if (key.startsWith("http.") || key.startsWith("url.")) return 40
	if (key.startsWith("db.")) return 38
	if (key.startsWith("rpc.")) return 36
	if (key.startsWith("messaging.")) return 34
	if (key.startsWith("user.") || key.startsWith("enduser.")) return 32
	if (key.includes(".")) return 25
	return 20
}

function isNumericStatus(value: string): number | null {
	const n = Number(value)
	return Number.isInteger(n) && n >= 100 && n < 600 ? n : null
}

export function getChipTone(key: string, value: string, severityText: string): ChipTone {
	const sev = severityText.toUpperCase()
	const rowIsError = sev === "ERROR" || sev === "FATAL"

	if (key === "error" || key === "exception" || key.startsWith("exception.")) return "error"

	if (
		key === "http.status_code" ||
		key === "http.response.status_code" ||
		key === "status_code" ||
		key === "status"
	) {
		const status = isNumericStatus(value)
		if (status !== null) {
			if (status >= 500) return "error"
			if (status >= 400) return "warn"
			if (status >= 300) return "info"
			return "muted"
		}
	}

	if (key === "rpc.grpc.status_code") {
		const n = Number(value)
		if (Number.isFinite(n) && n !== 0) return "error"
	}

	if (key === "http.method" || key === "http.request.method") return "info"
	if (key === "db.system" || key === "rpc.service" || key === "rpc.method") return "info"

	if (rowIsError) return "muted"
	return "muted"
}

function shouldSkip(key: string): boolean {
	if (SKIP_KEYS.has(key)) return true
	return SKIP_PREFIXES.some((p) => key.startsWith(p))
}

export function pickImportantAttributes(log: Log, limit = 4): PickedAttribute[] {
	const serviceNameLower = log.serviceName.toLowerCase()
	const scored: Array<{ key: string; value: string; score: number; source: "log" | "resource" }> = []

	for (const [key, value] of Object.entries(log.logAttributes)) {
		if (shouldSkip(key)) continue
		if (!value) continue
		if (value.toLowerCase() === serviceNameLower) continue
		scored.push({ key, value, score: scoreKey(key), source: "log" })
	}

	for (const [key, value] of Object.entries(log.resourceAttributes)) {
		if (!value) continue
		if (shouldSkip(key)) continue
		if (!PROMOTED_RESOURCE_KEYS.has(key)) continue
		if (value.toLowerCase() === serviceNameLower) continue
		scored.push({ key, value, score: scoreKey(key) - 10, source: "resource" })
	}

	scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))

	return scored.slice(0, limit).map(({ key, value, source }) => ({
		key,
		value,
		tone: getChipTone(key, value, log.severityText),
		source,
	}))
}

const NAMESPACE_ORDER = [
	"http",
	"url",
	"db",
	"rpc",
	"messaging",
	"code",
	"exception",
	"user",
	"enduser",
	"cloud",
	"k8s",
	"container",
	"host",
	"os",
	"process",
	"telemetry",
	"otel",
]

export interface AttributeGroup {
	namespace: string
	entries: Array<[string, string]>
}

export function groupAttributesByNamespace(attrs: Record<string, string>): AttributeGroup[] {
	const buckets = new Map<string, Array<[string, string]>>()

	for (const entry of Object.entries(attrs)) {
		const [key] = entry
		const dot = key.indexOf(".")
		const namespace = dot > 0 ? key.slice(0, dot) : "Other"
		const list = buckets.get(namespace)
		if (list) list.push(entry)
		else buckets.set(namespace, [entry])
	}

	for (const list of buckets.values()) {
		list.sort(([a], [b]) => a.localeCompare(b))
	}

	const ordered: AttributeGroup[] = []
	for (const ns of NAMESPACE_ORDER) {
		const entries = buckets.get(ns)
		if (entries) {
			ordered.push({ namespace: ns, entries })
			buckets.delete(ns)
		}
	}

	const remaining = [...buckets.entries()]
		.filter(([ns]) => ns !== "Other")
		.sort(([a], [b]) => a.localeCompare(b))
	for (const [ns, entries] of remaining) {
		ordered.push({ namespace: ns, entries })
	}

	const other = buckets.get("Other")
	if (other && other.length > 0) ordered.push({ namespace: "Other", entries: other })

	return ordered
}
