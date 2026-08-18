/**
 * TypeScript port of the Rust OTLP→NDJSON encoders in
 * `apps/ingest/src/telemetry.rs` (`encode_traces` / `encode_logs` /
 * `encode_metrics` and their helpers), specialized for the local write path:
 *
 *   - Sampling is disabled (keep every span; no `SampleRate` injection, no
 *     attribute mappings) — matches `encode_local_*` which call the core
 *     encoders with `SamplingPolicy::default()` and `&[]` mappings.
 *   - The OrgId is NOT part of the NDJSON; it is injected by the INSERT
 *     statement, so no org field is emitted here.
 *
 * Input is the normalized lowerCamelCase object shape produced by both
 * `decode*Request` (protobuf) and `JSON.parse` of an OTLP/JSON body:
 *   - 64-bit ints (`*UnixNano`) are decimal strings
 *   - byte fields (`bytesValue`, ...) are base64 strings
 *   - id fields (`traceId`, `spanId`, `parentSpanId`) are base64 from the
 *     protobuf path and HEX from the OTLP/JSON path — see `idHex`
 *   - enums (`kind`, `status.code`, `severityNumber`, ...) are numbers
 *   - attributes are arrays of `{ key, value: AnyValue }`
 */

export interface EncodedBatch {
	datasource: string
	rowCount: number
	/** Newline-joined JSON objects (no trailing newline). */
	ndjson: string
}

type AttrMap = Record<string, string>

interface AnyValue {
	stringValue?: string
	boolValue?: boolean
	intValue?: string | number
	doubleValue?: number
	bytesValue?: string
	arrayValue?: { values?: AnyValue[] }
	kvlistValue?: { values?: KeyValue[] }
	value?: string
}

interface KeyValue {
	key?: string
	value?: AnyValue
}

// Value / format helpers (ports of the Rust functions of the same name)

/**
 * Port of Rust `bytes_hex`: base64-decode the field to bytes; if empty or all
 * zero, return `""`; otherwise lowercase hex.
 */
export function bytesHex(b64: string | undefined): string {
	if (!b64) {
		return ""
	}
	return hexFromBytes(base64ToBytes(b64))
}

/** Lowercase hex for `bytes`, or `""` when it is empty or all zero. */
function hexFromBytes(bytes: Uint8Array): string {
	if (bytes.length === 0) {
		return ""
	}
	let allZero = true
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] !== 0) {
			allZero = false
			break
		}
	}
	if (allZero) {
		return ""
	}
	const HEX = "0123456789abcdef"
	let out = ""
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i]!
		out += HEX[byte >> 4]! + HEX[byte & 0x0f]!
	}
	return out
}

function base64ToBytes(b64: string): Uint8Array {
	// `atob` is available in Bun's global scope.
	const binary = atob(b64)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes
}

/**
 * A malformed field in an otherwise well-formed OTLP payload. Surfaces as a
 * 400 from the ingest handler rather than the generic 500 an encoder crash
 * would produce.
 */
// The pure encoder throws this sentinel for its HTTP adapter to translate into a 400 response.
// oxlint-disable-next-line effecttsgo/extends-native-error
export class OtlpFieldError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "OtlpFieldError"
	}
}

const HEX_ONLY = /^[0-9a-fA-F]+$/
const ALL_ZERO_HEX = /^0+$/

const TRACE_ID_BYTES = 16
const SPAN_ID_BYTES = 8

/**
 * Decode a trace/span id field to lowercase hex, accepting BOTH wire encodings
 * that reach this encoder:
 *
 *   - HEX, which is what the OTLP/JSON spec mandates for `traceId`/`spanId`
 *     (an explicit deviation from proto3 JSON, which would base64 a `bytes`
 *     field), what every OTel language SDK emits over OTLP/HTTP+JSON, and what
 *     the Rust ingest gateway accepts on the same endpoints.
 *   - BASE64, which is what `decode*Request` produces, since protobufjs
 *     renders proto `bytes` as base64 under `bytes: String`.
 *
 * The two never collide: an id is read as hex only at its exact hex length (32
 * chars for a 16-byte trace id, 16 for an 8-byte span id), and the base64 form
 * of those same ids is 24 and 12 chars.
 *
 * Anything decoding to the wrong length is rejected. Accepting it silently is
 * worse than it looks: a base64-decoded hex trace id yields a deterministic
 * 24-byte value, so the trace still self-joins and looks fine right up until
 * you match it against the emitting service's logs or an OTLP/protobuf sender.
 */
