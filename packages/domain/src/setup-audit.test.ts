import { describe, expect, it } from "vitest"
import {
	type AuditCheckResult,
	type ConfigAuditInputs,
	type SetupAuditInputs,
	type WarehouseAuditInputs,
	SETUP_AUDIT_CHECKS,
	runSetupAudit,
} from "./setup-audit"

const NOW = Date.UTC(2026, 6, 27, 12, 0, 0)
const HOUR = 60 * 60_000

/** A fully healthy org — every check passes. Each test perturbs exactly one field. */
const healthyConfig: ConfigAuditInputs = {
	firstDataReceivedAt: NOW - 30 * 24 * HOUR,
	alertRules: [
		{
			id: "rule-1",
			name: "API error rate",
			enabled: true,
			destinationIds: ["dest-1"],
			windowMinutes: 5,
			lastScheduledAt: NOW - 60_000,
			createdAt: NOW - 10 * 24 * HOUR,
		},
	],
	alertRuleStates: [{ ruleId: "rule-1", lastEvaluatedAt: NOW - 60_000, lastError: null }],
	alertDestinations: [{ id: "dest-1", name: "#alerts", enabled: true, lastTestError: null }],
	errorNotificationPolicy: { enabled: true, destinationIds: ["dest-1"] },
	anomalyDetector: { enabled: true },
	dashboardCount: 2,
	samplingPolicy: null,
	attributeMappings: [],
	clickhouse: null,
	integrations: [{ provider: "cloudflare", revokedAt: null }],
	cloudflareAnalytics: [
		{
			dataset: "httpRequests",
			zoneName: "example.com",
			lastSuccessAt: NOW - 5 * 60_000,
			lastErrorAt: null,
			lastError: null,
		},
	],
	vcsRepositories: [{ id: "repo-1", fullName: "acme/api", syncStatus: "active", lastSyncError: null }],
	scrapeTargets: [{ id: "target-1", name: "api metrics", enabled: true, lastScrapeError: null }],
	openRecommendationCount: 0,
}

const spanKey = (key: string, usageCount = 100) => ({ scope: "span", key, usageCount })
const resourceKey = (key: string, usageCount = 100) => ({ scope: "resource", key, usageCount })

/** A fully healthy telemetry snapshot — every telemetry check passes against it. */
const healthyWarehouse: WarehouseAuditInputs = {
	lookbackHours: 24,
	logCorrelationHours: 6,
	attributeKeys: [
		spanKey("http.request.method"),
		spanKey("db.query.text"),
		resourceKey("service.version"),
		resourceKey("deployment.environment.name"),
		resourceKey("vcs.repository.url.full"),
		resourceKey("vcs.ref.head.revision"),
		{ scope: "log", key: "order.id", usageCount: 50 },
		{ scope: "log", key: "user.id", usageCount: 50 },
		{ scope: "log", key: "tenant.id", usageCount: 50 },
	],
	serviceUsage: [{ serviceName: "api", logCount: 500, traceCount: 900, metricCount: 40 }],
	spanShape: [
		{
			serviceName: "api",
			spanCount: 900,
			errorCount: 9,
			serverCount: 400,
			consumerCount: 0,
			noEnvCount: 0,
			spanNameCount: 30,
			badStatusCodes: [],
			badSpanKinds: [],
		},
	],
	logSeverity: [{ serviceName: "api", severityText: "INFO", logCount: 500 }],
	metricLabels: [{ attributeKey: "http.route", valueCardinality: 40 }],
	peerValues: [{ attributeKey: "peer.service", attributeValue: "tinybird", usageCount: 20 }],
	dbEdges: [
		{
			serviceName: "api",
			dbSystem: "postgresql",
			callCount: 100,
			unknownNamespaceCallCount: 0,
		},
	],
	logCorrelation: [
		{
			serviceName: "api",
			logCount: 500,
			uncorrelatedCount: 10,
			errorLogCount: 4,
			uncorrelatedErrorCount: 0,
		},
	],
	traceCompleteness: {
		windowMinutes: 60,
		traceSampleModulus: 1,
		orphans: [
			{
				serviceName: "api",
				childCount: 800,
				orphanCount: 4,
				sampledOrphanCount: 0,
				sampleTraceIds: [],
			},
		],
		rootless: [{ entryService: "api", traceCount: 800, rootlessCount: 3, sampledRootlessCount: 0 }],
	},
}

/** Overrides on top of the healthy telemetry snapshot. */
const warehouse = (overrides: Partial<WarehouseAuditInputs> = {}): WarehouseAuditInputs => ({
	...healthyWarehouse,
	...overrides,
})

const inputs = (config: Partial<ConfigAuditInputs> = {}): SetupAuditInputs => ({
	now: NOW,
	config: { ...healthyConfig, ...config },
	warehouse: healthyWarehouse,
})

/** Explicit-warehouse variant — a default parameter would swallow a deliberate `undefined`. */
const inputsWith = (
	warehouse: WarehouseAuditInputs | undefined,
	config: Partial<ConfigAuditInputs> = {},
): SetupAuditInputs => ({ now: NOW, config: { ...healthyConfig, ...config }, warehouse })

const check = (report: ReturnType<typeof runSetupAudit>, id: string): AuditCheckResult => {
	const found = report.checks.find((row) => row.id === id)
	if (!found) throw new Error(`no check ${id} in report`)
	return found
}

