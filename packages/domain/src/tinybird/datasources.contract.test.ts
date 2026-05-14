import { getColumnJsonPath, type DatasourceDefinition } from "@tinybirdco/sdk"
import { describe, expect, it } from "vitest"
import {
	logs,
	metricsExponentialHistogram,
	metricsGauge,
	metricsHistogram,
	metricsSum,
	traces,
} from "./datasources"

/**
 * Schema-parity contract for the Rust ingest service.
 *
 * The Rust encoder in `apps/ingest/src/telemetry.rs` writes one JSON object
 * per row to Tinybird. Each top-level JSON key is bound to a ClickHouse column
 * via the `jsonPath` declared on that column in `./datasources.ts`. If the two
 * sides drift, rows silently land in the wrong columns (or are dropped).
 *
 * This file pins the TS side. The Rust side is pinned by `mod schema_contract`
 * inside `apps/ingest/src/telemetry.rs::tests`. The two lists below MUST stay
 * identical — if you intentionally change a column's `jsonPath`, update both.
 *
 * Conversion rule: a jsonPath like `$.foo`, `$.foo[:]`, or `$.foo.bar` all
 * collapse to the top-level key `foo`. The encoder only writes top-level keys
 * (nested values are written by writing the parent map).
 */
const EXPECTED_TOPLEVEL_KEYS = {
	logs: new Set([
		"timestamp",
		"trace_id",
		"span_id",
		"flags",
		"severity_text",
		"severity_number",
		"service_name",
		"body",
		"resource_schema_url",
		"resource_attributes",
		"scope_schema_url",
		"scope_name",
		"scope_version",
		"scope_attributes",
		"log_attributes",
	]),
	traces: new Set([
		"start_time",
		"trace_id",
		"span_id",
		"parent_span_id",
		"trace_state",
		"span_name",
		"span_kind",
		"service_name",
		"resource_schema_url",
		"resource_attributes",
		"scope_schema_url",
		"scope_name",
		"scope_version",
		"scope_attributes",
		"duration",
		"status_code",
		"status_message",
		"span_attributes",
		"events_timestamp",
		"events_name",
		"events_attributes",
		"links_trace_id",
		"links_span_id",
		"links_trace_state",
		"links_attributes",
	]),
	metrics_sum: new Set([
		...metricCommonKeys(),
		"value",
		"aggregation_temporality",
		"is_monotonic",
	]),
	metrics_gauge: new Set([...metricCommonKeys(), "value"]),
	metrics_histogram: new Set([
		...metricCommonKeys(),
		"count",
		"sum",
		"bucket_counts",
		"explicit_bounds",
		"min",
		"max",
		"aggregation_temporality",
	]),
	metrics_exponential_histogram: new Set([
		...metricCommonKeys(),
		"count",
		"sum",
		"scale",
		"zero_count",
		"positive_offset",
		"positive_bucket_counts",
		"negative_offset",
		"negative_bucket_counts",
		"min",
		"max",
		"aggregation_temporality",
	]),
}

function metricCommonKeys(): string[] {
	return [
		"resource_attributes",
		"resource_schema_url",
		"scope_name",
		"scope_version",
		"scope_attributes",
		"scope_schema_url",
		"service_name",
		"metric_name",
		"metric_description",
		"metric_unit",
		"metric_attributes",
		"start_timestamp",
		"timestamp",
		"flags",
		"exemplars_trace_id",
		"exemplars_span_id",
		"exemplars_timestamp",
		"exemplars_value",
		"exemplars_filtered_attributes",
	]
}

function topLevelKey(jsonPath: string): string | null {
	// `$.foo` / `$.foo[:]` / `$.foo.bar.baz`  ->  `foo`
	if (!jsonPath.startsWith("$.")) return null
	const tail = jsonPath.slice(2)
	const head = tail.split(/[.\[]/, 1)[0]
	return head || null
}

function emittedTopLevelKeys(
	datasource: DatasourceDefinition,
): Set<string> {
	const keys = new Set<string>()
	for (const column of Object.values(datasource.options.schema)) {
		const path = getColumnJsonPath(column)
		if (!path) continue // defaultExpr-only columns (SampleRate, IsEntryPoint) are computed in CH, not ingested
		const top = topLevelKey(path)
		if (top) keys.add(top)
	}
	return keys
}

function diff(a: Set<string>, b: Set<string>): { missing: string[]; extra: string[] } {
	const missing = [...a].filter((k) => !b.has(k)).sort()
	const extra = [...b].filter((k) => !a.has(k)).sort()
	return { missing, extra }
}

const driftHint =
	"If you intentionally changed the schema, update BOTH this file AND `mod schema_contract` in apps/ingest/src/telemetry.rs::tests."

describe("Tinybird datasource ↔ Rust ingest encoder JSON contract", () => {
	const datasources: Array<{
		name: keyof typeof EXPECTED_TOPLEVEL_KEYS
		datasource: DatasourceDefinition
	}> = [
		{ name: "logs", datasource: logs },
		{ name: "traces", datasource: traces },
		{ name: "metrics_sum", datasource: metricsSum },
		{ name: "metrics_gauge", datasource: metricsGauge },
		{ name: "metrics_histogram", datasource: metricsHistogram },
		{ name: "metrics_exponential_histogram", datasource: metricsExponentialHistogram },
	]

	for (const { name, datasource } of datasources) {
		it(`${name} jsonPath roots match the Rust encoder contract`, () => {
			const expected = EXPECTED_TOPLEVEL_KEYS[name]
			const actual = emittedTopLevelKeys(datasource)
			const { missing, extra } = diff(expected, actual)
			expect(
				{ missing, extra },
				`Drift between datasources.ts (${name}) and the Rust contract.\n${driftHint}`,
			).toEqual({ missing: [], extra: [] })
		})
	}

	it("every ingest datasource has at least one jsonPath declared", () => {
		for (const { name, datasource } of datasources) {
			const actual = emittedTopLevelKeys(datasource)
			expect(actual.size, `${name} should have jsonPath-bound columns`).toBeGreaterThan(0)
		}
	})
})