function idHex(value: string | undefined, byteLength: number, field: string): string {
	if (!value) {
		return ""
	}
	if (value.length === byteLength * 2 && HEX_ONLY.test(value)) {
		const lower = value.toLowerCase()
		return ALL_ZERO_HEX.test(lower) ? "" : lower
	}
	let bytes: Uint8Array | undefined
	try {
		bytes = base64ToBytes(value)
	} catch {
		bytes = undefined
	}
	if (!bytes || bytes.length !== byteLength) {
		// Report the expectation rather than the decoded byte count: for an input
		// that looks like hex but is the wrong length, the base64 byte count is
		// noise ("deadbeef" is 4 hex bytes, but decodes as 6 base64 bytes).
		const base64Chars = Math.ceil(byteLength / 3) * 4
		const shown = value.length > 80 ? `${value.slice(0, 80)}…` : value
		throw new OtlpFieldError(
			`${field} must be ${byteLength} bytes: expected ${byteLength * 2} hex chars (OTLP/JSON) or ${base64Chars} base64 chars (OTLP/protobuf), got ${JSON.stringify(shown)} (${value.length} chars)`,
		)
	}
	return hexFromBytes(bytes)
}

export const traceIdHex = (value: string | undefined, field: string): string =>
	idHex(value, TRACE_ID_BYTES, field)

export const spanIdHex = (value: string | undefined, field: string): string =>
	idHex(value, SPAN_ID_BYTES, field)

/**
 * Port of Rust `format_timestamp_nano`: nanoseconds-since-epoch (decimal
 * string) → UTC `"YYYY-MM-DD HH:MM:SS.nnnnnnnnn"` with exactly 9 fractional
 * digits. `"0"`/empty → epoch. Uses BigInt to avoid precision loss.
 */
export function formatTimestampNano(nanos: string | number | undefined): string {
	const epoch = "1970-01-01 00:00:00.000000000"
	if (nanos === undefined || nanos === null || nanos === "" || nanos === 0 || nanos === "0") {
		return epoch
	}
	let value: bigint
	try {
		value = BigInt(nanos)
	} catch {
		return epoch
	}
	if (value === 0n) {
		return epoch
	}
	const NS_PER_SEC = 1_000_000_000n
	const secs = value / NS_PER_SEC
	const frac = value % NS_PER_SEC
	const millis = Number(secs) * 1000
	// Out-of-range timestamps fall back to epoch, mirroring chrono's `None`.
	if (!Number.isFinite(millis)) {
		return epoch
	}
	const date = new Date(millis)
	const iso = date.toISOString()
	if (Number.isNaN(date.getTime())) {
		return epoch
	}
	// iso is e.g. "2023-11-14T22:13:20.123Z"; keep the calendar part only.
	const calendar = iso.slice(0, 19).replace("T", " ")
	const frac9 = frac.toString().padStart(9, "0")
	return `${calendar}.${frac9}`
}

/**
 * Port of Rust `any_value_string`: coerce an OTLP `AnyValue` to a string
 * exactly as the Rust encoder does.
 */
export function anyValueString(value: AnyValue | undefined | null): string {
	if (!value) {
		return ""
	}
	if (value.stringValue !== undefined) {
		return value.stringValue
	}
	if (value.boolValue !== undefined) {
		return value.boolValue ? "true" : "false"
	}
	if (value.intValue !== undefined) {
		// Decoded as a decimal string (longs: String) or a number for JSON input.
		return String(value.intValue)
	}
	if (value.doubleValue !== undefined) {
		return formatDouble(value.doubleValue)
	}
	if (value.bytesValue !== undefined) {
		return bytesHex(value.bytesValue)
	}
	if (value.arrayValue !== undefined) {
		const values = (value.arrayValue.values ?? []).map(anyValueString)
		return JSON.stringify(values)
	}
	if (value.kvlistValue !== undefined) {
		const attrs = attrMap(value.kvlistValue.values ?? [])
		return JSON.stringify(attrs)
	}
	return ""
}