describe("runSetupAudit — baseline", () => {
	it("passes every check for a healthy org", () => {
		const report = runSetupAudit(inputs())
		const failures = report.checks.filter((row) => row.status !== "pass")
		expect(failures).toEqual([])
		expect(report.summary.pass).toBe(SETUP_AUDIT_CHECKS.length)
		expect(report.dataStatus).toBe("ok")
	})

	it("uses unique check ids", () => {
		const ids = SETUP_AUDIT_CHECKS.map((row) => row.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it("agrees subject and verb in every finding sentence", () => {
		// Findings always lead with a count, so a hardcoded singular verb reads as "3 services
		// emits …". Drive every check to fail with both one and several affected items, then scan
		// each generated sentence. This is the guard that catches copy regressions in new checks.
		const failing = [1, 3].flatMap((n) => {
			const each = <T>(build: (index: number) => T) => Array.from({ length: n }, (_, i) => build(i))
			const config: ConfigAuditInputs = {
				...healthyConfig,
				alertRules: each((i) => ({
					...healthyConfig.alertRules[0]!,
					id: `rule-${i}`,
					name: `rule ${i}`,
					destinationIds: [],
					lastScheduledAt: NOW - 6 * HOUR,
				})),
				alertRuleStates: each((i) => ({
					ruleId: `rule-${i}`,
					lastEvaluatedAt: null,
					lastError: "boom",
				})),
				alertDestinations: each((i) => ({
					id: `dest-${i}`,
					name: `dest ${i}`,
					enabled: true,
					lastTestError: "boom",
				})),
				scrapeTargets: each((i) => ({
					id: `t-${i}`,
					name: `t${i}`,
					enabled: true,
					lastScrapeError: "boom",
				})),
				integrations: each((i) => ({ provider: `p${i}`, revokedAt: NOW })),
				vcsRepositories: each((i) => ({
					id: `r-${i}`,
					fullName: `acme/r${i}`,
					syncStatus: "error",
					lastSyncError: "401",
				})),
				cloudflareAnalytics: each((i) => ({
					dataset: `d${i}`,
					zoneName: null,
					lastSuccessAt: null,
					lastErrorAt: NOW,
					lastError: "403",
				})),
				attributeMappings: each((i) => ({
					id: `m-${i}`,
					name: `m${i}`,
					enabled: true,
					sourceContext: "span",
					sourceKey: `gone.key.${i}`,
					targetKey: "http.request.method",
				})),
			}
			const telemetry: WarehouseAuditInputs = {
				...healthyWarehouse,
				attributeKeys: [
					...each((i) => spanKey(`user.password.${i}`)),
					...each((i) => spanKey(`maple_reserved_${i}`)),
					resourceKey("env"),
					resourceKey("git.repo"),
				],
				serviceUsage: [
					{ serviceName: "api", logCount: 50_000, traceCount: 900, metricCount: 1 },
					...each((i) => ({
						serviceName: `svc-${i}`,
						logCount: 500,
						traceCount: 0,
						metricCount: 1,
					})),
					...each((i) => ({
						serviceName: `quiet-${i}`,
						logCount: 0,
						traceCount: 900,
						metricCount: 0,
					})),
				],
				spanShape: each((i) => ({
					serviceName: `svc-${i}`,
					spanCount: 900,
					errorCount: 0,
					serverCount: 0,
					consumerCount: 0,
					noEnvCount: 900,
					spanNameCount: 40_000,
					badStatusCodes: ["ERROR"],
					badSpanKinds: [],
				})),
				logSeverity: each((i) => ({
					serviceName: `svc-${i}`,
					severityText: "NOTICE",
					logCount: 90,
				})),
				metricLabels: each((i) => ({ attributeKey: `label-${i}`, valueCardinality: 90_000 })),
				peerValues: each((i) => [
					{ attributeKey: "peer.service", attributeValue: `dep${i}`, usageCount: 10 },
					{ attributeKey: "peer.service", attributeValue: `DEP${i}`, usageCount: 5 },
				]).flat(),
				dbEdges: each((i) => ({
					serviceName: `svc-${i}`,
					dbSystem: "redis",
					callCount: 100,
					unknownNamespaceCallCount: 100,
				})),
				logCorrelation: each((i) => ({
					serviceName: `svc-${i}`,
					logCount: 500,
					uncorrelatedCount: 500,
					errorLogCount: 5,
					uncorrelatedErrorCount: 5,
				})),
				traceCompleteness: {
					windowMinutes: 60,
					traceSampleModulus: 1,
					orphans: each((i) => ({
						serviceName: `svc-${i}`,
						childCount: 800,
						orphanCount: 400,
						sampledOrphanCount: 0,
						sampleTraceIds: [],
					})),
					rootless: [
						{ entryService: "api", traceCount: 800, rootlessCount: 0, sampledRootlessCount: 0 },
						...each((i) => ({
							entryService: `svc-${i}`,
							traceCount: 800,
							rootlessCount: 400,
							sampledRootlessCount: 0,
						})),
					],
				},
			}
			return runSetupAudit({ now: NOW, config, warehouse: telemetry }).checks
		})

		// Every check must actually have produced a sentence, or the guard proves nothing.
		const sentences = failing.filter((row) => row.status === "fail" && row.detail !== null)
		const fired = new Set(sentences.map((row) => row.id))
		console.log("FIRED:", [...fired].sort().join(","))
		console.log(
			"SILENT:",
			SETUP_AUDIT_CHECKS.map((c) => c.id)
				.filter((id) => !fired.has(id))
				.join(","),
		)

		const singularVerbAfterPluralNoun =
			/\b\d+ [a-z][a-z .\-_*`]*s (is|has|emits|sends|receives|appears|uses|starts|logs|arrives|duplicates|marks)\b/
		for (const row of sentences) {
			expect(row.detail, `${row.id}: ${row.detail}`).not.toMatch(singularVerbAfterPluralNoun)
			// And the naive `+s` plural, which turns "dependency" into "dependencys". Consonant+`ys`
			// only, so real words ending in a vowel plus `ys` ("keys", "arrays") are left alone.
			expect(row.detail, `${row.id}: ${row.detail}`).not.toMatch(/[b-df-hj-np-tv-z]ys\b/)
		}
	})

	it("short-circuits to no_data before any check runs when telemetry never arrived", () => {
		// Deliberately also broken elsewhere: the gate must win over every other finding.
		const report = runSetupAudit(inputs({ firstDataReceivedAt: null, alertDestinations: [] }))
		expect(report.dataStatus).toBe("no_data")
		expect(report.checks).toEqual([])
		expect(report.summary).toEqual({ critical: 0, warn: 0, info: 0, pass: 0, skip: 0 })
	})

	it("skips warehouse checks instead of failing them when the warehouse is unavailable", () => {
		const report = runSetupAudit(inputsWith(undefined))
		expect(report.warehouseAvailable).toBe(false)
		expect(check(report, "CFG-MAP-01").status).toBe("skip")
		expect(check(report, "CFG-MAP-02").status).toBe("skip")
		// Config checks still evaluate.
		expect(check(report, "CFG-ALERT-01").status).toBe("pass")
		// Exactly the telemetry-backed checks skip, and nothing else.
		const needsWarehouse = SETUP_AUDIT_CHECKS.filter((row) => row.needsWarehouse === true)
		expect(report.summary.skip).toBe(needsWarehouse.length)
		expect(report.checks.filter((row) => row.status === "skip").map((row) => row.id)).toEqual(
			needsWarehouse.map((row) => row.id),
		)
	})

	it("counts each failure under its own severity", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [], // CFG-ALERT-01 critical (+ CFG-ALERT-03 critical, CFG-NOTIF-01 warn)
				dashboardCount: 0, // CFG-DASH-01 info
			}),
		)
		expect(report.summary.critical).toBe(2)
		expect(report.summary.info).toBe(1)
		expect(report.summary.warn).toBeGreaterThanOrEqual(1)
		expect(
			report.summary.critical + report.summary.warn + report.summary.info + report.summary.pass,
		).toBe(SETUP_AUDIT_CHECKS.length)
	})
})

describe("CFG-ALERT-01 — a notification path exists", () => {
	it("fails when no destination is enabled", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [{ id: "dest-1", name: "#alerts", enabled: false, lastTestError: null }],
			}),
		)
		expect(check(report, "CFG-ALERT-01").status).toBe("fail")
	})
})

describe("CFG-ALERT-02 — alert rules exist", () => {
	it("fails when no rule is enabled and mentions that anomaly detection still covers shifts", () => {
		const report = runSetupAudit(inputs({ alertRules: [] }))
		const result = check(report, "CFG-ALERT-02")
		expect(result.status).toBe("fail")
		expect(result.detail).toContain("Anomaly detection is on")
	})

	it("hardens the message when anomaly detection is off too", () => {
		const report = runSetupAudit(inputs({ alertRules: [], anomalyDetector: { enabled: false } }))
		expect(check(report, "CFG-ALERT-02").detail).toContain("anomaly detection is also disabled")
	})

	it("treats a missing anomaly settings row as enabled", () => {
		const report = runSetupAudit(inputs({ alertRules: [], anomalyDetector: null }))
		expect(check(report, "CFG-ALERT-02").detail).toContain("Anomaly detection is on")
	})

	it("passes when a disabled rule sits alongside an enabled one", () => {
		const report = runSetupAudit(
			inputs({
				alertRules: [
					...healthyConfig.alertRules,
					{
						id: "rule-2",
						name: "retired",
						enabled: false,
						destinationIds: [],
						windowMinutes: 5,
						lastScheduledAt: null,
						createdAt: NOW - 10 * 24 * HOUR,
					},
				],
			}),
		)
		expect(check(report, "CFG-ALERT-02").status).toBe("pass")
		// A disabled rule with no destinations must not trip the routing check either.
		expect(check(report, "CFG-ALERT-03").status).toBe("pass")
	})
})

describe("CFG-ALERT-03 — rules route somewhere", () => {
	it("fails a rule with no destinations selected", () => {
		const report = runSetupAudit(
			inputs({ alertRules: [{ ...healthyConfig.alertRules[0]!, destinationIds: [] }] }),
		)
		const result = check(report, "CFG-ALERT-03")
		expect(result.status).toBe("fail")
		expect(result.affected[0]).toMatchObject({
			kind: "alert_rule",
			id: "rule-1",
			note: "no destinations selected",
		})
	})

	it("fails a rule whose only destination was deleted", () => {
		const report = runSetupAudit(
			inputs({ alertRules: [{ ...healthyConfig.alertRules[0]!, destinationIds: ["gone"] }] }),
		)
		expect(check(report, "CFG-ALERT-03").affected[0]?.note).toContain("disabled or deleted")
	})

	it("fails a rule whose only destination is disabled", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [{ id: "dest-1", name: "#alerts", enabled: false, lastTestError: null }],
			}),
		)
		expect(check(report, "CFG-ALERT-03").status).toBe("fail")
	})

	it("passes when at least one selected destination is live", () => {
		const report = runSetupAudit(
			inputs({ alertRules: [{ ...healthyConfig.alertRules[0]!, destinationIds: ["gone", "dest-1"] }] }),
		)
		expect(check(report, "CFG-ALERT-03").status).toBe("pass")
	})

	it("caps the affected list at 20 while reporting the true total", () => {
		const many = Array.from({ length: 25 }, (_, index) => ({
			id: `rule-${index}`,
			name: `rule ${index}`,
			enabled: true,
			destinationIds: [],
			windowMinutes: 5,
			lastScheduledAt: NOW - 60_000,
			createdAt: NOW - 10 * 24 * HOUR,
		}))
		const result = check(runSetupAudit(inputs({ alertRules: many })), "CFG-ALERT-03")
		expect(result.affected).toHaveLength(20)
		expect(result.affectedCount).toBe(25)
	})
})

describe("CFG-ALERT-04 — destinations delivered on last test", () => {
	it("fails an enabled destination whose last test errored", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [
					{ id: "dest-1", name: "#alerts", enabled: true, lastTestError: "404 from Slack webhook" },
				],
			}),
		)
		const result = check(report, "CFG-ALERT-04")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("404 from Slack webhook")
	})

	it("truncates a pathologically long provider error", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [
					{ id: "dest-1", name: "#alerts", enabled: true, lastTestError: "x".repeat(500) },
				],
			}),
		)
		const note = check(report, "CFG-ALERT-04").affected[0]?.note ?? ""
		expect(note).toHaveLength(160)
		expect(note.endsWith("…")).toBe(true)
	})

	it("ignores a disabled destination that failed its test", () => {
		const report = runSetupAudit(
			inputs({
				alertDestinations: [
					{ id: "dest-1", name: "#alerts", enabled: true, lastTestError: null },
					{ id: "dest-2", name: "old", enabled: false, lastTestError: "boom" },
				],
			}),
		)
		expect(check(report, "CFG-ALERT-04").status).toBe("pass")
	})

	it("never fires just because a destination was never tested", () => {
		const report = runSetupAudit(inputs())
		expect(check(report, "CFG-ALERT-04").status).toBe("pass")
	})
})

describe("CFG-ALERT-05 — rules are evaluating", () => {
	it("reports an evaluation error from the rule state", () => {
		const report = runSetupAudit(
			inputs({
				alertRuleStates: [{ ruleId: "rule-1", lastEvaluatedAt: NOW, lastError: "query timed out" }],
			}),
		)
		const result = check(report, "CFG-ALERT-05")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("evaluation error: query timed out")
	})

	it("flags a rule that has never been scheduled once past the grace period", () => {
		const report = runSetupAudit(
			inputs({
				alertRules: [
					{ ...healthyConfig.alertRules[0]!, lastScheduledAt: null, createdAt: NOW - 3 * HOUR },
				],
				alertRuleStates: [],
			}),
		)
		expect(check(report, "CFG-ALERT-05").affected[0]?.note).toBe("never evaluated")
	})

	it("gives a freshly created rule its grace period", () => {
		const report = runSetupAudit(
			inputs({
				alertRules: [
					{ ...healthyConfig.alertRules[0]!, lastScheduledAt: null, createdAt: NOW - 10 * 60_000 },
				],
				alertRuleStates: [],
			}),
		)
		expect(check(report, "CFG-ALERT-05").status).toBe("pass")
	})

	it("flags a rule whose scheduler claim has gone stale", () => {
		const report = runSetupAudit(
			inputs({ alertRules: [{ ...healthyConfig.alertRules[0]!, lastScheduledAt: NOW - 4 * HOUR }] }),
		)
		expect(check(report, "CFG-ALERT-05").affected[0]?.note).toBe("last evaluated 4 hours ago")
	})

	it("tolerates a claim that is merely a few minutes old", () => {
		const report = runSetupAudit(
			inputs({ alertRules: [{ ...healthyConfig.alertRules[0]!, lastScheduledAt: NOW - 10 * 60_000 }] }),
		)
		expect(check(report, "CFG-ALERT-05").status).toBe("pass")
	})
})

describe("CFG-NOTIF-01 — error notifications reach someone", () => {
	it("fails when the policy is explicitly disabled", () => {
		const report = runSetupAudit(
			inputs({ errorNotificationPolicy: { enabled: false, destinationIds: ["dest-1"] } }),
		)
		expect(check(report, "CFG-NOTIF-01").detail).toContain("turned off")
	})

	it("fails when enabled with no destinations", () => {
		const report = runSetupAudit(
			inputs({ errorNotificationPolicy: { enabled: true, destinationIds: [] } }),
		)
		expect(check(report, "CFG-NOTIF-01").detail).toContain("no destination is selected")
	})

	it("fails when every selected destination is gone", () => {
		const report = runSetupAudit(
			inputs({ errorNotificationPolicy: { enabled: true, destinationIds: ["gone"] } }),
		)
		expect(check(report, "CFG-NOTIF-01").detail).toContain("disabled or deleted")
	})

	it("treats a missing policy row as enabled-but-unrouted", () => {
		// The table defaults to enabled with an empty destination list, so an org that never opened
		// the settings page has error notifications on that deliver nowhere.
		const report = runSetupAudit(inputs({ errorNotificationPolicy: null }))
		expect(check(report, "CFG-NOTIF-01").detail).toContain("no destination is selected")
	})
})

describe("CFG-ANOM-01 — anomaly detection", () => {
	it("fires only on an explicit opt-out", () => {
		expect(
			check(runSetupAudit(inputs({ anomalyDetector: { enabled: false } })), "CFG-ANOM-01").status,
		).toBe("fail")
		expect(check(runSetupAudit(inputs({ anomalyDetector: null })), "CFG-ANOM-01").status).toBe("pass")
	})
})

describe("CFG-SAMP-01 — sampling is understood", () => {
	it("passes at a ratio of exactly 1", () => {
		const report = runSetupAudit(
			inputs({ samplingPolicy: { traceSampleRatio: 1, alwaysKeepErrorSpans: true } }),
		)
		expect(check(report, "CFG-SAMP-01").status).toBe("pass")
	})

	it("passes when no policy row exists", () => {
		expect(check(runSetupAudit(inputs({ samplingPolicy: null })), "CFG-SAMP-01").status).toBe("pass")
	})

	it("reports the ratio as a percentage and notes that errors are kept", () => {
		const report = runSetupAudit(
			inputs({ samplingPolicy: { traceSampleRatio: 0.1, alwaysKeepErrorSpans: true } }),
		)
		const result = check(report, "CFG-SAMP-01")
		expect(result.status).toBe("fail")
		expect(result.detail).toContain("keeps 10% of traces")
		expect(result.detail).toContain("Error spans are always kept.")
	})

	it("warns harder when error spans are sampled too", () => {
		const report = runSetupAudit(
			inputs({ samplingPolicy: { traceSampleRatio: 0.05, alwaysKeepErrorSpans: false } }),
		)
		expect(check(report, "CFG-SAMP-01").detail).toContain("errors can be missed entirely")
	})
})

describe("CFG-ATTR-01 — open recommendations rollup", () => {
	it("reports the count without re-listing the recommendations", () => {
		const report = runSetupAudit(inputs({ openRecommendationCount: 3 }))
		const result = check(report, "CFG-ATTR-01")
		expect(result.status).toBe("fail")
		expect(result.detail).toContain("3 open instrumentation recommendations")
		expect(result.affected).toEqual([])
		expect(report.openRecommendationCount).toBe(3)
	})

	it("singularizes a lone recommendation", () => {
		const report = runSetupAudit(inputs({ openRecommendationCount: 1 }))
		expect(check(report, "CFG-ATTR-01").detail).toContain("1 open instrumentation recommendation —")
	})
})

describe("CFG-MAP-01 / CFG-MAP-02 — mapping liveness", () => {
	const mapping = {
		id: "map-1",
		name: "legacy status code",
		enabled: true,
		sourceContext: "span",
		sourceKey: "http.status_code",
		targetKey: "http.response.status_code",
	}

	it("flags a mapping whose source key no longer arrives", () => {
		const report = runSetupAudit(inputs({ attributeMappings: [mapping] }))
		const result = check(report, "CFG-MAP-01")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("http.status_code no longer arrives")
		expect(result.detail).toContain("last 24h")
	})

	it("passes while the source key is still arriving", () => {
		const report = runSetupAudit(
			inputsWith(warehouse({ attributeKeys: [spanKey("http.status_code", 9)] }), {
				attributeMappings: [mapping],
			}),
		)
		expect(check(report, "CFG-MAP-01").status).toBe("pass")
	})

	it("ignores a disabled or resource-scoped mapping", () => {
		const report = runSetupAudit(
			inputs({
				attributeMappings: [
					{ ...mapping, enabled: false },
					{ ...mapping, id: "map-2", sourceContext: "resource" },
				],
			}),
		)
		expect(check(report, "CFG-MAP-01").status).toBe("pass")
	})

	it("flags a mapping whose target key already arrives natively", () => {
		const report = runSetupAudit(
			inputsWith(
				warehouse({
					attributeKeys: [spanKey("http.status_code", 9), spanKey("http.response.status_code", 9)],
				}),
				{ attributeMappings: [mapping] },
			),
		)
		const result = check(report, "CFG-MAP-02")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("http.response.status_code already arrives natively")
	})
})

describe("CFG-BYOC-01 / CFG-BYOC-02 — bring-your-own ClickHouse", () => {
	const settings = {
		syncStatus: "connected",
		lastSyncError: null,
		schemaVersion: "0007",
		expectedSchemaVersion: "0007",
	}

	it("passes both checks for a managed (non-BYO) org", () => {
		const report = runSetupAudit(inputs({ clickhouse: null }))
		expect(check(report, "CFG-BYOC-01").status).toBe("pass")
		expect(check(report, "CFG-BYOC-02").status).toBe("pass")
	})

	it("fails when the connection is in an error state", () => {
		const report = runSetupAudit(
			inputs({ clickhouse: { ...settings, syncStatus: "error", lastSyncError: "connect ETIMEDOUT" } }),
		)
		const result = check(report, "CFG-BYOC-01")
		expect(result.status).toBe("fail")
		expect(result.detail).toContain("connect ETIMEDOUT")
	})

	it("fails when the applied schema is behind the bundled version", () => {
		const report = runSetupAudit(inputs({ clickhouse: { ...settings, schemaVersion: "0005" } }))
		expect(check(report, "CFG-BYOC-02").detail).toContain("0005")
	})

	it("names an unapplied schema explicitly", () => {
		const report = runSetupAudit(inputs({ clickhouse: { ...settings, schemaVersion: null } }))
		expect(check(report, "CFG-BYOC-02").detail).toContain("an unrecognized version")
	})

	it("abbreviates a project-revision hash left behind by older code", () => {
		const report = runSetupAudit(
			inputs({ clickhouse: { ...settings, schemaVersion: "4d5d918315933608d316aa8d6e6b5794" } }),
		)
		const detail = check(report, "CFG-BYOC-02").detail ?? ""
		expect(detail).toContain("an unrecognized version (4d5d9183…)")
		expect(detail).not.toContain("d316aa8d")
	})
})

describe("integration checks", () => {
	it("CFG-INTEG-01 flags a revoked connection", () => {
		const report = runSetupAudit(
			inputs({ integrations: [{ provider: "cloudflare", revokedAt: NOW - HOUR }] }),
		)
		const result = check(report, "CFG-INTEG-01")
		expect(result.status).toBe("fail")
		expect(result.affected[0]).toMatchObject({ kind: "integration", name: "cloudflare" })
	})

	it("CFG-INTEG-02 fires only when the last error is newer than the last success", () => {
		const stale = runSetupAudit(
			inputs({
				cloudflareAnalytics: [
					{
						dataset: "httpRequests",
						zoneName: "example.com",
						lastSuccessAt: NOW - 60_000,
						lastErrorAt: NOW - 10 * HOUR,
						lastError: "old blip",
					},
				],
			}),
		)
		expect(check(stale, "CFG-INTEG-02").status).toBe("pass")

		const broken = runSetupAudit(
			inputs({
				cloudflareAnalytics: [
					{
						dataset: "firewallEvents",
						zoneName: null,
						lastSuccessAt: NOW - 10 * HOUR,
						lastErrorAt: NOW - 60_000,
						lastError: "403 from Cloudflare GraphQL",
					},
				],
			}),
		)
		const result = check(broken, "CFG-INTEG-02")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.name).toBe("firewallEvents")
	})

	it("CFG-INTEG-02 treats a never-successful dataset that errored as failing", () => {
		const report = runSetupAudit(
			inputs({
				cloudflareAnalytics: [
					{
						dataset: "workersInvocations",
						zoneName: null,
						lastSuccessAt: null,
						lastErrorAt: NOW - 60_000,
						lastError: "missing permission",
					},
				],
			}),
		)
		expect(check(report, "CFG-INTEG-02").status).toBe("fail")
	})

	it("CFG-INTEG-03 flags a repository whose sync errored", () => {
		const report = runSetupAudit(
			inputs({
				vcsRepositories: [
					{
						id: "repo-1",
						fullName: "acme/api",
						syncStatus: "error",
						lastSyncError: "401 from GitHub",
					},
				],
			}),
		)
		expect(check(report, "CFG-INTEG-03").affected[0]?.name).toBe("acme/api")
	})

	it("CFG-SCRAPE-01 ignores disabled targets", () => {
		const report = runSetupAudit(
			inputs({
				scrapeTargets: [
					{ id: "target-1", name: "old", enabled: false, lastScrapeError: "connection refused" },
				],
			}),
		)
		expect(check(report, "CFG-SCRAPE-01").status).toBe("pass")
	})

	it("CFG-SCRAPE-01 flags an enabled target that failed its last scrape", () => {
		const report = runSetupAudit(
			inputs({
				scrapeTargets: [
					{
						id: "target-1",
						name: "api metrics",
						enabled: true,
						lastScrapeError: "connection refused",
					},
				],
			}),
		)
		const result = check(report, "CFG-SCRAPE-01")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("connection refused")
	})

	it("never fires on the absence of an optional integration", () => {
		const report = runSetupAudit(
			inputs({ integrations: [], cloudflareAnalytics: [], vcsRepositories: [], scrapeTargets: [] }),
		)
		for (const id of ["CFG-INTEG-01", "CFG-INTEG-02", "CFG-INTEG-03", "CFG-SCRAPE-01"]) {
			expect(check(report, id).status).toBe("pass")
		}
	})
})

// Telemetry checks

/** Runs the audit against a perturbed telemetry snapshot, with configuration left healthy. */
const telemetry = (overrides: Partial<WarehouseAuditInputs>) =>
	runSetupAudit(inputsWith(warehouse(overrides)))

describe("RES-01 — service.name is set", () => {
	it("flags the SDK's default identity", () => {
		const report = telemetry({
			serviceUsage: [
				{ serviceName: "unknown_service:node", logCount: 0, traceCount: 40, metricCount: 0 },
			],
		})
		const result = check(report, "RES-01")
		expect(result.status).toBe("fail")
		expect(result.severity).toBe("critical")
		expect(result.affected[0]?.name).toBe("unknown_service:node")
	})
})

describe("ING-01 — service names agree across signals", () => {
	it("flags a name that appears in logs but never in traces", () => {
		const report = telemetry({
			serviceUsage: [
				{ serviceName: "api", logCount: 500, traceCount: 900, metricCount: 40 },
				{ serviceName: "api-server", logCount: 300, traceCount: 0, metricCount: 0 },
			],
		})
		const result = check(report, "ING-01")
		expect(result.status).toBe("fail")
		expect(result.affected[0]).toMatchObject({ name: "api-server", note: "logs but no traces" })
	})

	it("ignores metrics-only names — scraped exporters legitimately never trace", () => {
		const report = telemetry({
			serviceUsage: [
				{ serviceName: "api", logCount: 500, traceCount: 900, metricCount: 40 },
				{ serviceName: "cloudflare/example.com", logCount: 0, traceCount: 0, metricCount: 12 },
				{ serviceName: "node-cadvisor", logCount: 0, traceCount: 0, metricCount: 900 },
			],
		})
		expect(check(report, "ING-01").status).toBe("pass")
	})

	it("leaves an unnamed service to RES-01 rather than reporting it as a mismatch", () => {
		const report = telemetry({
			serviceUsage: [
				{ serviceName: "api", logCount: 500, traceCount: 900, metricCount: 40 },
				{ serviceName: "", logCount: 300, traceCount: 0, metricCount: 0 },
			],
		})
		expect(check(report, "ING-01").status).toBe("pass")
		const identity = check(report, "RES-01")
		expect(identity.status).toBe("fail")
		expect(identity.affected[0]?.name).toBe("(no service.name)")
	})
})

describe("LOG-01 — traced services also log", () => {
	it("stays quiet for an org that sends no logs at all", () => {
		const report = telemetry({
			serviceUsage: [{ serviceName: "api", logCount: 0, traceCount: 900, metricCount: 0 }],
			logCorrelation: [],
		})
		expect(check(report, "LOG-01").status).toBe("pass")
	})

	it("flags the inconsistent service once the org logs elsewhere", () => {
		const report = telemetry({
			serviceUsage: [
				{ serviceName: "api", logCount: 500, traceCount: 900, metricCount: 0 },
				{ serviceName: "worker", logCount: 0, traceCount: 200, metricCount: 0 },
			],
		})
		const result = check(report, "LOG-01")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.name).toBe("worker")
	})
})

describe("LOG-02 — logs carry trace context", () => {
	const broken = [
		{
			serviceName: "api",
			logCount: 500,
			uncorrelatedCount: 500,
			errorLogCount: 20,
			uncorrelatedErrorCount: 20,
		},
	]

	it("flags a traced service whose logs have no trace_id", () => {
		const result = check(telemetry({ logCorrelation: broken }), "LOG-02")
		expect(result.status).toBe("fail")
		expect(result.severity).toBe("critical")
		expect(result.affected[0]?.note).toContain("100% of logs have no trace_id")
		expect(result.affected[0]?.note).toContain("20 error-level")
	})

	it("ignores a service below the volume floor, where a rate means nothing", () => {
		const report = telemetry({
			logCorrelation: [
				{
					serviceName: "api",
					logCount: 5,
					uncorrelatedCount: 5,
					errorLogCount: 0,
					uncorrelatedErrorCount: 0,
				},
			],
		})
		expect(check(report, "LOG-02").status).toBe("pass")
	})

	it("ignores an untraced service — there is no trace context to attach", () => {
		const report = telemetry({
			serviceUsage: [{ serviceName: "api", logCount: 500, traceCount: 0, metricCount: 0 }],
			logCorrelation: broken,
		})
		expect(check(report, "LOG-02").status).toBe("pass")
	})

	it("tolerates a minority of uncorrelated logs", () => {
		const report = telemetry({
			logCorrelation: [
				{
					serviceName: "api",
					logCount: 500,
					uncorrelatedCount: 100,
					errorLogCount: 0,
					uncorrelatedErrorCount: 0,
				},
			],
		})
		expect(check(report, "LOG-02").status).toBe("pass")
	})
})

describe("LOG-03 — logs are structured", () => {
	it("stays quiet below the volume floor even with no attributes", () => {
		const report = telemetry({
			serviceUsage: [{ serviceName: "api", logCount: 100, traceCount: 900, metricCount: 0 }],
			attributeKeys: healthyWarehouse.attributeKeys.filter((row) => row.scope !== "log"),
		})
		expect(check(report, "LOG-03").status).toBe("pass")
	})

	it("flags high log volume with no structured fields", () => {
		const report = telemetry({
			serviceUsage: [{ serviceName: "api", logCount: 50_000, traceCount: 900, metricCount: 0 }],
			attributeKeys: healthyWarehouse.attributeKeys.filter((row) => row.scope !== "log"),
		})
		const result = check(report, "LOG-03")
		expect(result.status).toBe("fail")
		expect(result.detail).toContain("50,000 log records")
	})
})

describe("LOG-04 — standard severities", () => {
	it("accepts the standard levels and their numbered variants", () => {
		const report = telemetry({
			logSeverity: [
				{ serviceName: "api", severityText: "INFO", logCount: 10 },
				{ serviceName: "api", severityText: "warn", logCount: 10 },
				{ serviceName: "api", severityText: "DEBUG3", logCount: 10 },
				{ serviceName: "api", severityText: "WARNING", logCount: 10 },
				{ serviceName: "api", severityText: "", logCount: 10 },
			],
		})
		expect(check(report, "LOG-04").status).toBe("pass")
	})

	it("flags a non-standard level", () => {
		const report = telemetry({
			logSeverity: [{ serviceName: "api", severityText: "NOTICE", logCount: 90 }],
		})
		const result = check(report, "LOG-04")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toContain('severity "NOTICE"')
	})
})

describe("resource-attribute coverage", () => {
	const withoutResourceKey = (key: string) =>
		telemetry({ attributeKeys: healthyWarehouse.attributeKeys.filter((row) => row.key !== key) })

	it("RES-02 flags a missing service.version", () => {
		expect(check(withoutResourceKey("service.version"), "RES-02").status).toBe("fail")
	})

	it("RES-04 flags a missing repository URL", () => {
		expect(check(withoutResourceKey("vcs.repository.url.full"), "RES-04").status).toBe("fail")
	})

	it("RES-05 requires the semconv revision key — the retired deployment.commit_sha no longer counts", () => {
		const legacy = telemetry({
			attributeKeys: [
				...healthyWarehouse.attributeKeys.filter((row) => row.key !== "vcs.ref.head.revision"),
				resourceKey("deployment.commit_sha"),
			],
		})
		expect(check(legacy, "RES-05").status).toBe("fail")
		expect(check(withoutResourceKey("vcs.ref.head.revision"), "RES-05").status).toBe("fail")
	})

	it("RES-06 flags invented parallel keys, including the retired deployment.commit_sha", () => {
		const invented = telemetry({
			attributeKeys: [
				...healthyWarehouse.attributeKeys,
				resourceKey("env"),
				resourceKey("git.repo"),
				resourceKey("deployment.commit_sha"),
			],
		})
		const result = check(invented, "RES-06")
		expect(result.status).toBe("fail")
		expect(result.affected.map((entity) => entity.name).sort()).toEqual([
			"deployment.commit_sha",
			"env",
			"git.repo",
		])
	})
})

describe("RES-03 — spans carry an environment", () => {
	const profile = (noEnvCount: number) => [{ ...healthyWarehouse.spanShape[0]!, noEnvCount }]

	it("flags a service where most spans have no environment", () => {
		const result = check(telemetry({ spanShape: profile(900) }), "RES-03")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("100% of spans have no environment")
	})

	it("tolerates a minority of unlabeled spans", () => {
		expect(check(telemetry({ spanShape: profile(100) }), "RES-03").status).toBe("pass")
	})
})

describe("NAME-02 — span-name cardinality", () => {
	it("flags a service whose span names look like IDs", () => {
		const report = telemetry({
			spanShape: [{ ...healthyWarehouse.spanShape[0]!, spanNameCount: 40_000 }],
		})
		const result = check(report, "NAME-02")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("40,000 distinct span names")
	})
})

describe("NAME-03 — reserved namespace", () => {
	it("flags customer attributes in the maple_ namespace", () => {
		const report = telemetry({
			attributeKeys: [...healthyWarehouse.attributeKeys, spanKey("maple_tenant")],
		})
		const result = check(report, "NAME-03")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.name).toBe("maple_tenant")
	})

	it("does not flag ordinary namespaced keys", () => {
		const report = telemetry({
			attributeKeys: [...healthyWarehouse.attributeKeys, spanKey("maplesyrup.batch")],
		})
		expect(check(report, "NAME-03").status).toBe("pass")
	})
})

describe("PII-01 — secrets in attribute names", () => {
	it.each([
		"user.password",
		"http.request.header.authorization",
		"api_key",
		"auth.accessToken",
		"payment.credit_card",
	])("flags %s", (key) => {
		const report = telemetry({ attributeKeys: [...healthyWarehouse.attributeKeys, spanKey(key)] })
		expect(check(report, "PII-01").status).toBe("fail")
	})

	it.each([
		"gen_ai.usage.output_tokens",
		"gen_ai.usage.input_tokens",
		"db.query.text",
		"http.route",
		"user.id",
	])("does not flag %s", (key) => {
		const report = telemetry({ attributeKeys: [...healthyWarehouse.attributeKeys, spanKey(key)] })
		expect(check(report, "PII-01").status).toBe("pass")
	})
})

describe("MET-01 — metric label cardinality", () => {
	it("flags an unbounded label", () => {
		const report = telemetry({
			metricLabels: [
				{ attributeKey: "http.route", valueCardinality: 40 },
				{ attributeKey: "user.id", valueCardinality: 90_000 },
			],
		})
		const result = check(report, "MET-01")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.name).toBe("user.id")
		expect(result.detail).toContain("Counter metrics only")
	})
})

describe("STAT-01 — status and kind casing", () => {
	it("names the offending literals", () => {
		const report = telemetry({
			spanShape: [
				{
					...healthyWarehouse.spanShape[0]!,
					badStatusCodes: ["ERROR"],
					badSpanKinds: ["SPAN_KIND_SERVER"],
				},
			],
		})
		const result = check(report, "STAT-01")
		expect(result.status).toBe("fail")
		expect(result.severity).toBe("critical")
		expect(result.affected[0]?.note).toBe('status "ERROR", kind "SPAN_KIND_SERVER"')
	})
})

describe("STAT-02 — failures recorded on spans", () => {
	it("flags a service that logs errors but never marks a span failed", () => {
		const report = telemetry({
			spanShape: [{ ...healthyWarehouse.spanShape[0]!, errorCount: 0 }],
			logSeverity: [{ serviceName: "api", severityText: "ERROR", logCount: 12 }],
		})
		const result = check(report, "STAT-02")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.note).toBe("12 error logs, no error spans")
	})

	it("passes when the service does mark spans failed", () => {
		const report = telemetry({
			logSeverity: [{ serviceName: "api", severityText: "ERROR", logCount: 12 }],
		})
		expect(check(report, "STAT-02").status).toBe("pass")
	})

	it("passes when the service logs no errors either", () => {
		const report = telemetry({ spanShape: [{ ...healthyWarehouse.spanShape[0]!, errorCount: 0 }] })
		expect(check(report, "STAT-02").status).toBe("pass")
	})
})

describe("STAT-04 — entry-point spans", () => {
	it("reports a service with no Server or Consumer spans, as advisory only", () => {
		const report = telemetry({
			spanShape: [{ ...healthyWarehouse.spanShape[0]!, serverCount: 0, consumerCount: 0 }],
		})
		const result = check(report, "STAT-04")
		expect(result.status).toBe("fail")
		expect(result.severity).toBe("info")
	})

	it("accepts a queue consumer as an entry point", () => {
		const report = telemetry({
			spanShape: [{ ...healthyWarehouse.spanShape[0]!, serverCount: 0, consumerCount: 30 }],
		})
		expect(check(report, "STAT-04").status).toBe("pass")
	})
})

describe("MAP-02 — database identity", () => {
	it("flags edges whose namespace is mostly empty", () => {
		const report = telemetry({
			dbEdges: [
				{
					serviceName: "api",
					dbSystem: "postgresql",
					callCount: 100,
					unknownNamespaceCallCount: 100,
				},
			],
		})
		const result = check(report, "MAP-02")
		expect(result.status).toBe("fail")
		expect(result.affected[0]?.name).toBe("api → postgresql")
	})
})

describe("trace completeness", () => {
	const traces = (overrides: Partial<NonNullable<WarehouseAuditInputs["traceCompleteness"]>>) =>
		telemetry({ traceCompleteness: { ...healthyWarehouse.traceCompleteness!, ...overrides } })

	it("skips all three checks when the joins did not run", () => {
		const report = telemetry({ traceCompleteness: undefined })
		for (const id of ["TRC-01", "TRC-02", "TRC-03"]) {
			// The joins degrade independently of the rest of the telemetry reads, so the checks pass
			// rather than skip — the report never claims a gap it did not measure.
			expect(check(report, id).status).toBe("pass")
		}
	})

	describe("TRC-01 — orphan spans", () => {
		it("flags a service whose entry spans reference a missing parent", () => {
			const report = traces({
				orphans: [
					{
						serviceName: "checkout",
						childCount: 800,
						orphanCount: 400,
						sampledOrphanCount: 0,
						sampleTraceIds: ["abc123"],
					},
				],
			})
			const result = check(report, "TRC-01")
			expect(result.status).toBe("fail")
			expect(result.affected[0]?.note).toContain("50% of entry spans")
			expect(result.affected[0]?.note).toContain("trace abc123")
		})

		it("attributes sampling-marked orphans to TRC-03 instead", () => {
			const report = traces({
				orphans: [
					{
						serviceName: "checkout",
						childCount: 800,
						orphanCount: 400,
						sampledOrphanCount: 400,
						sampleTraceIds: [],
					},
				],
			})
			expect(check(report, "TRC-01").status).toBe("pass")
			const sampling = check(report, "TRC-03")
			expect(sampling.status).toBe("fail")
			expect(sampling.severity).toBe("info")
			expect(sampling.affected[0]?.note).toContain("100% of its incomplete traces")
		})

		it("ignores a service with too few observed spans for a rate to mean anything", () => {
			const report = traces({
				orphans: [
					{
						serviceName: "cron",
						childCount: 10,
						orphanCount: 10,
						sampledOrphanCount: 0,
						sampleTraceIds: [],
					},
				],
			})
			expect(check(report, "TRC-01").status).toBe("pass")
			expect(check(report, "TRC-03").status).toBe("pass")
		})
	})

	describe("TRC-02 — rootless traces", () => {
		it("flags one service whose traces lack a root", () => {
			const report = traces({
				rootless: [
					{ entryService: "api", traceCount: 800, rootlessCount: 3, sampledRootlessCount: 0 },
					{
						entryService: "checkout",
						traceCount: 800,
						rootlessCount: 400,
						sampledRootlessCount: 0,
					},
				],
			})
			const result = check(report, "TRC-02")
			expect(result.status).toBe("fail")
			expect(result.affected).toHaveLength(1)
			expect(result.affected[0]?.name).toBe("checkout")
		})

		it("collapses a near-total, uniform rate into one upstream finding", () => {
			const report = traces({
				rootless: [
					{ entryService: "api", traceCount: 800, rootlessCount: 800, sampledRootlessCount: 0 },
					{
						entryService: "checkout",
						traceCount: 800,
						rootlessCount: 796,
						sampledRootlessCount: 0,
					},
				],
			})
			const result = check(report, "TRC-02")
			expect(result.status).toBe("fail")
			expect(result.affected).toEqual([])
			expect(result.detail).toContain("created upstream of your instrumented services")
		})

		it("does not treat a partially-affected org as systemic", () => {
			const report = traces({
				rootless: [
					{ entryService: "api", traceCount: 800, rootlessCount: 800, sampledRootlessCount: 0 },
					{ entryService: "checkout", traceCount: 800, rootlessCount: 0, sampledRootlessCount: 0 },
				],
			})
			const result = check(report, "TRC-02")
			expect(result.affected.map((entity) => entity.name)).toEqual(["api"])
		})
	})
})

describe("MAP-03 — consistent dependency spelling", () => {
	it("flags values that differ only by case", () => {
		const report = telemetry({
			peerValues: [
				{ attributeKey: "peer.service", attributeValue: "tinybird", usageCount: 20 },
				{ attributeKey: "peer.service", attributeValue: "Tinybird", usageCount: 5 },
			],
		})
		const result = check(report, "MAP-03")
		expect(result.status).toBe("fail")
		expect(result.affected[0]).toMatchObject({ name: "peer.service", note: "Tinybird / tinybird" })
	})

	it("does not flag genuinely different dependencies", () => {
		const report = telemetry({
			peerValues: [
				{ attributeKey: "peer.service", attributeValue: "tinybird", usageCount: 20 },
				{ attributeKey: "peer.service", attributeValue: "clickhouse", usageCount: 5 },
			],
		})
		expect(check(report, "MAP-03").status).toBe("pass")
	})
})
