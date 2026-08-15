import { describe, expect, it } from "vitest"
import type { V2DashboardTemplate } from "@maple/domain/http/v2"
import { computeTemplateReadiness } from "./use-template-readiness"

// SAFETY: the fixture supplies the complete template fields consumed by readiness evaluation; ids are inert test values.
const template = (
	id: string,
	requiredMetricPrefixes: ReadonlyArray<string>,
	requirement?: Partial<NonNullable<V2DashboardTemplate["requirement"]>>,
): V2DashboardTemplate =>
	({
		id,
		object: "dashboard_template",
		name: id,
		description: "",
		category: "database",
		tags: [],
		requirements: [],
		requirement:
			requirement === undefined ? null : { kind: "metrics", label: "", collector: "", ...requirement },
		requiredMetricPrefixes,
		parameters: [],
		preview: [],
	}) as unknown as V2DashboardTemplate

const metric = (metricName: string, lastSeen = "2026-07-28T09:00:00Z") => ({ metricName, lastSeen })

describe("computeTemplateReadiness", () => {
	it("marks a template ready when its prefix matches at least one metric", () => {
		const readiness = computeTemplateReadiness(
			[template("postgres", ["postgresql."])],
			[metric("postgresql.backends"), metric("postgresql.commits"), metric("redis.uptime")],
		)
		expect(readiness.get("postgres")).toMatchObject({
			ready: true,
			missingLabel: null,
			metricCount: 2,
		})
	})

	it("derives the missing label from the prefix", () => {
		const readiness = computeTemplateReadiness(
			[template("kafka", ["kafka."])],
			[metric("postgresql.backends")],
		)
		expect(readiness.get("kafka")).toMatchObject({
			ready: false,
			missingLabel: "no kafka.*",
			prefixLabel: "kafka.*",
			metricCount: 0,
			lastSeen: null,
		})
	})

	it("prefers an explicit missing label over the derived one", () => {
		const readiness = computeTemplateReadiness(
			[template("cloudflare", ["cloudflare."], { kind: "integration", missing: "not connected" })],
			[metric("postgresql.backends")],
		)
		expect(readiness.get("cloudflare")?.missingLabel).toBe("not connected")
	})

	// A template charting two receivers renders half-empty if only one reports,
	// so a partial match is still "needs setup".
	it("requires every prefix to be present", () => {
		const readiness = computeTemplateReadiness(
			[template("k8s-pod", ["k8s.pod.", "k8s.node."])],
			[metric("k8s.pod.cpu.utilization")],
		)
		expect(readiness.get("k8s-pod")?.ready).toBe(false)
	})

	// A prefix must match on a name boundary the same way `startsWith` does —
	// the binary search must not skip past a run or pick up a neighbour.
	it("matches only names carrying the prefix, whatever the sort order", () => {
		const readiness = computeTemplateReadiness(
			[template("redis", ["redis."]), template("mysql", ["mysql."])],
			[
				metric("redisearch.total"),
				metric("mysqlx.connections"),
				metric("redis.uptime"),
				metric("aaa.first"),
				metric("zzz.last"),
			],
		)
		expect(readiness.get("redis")).toMatchObject({ ready: true, metricCount: 1 })
		// `mysqlx.` is not `mysql.` — a prefix is a literal, not a fuzzy match.
		expect(readiness.get("mysql")?.ready).toBe(false)
	})

	it("treats the empty-string prefix as any metric at all", () => {
		const anyMetric = computeTemplateReadiness([template("overview", [""])], [metric("anything")])
		expect(anyMetric.get("overview")).toMatchObject({ ready: true, prefixLabel: null })

		const noMetrics = computeTemplateReadiness([template("overview", [""])], [])
		expect(noMetrics.get("overview")?.ready).toBe(false)
	})

	it("reports the most recent lastSeen across matching metrics", () => {
		const readiness = computeTemplateReadiness(
			[template("postgres", ["postgresql."])],
			[
				metric("postgresql.backends", "2026-07-28T08:00:00Z"),
				metric("postgresql.commits", "2026-07-28T09:30:00Z"),
			],
		)
		expect(readiness.get("postgres")?.lastSeen).toBe("2026-07-28T09:30:00Z")
	})

	it("never gates a template that declares no prefixes", () => {
		const readiness = computeTemplateReadiness([template("service-health", [])], [])
		expect(readiness.get("service-health")).toMatchObject({ ready: true, missingLabel: null })
	})

	// Loading or errored metrics must not claim a template needs setup.
	it("fails open when the metric list is unavailable", () => {
		const readiness = computeTemplateReadiness([template("kafka", ["kafka."])], null)
		expect(readiness.get("kafka")).toMatchObject({ ready: true, missingLabel: null })
	})
})