/**
 * Format a double the way Rust's `f64::to_string()` (the `Display` impl) does:
 * the shortest round-trip decimal, but NEVER in scientific notation. JS's
 * `String(num)` produces the same shortest mantissa but switches to `e`
 * notation for large/small magnitudes, so we expand any exponent into a plain
 * decimal string.
 */
function formatDouble(num: number): string {
	if (Number.isNaN(num)) {
		return "NaN"
	}
	if (num === Infinity) {
		return "inf"
	}
	if (num === -Infinity) {
		return "-inf"
	}
	// Distinguish -0.0 (Rust prints "-0").
	if (num === 0) {
		return Object.is(num, -0) ? "-0" : "0"
	}
	const s = String(num)
	const eIndex = s.indexOf("e")
	if (eIndex === -1) {
		return s
	}
	return expandExponential(s, eIndex)
}

function expandExponential(s: string, eIndex: number): string {
	let mantissa = s.slice(0, eIndex)
	const exp = parseInt(s.slice(eIndex + 1), 10)

	let sign = ""
	if (mantissa.startsWith("-")) {
		sign = "-"
		mantissa = mantissa.slice(1)
	} else if (mantissa.startsWith("+")) {
		mantissa = mantissa.slice(1)
	}

	const dot = mantissa.indexOf(".")
	let intPart: string
	let fracPart: string
	if (dot === -1) {
		intPart = mantissa
		fracPart = ""
	} else {
		intPart = mantissa.slice(0, dot)
		fracPart = mantissa.slice(dot + 1)
	}

	// Combine into a single digit string with a tracked decimal-point position.
	const digits = intPart + fracPart
	// Position of the decimal point measured from the start of `digits`.
	let pointPos = intPart.length + exp

	let result: string
	if (pointPos <= 0) {
		result = "0." + "0".repeat(-pointPos) + digits
	} else if (pointPos >= digits.length) {
		result = digits + "0".repeat(pointPos - digits.length)
	} else {
		result = digits.slice(0, pointPos) + "." + digits.slice(pointPos)
	}

	// Trim redundant trailing zeros in any fractional part and a dangling dot.
	if (result.indexOf(".") !== -1) {
		result = result.replace(/0+$/, "").replace(/\.$/, "")
	}
	return sign + result
}

/**
 * Port of Rust `attr_map`: `{ [key]: anyValueString(value) }`. Every value is
 * coerced to a string (the ClickHouse columns are `Map(String, String)`).
 */
function attrMap(attributes: KeyValue[] | undefined): AttrMap {
	const out: AttrMap = {}
	if (!attributes) {
		return out
	}
	for (const attribute of attributes) {
		out[attribute.key ?? ""] = anyValueString(attribute.value)
	}
	return out
}

/** Port of Rust `span_kind`. */
function spanKind(kind: number | undefined): string {
	switch (kind) {
		case 1:
			return "Internal"
		case 2:
			return "Server"
		case 3:
			return "Client"
		case 4:
			return "Producer"
		case 5:
			return "Consumer"
		default:
			return "Unspecified"
	}
}

/** Port of Rust `status_code` (Title Case). */
export function statusCode(code: number | undefined): string {
	switch (code) {
		case 1:
			return "Ok"
		case 2:
			return "Error"
		default:
			return "Unset"
	}
}

/** Port of Rust `severity_number_to_text`. */
function severityNumberToText(n: number | undefined): string {
	const num = n ?? 0
	if (num >= 1 && num <= 4) {
		return "TRACE"
	}
	if (num >= 5 && num <= 8) {
		return "DEBUG"
	}
	if (num >= 9 && num <= 12) {
		return "INFO"
	}
	if (num >= 13 && num <= 16) {
		return "WARN"
	}
	if (num >= 17 && num <= 20) {
		return "ERROR"
	}
	if (num >= 21 && num <= 24) {
		return "FATAL"
	}
	return ""
}

// Shared numeric coercions

/** UInt32 flags field — present as a number after `defaults: true`. */
function asUint32(value: number | string | undefined): number {
	if (value === undefined || value === null) {
		return 0
	}
	const n = typeof value === "string" ? Number(value) : value
	return Number.isFinite(n) ? n >>> 0 : 0
}

/** Int32 enum/offset field. */
function asInt32(value: number | string | undefined): number {
	if (value === undefined || value === null) {
		return 0
	}
	const n = typeof value === "string" ? Number(value) : value
	return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** UInt64 count field → emitted as a JS number (matches serde_json of a u64). */
function asUint64Number(value: string | number | undefined): number {
	if (value === undefined || value === null || value === "") {
		return 0
	}
	return Number(value)
}

/** Saturating non-negative UInt64 duration in nanoseconds, as a JS number. */
function duration(startNano: string | number | undefined, endNano: string | number | undefined): number {
	const start = toBigInt(startNano)
	const end = toBigInt(endNano)
	const diff = end - start
	return diff > 0n ? Number(diff) : 0
}

function toBigInt(value: string | number | undefined): bigint {
	if (value === undefined || value === null || value === "") {
		return 0n
	}
	try {
		return BigInt(value)
	} catch {
		return 0n
	}
}

/** Number data point value (`as_double` | `as_int` | none → 0.0). */
function numberPointValue(point: { asDouble?: number; asInt?: string | number }): number {
	if (point.asDouble !== undefined) {
		return point.asDouble
	}
	if (point.asInt !== undefined) {
		return Number(point.asInt)
	}
	return 0
}

// Exemplars (port of Rust `encode_exemplars`)

interface Exemplar {
	traceId?: string
	spanId?: string
	timeUnixNano?: string | number
	asDouble?: number
	asInt?: string | number
	filteredAttributes?: KeyValue[]
}

interface EncodedExemplars {
	exemplars_trace_id: string[]
	exemplars_span_id: string[]
	exemplars_timestamp: string[]
	exemplars_value: number[]
	exemplars_filtered_attributes: AttrMap[]
}

function encodeExemplars(exemplars: Exemplar[] | undefined): EncodedExemplars {
	const out: EncodedExemplars = {
		exemplars_trace_id: [],
		exemplars_span_id: [],
		exemplars_timestamp: [],
		exemplars_value: [],
		exemplars_filtered_attributes: [],
	}
	if (!exemplars) {
		return out
	}
	for (let index = 0; index < exemplars.length; index++) {
		const exemplar = exemplars[index]!
		out.exemplars_trace_id.push(traceIdHex(exemplar.traceId, `exemplars[${index}].traceId`))
		out.exemplars_span_id.push(spanIdHex(exemplar.spanId, `exemplars[${index}].spanId`))
		out.exemplars_timestamp.push(formatTimestampNano(exemplar.timeUnixNano))
		out.exemplars_value.push(numberPointValue(exemplar))
		out.exemplars_filtered_attributes.push(attrMap(exemplar.filteredAttributes))
	}
	return out
}

// NDJSON assembly

function toBatches(byDatasource: Map<string, Record<string, unknown>[]>): EncodedBatch[] {
	const batches: EncodedBatch[] = []
	// Match the Rust BTreeMap ordering (datasource name) for deterministic output.
	const datasources = [...byDatasource.keys()].sort()
	for (const datasource of datasources) {
		const rows = byDatasource.get(datasource)!
		if (rows.length === 0) {
			continue
		}
		batches.push({
			datasource,
			rowCount: rows.length,
			ndjson: rows.map((row) => JSON.stringify(row)).join("\n"),
		})
	}
	return batches
}

// Traces

interface TraceRequest {
	resourceSpans?: ResourceSpans[]
}
interface ResourceSpans {
	resource?: { attributes?: KeyValue[] }
	scopeSpans?: ScopeSpans[]
	schemaUrl?: string
}
interface ScopeSpans {
	scope?: { name?: string; version?: string; attributes?: KeyValue[] }
	spans?: Span[]
	schemaUrl?: string
}
interface SpanEvent {
	timeUnixNano?: string | number
	name?: string
	attributes?: KeyValue[]
}
interface SpanLink {
	traceId?: string
	spanId?: string
	traceState?: string
	attributes?: KeyValue[]
}
interface Span {
	traceId?: string
	spanId?: string
	parentSpanId?: string
	traceState?: string
	name?: string
	kind?: number
	startTimeUnixNano?: string | number
	endTimeUnixNano?: string | number
	attributes?: KeyValue[]
	events?: SpanEvent[]
	links?: SpanLink[]
	status?: { code?: number; message?: string }
}

export function encodeTraces(req: unknown): EncodedBatch[] {
	const request = (req ?? {}) as TraceRequest
	const rows: Record<string, unknown>[] = []

	for (const resourceSpans of request.resourceSpans ?? []) {
		const resourceAttrs = attrMap(resourceSpans.resource?.attributes)
		const serviceName = resourceAttrs["service.name"] ?? ""

		for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
			const scope = scopeSpans.scope
			const scopeAttrs = attrMap(scope?.attributes)
			const scopeName = scope?.name ?? ""
			const scopeVersion = scope?.version ?? ""

			for (const span of scopeSpans.spans ?? []) {
				const traceId = traceIdHex(span.traceId, "span.traceId")
				const spanAttrs = attrMap(span.attributes)

				const events = span.events ?? []
				const links = span.links ?? []

				rows.push({
					start_time: formatTimestampNano(span.startTimeUnixNano),
					trace_id: traceId,
					span_id: spanIdHex(span.spanId, "span.spanId"),
					parent_span_id: spanIdHex(span.parentSpanId, "span.parentSpanId"),
					trace_state: span.traceState ?? "",
					span_name: span.name ?? "",
					span_kind: spanKind(span.kind),
					service_name: serviceName,
					resource_schema_url: resourceSpans.schemaUrl ?? "",
					resource_attributes: resourceAttrs,
					scope_schema_url: scopeSpans.schemaUrl ?? "",
					scope_name: scopeName,
					scope_version: scopeVersion,
					scope_attributes: scopeAttrs,
					duration: duration(span.startTimeUnixNano, span.endTimeUnixNano),
					status_code: statusCode(span.status?.code),
					status_message: span.status?.message ?? "",
					span_attributes: spanAttrs,
					events_timestamp: events.map((event) => formatTimestampNano(event.timeUnixNano)),
					events_name: events.map((event) => event.name ?? ""),
					events_attributes: events.map((event) => attrMap(event.attributes)),
					links_trace_id: links.map((link, i) =>
						traceIdHex(link.traceId, `span.links[${i}].traceId`),
					),
					links_span_id: links.map((link, i) => spanIdHex(link.spanId, `span.links[${i}].spanId`)),
					links_trace_state: links.map((link) => link.traceState ?? ""),
					links_attributes: links.map((link) => attrMap(link.attributes)),
					// Local mode runs no classifier, so these four keep the column
					// defaults: AiVendor '' = not AI, AiRulesVersion 0 = never
					// examined.
					ai_vendor: "",
					ai_session_key_state: 0,
					ai_session_key_hash: 0,
					ai_rules_version: 0,
				})
			}
		}
	}

	const byDatasource = new Map<string, Record<string, unknown>[]>()
	byDatasource.set("traces", rows)
	return toBatches(byDatasource)
}

// Logs

interface LogsRequest {
	resourceLogs?: ResourceLogs[]
}
interface ResourceLogs {
	resource?: { attributes?: KeyValue[] }
	scopeLogs?: ScopeLogs[]
	schemaUrl?: string
}
interface ScopeLogs {
	scope?: { name?: string; version?: string; attributes?: KeyValue[] }
	logRecords?: LogRecord[]
	schemaUrl?: string
}
interface LogRecord {
	timeUnixNano?: string | number
	observedTimeUnixNano?: string | number
	severityNumber?: number
	severityText?: string
	body?: AnyValue
	attributes?: KeyValue[]
	flags?: number | string
	traceId?: string
	spanId?: string
}

export function encodeLogs(req: unknown): EncodedBatch[] {
	const request = (req ?? {}) as LogsRequest
	const rows: Record<string, unknown>[] = []

	for (const resourceLogs of request.resourceLogs ?? []) {
		const resourceAttrs = attrMap(resourceLogs.resource?.attributes)
		const serviceName = resourceAttrs["service.name"] ?? ""

		for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
			const scope = scopeLogs.scope
			const scopeAttrs = attrMap(scope?.attributes)
			const scopeName = scope?.name ?? ""
			const scopeVersion = scope?.version ?? ""

			for (const log of scopeLogs.logRecords ?? []) {
				const timeNano = isNonZeroNano(log.timeUnixNano) ? log.timeUnixNano : log.observedTimeUnixNano
				const severityText =
					log.severityText && log.severityText.length > 0
						? log.severityText
						: severityNumberToText(log.severityNumber)

				rows.push({
					timestamp: formatTimestampNano(timeNano),
					trace_id: traceIdHex(log.traceId, "logRecord.traceId"),
					span_id: spanIdHex(log.spanId, "logRecord.spanId"),
					flags: asUint32(log.flags),
					severity_text: severityText,
					severity_number: log.severityNumber ?? 0,
					service_name: serviceName,
					body: anyValueString(log.body),
					resource_schema_url: resourceLogs.schemaUrl ?? "",
					resource_attributes: resourceAttrs,
					scope_schema_url: scopeLogs.schemaUrl ?? "",
					scope_name: scopeName,
					scope_version: scopeVersion,
					scope_attributes: scopeAttrs,
					log_attributes: attrMap(log.attributes),
				})
			}
		}
	}

	const byDatasource = new Map<string, Record<string, unknown>[]>()
	byDatasource.set("logs", rows)
	return toBatches(byDatasource)
}

function isNonZeroNano(value: string | number | undefined): boolean {
	if (value === undefined || value === null || value === "" || value === 0 || value === "0") {
		return false
	}
	return true
}

// Metrics

interface MetricsRequest {
	resourceMetrics?: ResourceMetrics[]
}
interface ResourceMetrics {
	resource?: { attributes?: KeyValue[] }
	scopeMetrics?: ScopeMetrics[]
	schemaUrl?: string
}
interface ScopeMetrics {
	scope?: { name?: string; version?: string; attributes?: KeyValue[] }
	metrics?: Metric[]
	schemaUrl?: string
}
interface NumberDataPoint {
	attributes?: KeyValue[]
	startTimeUnixNano?: string | number
	timeUnixNano?: string | number
	asDouble?: number
	asInt?: string | number
	exemplars?: Exemplar[]
	flags?: number | string
}
interface HistogramDataPoint {
	attributes?: KeyValue[]
	startTimeUnixNano?: string | number
	timeUnixNano?: string | number
	count?: string | number
	sum?: number
	bucketCounts?: (string | number)[]
	explicitBounds?: number[]
	exemplars?: Exemplar[]
	flags?: number | string
	min?: number
	max?: number
}
interface ExpHistogramBuckets {
	offset?: number | string
	bucketCounts?: (string | number)[]
}
interface ExpHistogramDataPoint {
	attributes?: KeyValue[]
	startTimeUnixNano?: string | number
	timeUnixNano?: string | number
	count?: string | number
	sum?: number
	scale?: number | string
	zeroCount?: string | number
	positive?: ExpHistogramBuckets
	negative?: ExpHistogramBuckets
	flags?: number | string
	exemplars?: Exemplar[]
	min?: number
	max?: number
}
interface Metric {
	name?: string
	description?: string
	unit?: string
	gauge?: { dataPoints?: NumberDataPoint[] }
	sum?: {
		dataPoints?: NumberDataPoint[]
		aggregationTemporality?: number
		isMonotonic?: boolean
	}
	histogram?: { dataPoints?: HistogramDataPoint[]; aggregationTemporality?: number }
	exponentialHistogram?: {
		dataPoints?: ExpHistogramDataPoint[]
		aggregationTemporality?: number
	}
	summary?: unknown
}

interface MetricScope {
	resourceAttrs: AttrMap
	resourceSchemaUrl: string
	scopeName: string
	scopeVersion: string
	scopeAttrs: AttrMap
	scopeSchemaUrl: string
	serviceName: string
}

/** Port of Rust `metric_common_row`. */
function metricCommonRow(
	metric: Metric,
	ctx: MetricScope,
	attributes: KeyValue[] | undefined,
	startTimeNano: string | number | undefined,
	timeNano: string | number | undefined,
	flags: number | string | undefined,
	exemplars: Exemplar[] | undefined,
): Record<string, unknown> {
	const ex = encodeExemplars(exemplars)
	return {
		resource_attributes: ctx.resourceAttrs,
		resource_schema_url: ctx.resourceSchemaUrl,
		scope_name: ctx.scopeName,
		scope_version: ctx.scopeVersion,
		scope_attributes: ctx.scopeAttrs,
		scope_schema_url: ctx.scopeSchemaUrl,
		service_name: ctx.serviceName,
		metric_name: metric.name ?? "",
		metric_description: metric.description ?? "",
		metric_unit: metric.unit ?? "",
		metric_attributes: attrMap(attributes),
		start_timestamp: formatTimestampNano(startTimeNano),
		timestamp: formatTimestampNano(timeNano),
		flags: asUint32(flags),
		exemplars_trace_id: ex.exemplars_trace_id,
		exemplars_span_id: ex.exemplars_span_id,
		exemplars_timestamp: ex.exemplars_timestamp,
		exemplars_value: ex.exemplars_value,
		exemplars_filtered_attributes: ex.exemplars_filtered_attributes,
	}
}

export function encodeMetrics(req: unknown): EncodedBatch[] {
	const request = (req ?? {}) as MetricsRequest
	const byDatasource = new Map<string, Record<string, unknown>[]>()
	const push = (datasource: string, row: Record<string, unknown>) => {
		let list = byDatasource.get(datasource)
		if (!list) {
			list = []
			byDatasource.set(datasource, list)
		}
		list.push(row)
	}

	for (const resourceMetrics of request.resourceMetrics ?? []) {
		const resourceAttrs = attrMap(resourceMetrics.resource?.attributes)
		const serviceName = resourceAttrs["service.name"] ?? ""

		for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
			const scope = scopeMetrics.scope
			const ctx: MetricScope = {
				resourceAttrs,
				resourceSchemaUrl: resourceMetrics.schemaUrl ?? "",
				scopeName: scope?.name ?? "",
				scopeVersion: scope?.version ?? "",
				scopeAttrs: attrMap(scope?.attributes),
				scopeSchemaUrl: scopeMetrics.schemaUrl ?? "",
				serviceName,
			}

			for (const metric of scopeMetrics.metrics ?? []) {
				if (metric.gauge) {
					for (const point of metric.gauge.dataPoints ?? []) {
						const row = metricCommonRow(
							metric,
							ctx,
							point.attributes,
							point.startTimeUnixNano,
							point.timeUnixNano,
							point.flags,
							point.exemplars,
						)
						row.value = numberPointValue(point)
						push("metrics_gauge", row)
					}
				} else if (metric.sum) {
					for (const point of metric.sum.dataPoints ?? []) {
						const row = metricCommonRow(
							metric,
							ctx,
							point.attributes,
							point.startTimeUnixNano,
							point.timeUnixNano,
							point.flags,
							point.exemplars,
						)
						row.value = numberPointValue(point)
						row.aggregation_temporality = asInt32(metric.sum.aggregationTemporality)
						row.is_monotonic = metric.sum.isMonotonic ?? false
						push("metrics_sum", row)
					}
				} else if (metric.histogram) {
					for (const point of metric.histogram.dataPoints ?? []) {
						const row = metricCommonRow(
							metric,
							ctx,
							point.attributes,
							point.startTimeUnixNano,
							point.timeUnixNano,
							point.flags,
							point.exemplars,
						)
						row.count = asUint64Number(point.count)
						row.sum = point.sum ?? 0
						row.bucket_counts = (point.bucketCounts ?? []).map(asUint64Number)
						row.explicit_bounds = point.explicitBounds ?? []
						row.min = point.min ?? null
						row.max = point.max ?? null
						row.aggregation_temporality = asInt32(metric.histogram.aggregationTemporality)
						push("metrics_histogram", row)
					}
				} else if (metric.exponentialHistogram) {
					for (const point of metric.exponentialHistogram.dataPoints ?? []) {
						const row = metricCommonRow(
							metric,
							ctx,
							point.attributes,
							point.startTimeUnixNano,
							point.timeUnixNano,
							point.flags,
							point.exemplars,
						)
						const positive = point.positive
						const negative = point.negative
						row.count = asUint64Number(point.count)
						row.sum = point.sum ?? 0
						row.scale = asInt32(point.scale)
						row.zero_count = asUint64Number(point.zeroCount)
						row.positive_offset = asInt32(positive?.offset)
						row.positive_bucket_counts = (positive?.bucketCounts ?? []).map(asUint64Number)
						row.negative_offset = asInt32(negative?.offset)
						row.negative_bucket_counts = (negative?.bucketCounts ?? []).map(asUint64Number)
						row.min = point.min ?? null
						row.max = point.max ?? null
						row.aggregation_temporality = asInt32(
							metric.exponentialHistogram.aggregationTemporality,
						)
						push("metrics_exponential_histogram", row)
					}
				}
				// Summary and unset data are dropped (matches Rust).
			}
		}
	}

	return toBatches(byDatasource)
}
