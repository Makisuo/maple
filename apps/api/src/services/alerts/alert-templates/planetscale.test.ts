import { assert, describe, it } from "@effect/vitest"
import { AlertRuleUpsertRequest, MAX_ALERT_WINDOW_MINUTES } from "@maple/domain/http"
import { Schema } from "effect"
import { ALERT_TEMPLATES, getAlertTemplate } from "./index"

const DESTINATIONS = ["11111111-1111-4111-8111-111111111111"]

const decode = Schema.decodeUnknownSync(AlertRuleUpsertRequest)

const buildAll = (values: Record<string, string> = {}) =>
	ALERT_TEMPLATES.flatMap((template) =>
		template
			.build({ values, destinationIds: DESTINATIONS, enabled: true })
			.map((rule) => ({ templateId: template.id, rule })),
	)

describe("PlanetScale alert templates", () => {
	it("produces rules that round-trip through the upsert schema", () => {
		// This is the test that catches a template whose rule would only fail at
		// creation time, in front of the operator who clicked "Apply".
		for (const { templateId, rule } of buildAll({ threshold: "800", database: "main-db" })) {
			assert.doesNotThrow(() => decode(rule), `${templateId} produced an invalid rule`)
		}
	})

	it("stays within the alert window cap", () => {
		for (const { templateId, rule } of buildAll({ threshold: "800" })) {
			assert.isAtMost(
				rule.windowMinutes,
				MAX_ALERT_WINDOW_MINUTES,
				`${templateId} exceeds the window cap`,
			)
		}
	})

	it("tags every rule with its template so 'already applied' needs no new column", () => {
		for (const { templateId, rule } of buildAll({ threshold: "800" })) {
			assert.include(rule.tags ?? [], `template:${templateId}`)
			assert.include(rule.tags ?? [], "planetscale")
		}
	})

	it("emits one rule per product for the metrics that differ by engine", () => {
		// MySQL and Postgres report replication lag under different names; an
		// operator asking for "replica lag" means both.
		const lag = getAlertTemplate("ps-replica-lag")!
		const rules = lag.build({ values: {}, destinationIds: DESTINATIONS, enabled: true })
		assert.strictEqual(rules.length, 2)
		const metrics = rules.map((rule) =>
			rule.queryBuilderDraft !== null && rule.queryBuilderDraft !== undefined
				? (rule.queryBuilderDraft as { metricName?: string }).metricName
				: undefined,
		)
		assert.includeMembers(metrics, [
			"planetscale_mysql_replica_lag_seconds",
			"planetscale_postgres_replica_lag_seconds",
		])
	})

	it("groups by branch rather than filtering on it", () => {
		// Metrics queries honor exactly one attr.* equality, so a database+branch
		// filter would silently drop the branch and alert on every branch.
		const lag = getAlertTemplate("ps-replica-lag")!
		const [rule] = lag.build({
			values: { database: "main-db" },
			destinationIds: DESTINATIONS,
			enabled: true,
		})
		const draft = rule!.queryBuilderDraft as { whereClause: string; groupBy: string[] }
		assert.strictEqual(draft.whereClause, "attr.planetscale_database_name = 'main-db'")
		assert.deepStrictEqual(draft.groupBy, ["attr.planetscale_branch_name"])
	})

	it("watches every database when none is named", () => {
		const lag = getAlertTemplate("ps-replica-lag")!
		const [rule] = lag.build({ values: {}, destinationIds: DESTINATIONS, enabled: true })
		assert.strictEqual((rule!.queryBuilderDraft as { whereClause: string }).whereClause, "")
	})

	it("escapes a quote in a database name rather than breaking the where clause", () => {
		const lag = getAlertTemplate("ps-replica-lag")!
		const [rule] = lag.build({
			values: { database: "it's-db" },
			destinationIds: DESTINATIONS,
			enabled: true,
		})
		assert.strictEqual(
			(rule!.queryBuilderDraft as { whereClause: string }).whereClause,
			"attr.planetscale_database_name = 'it''s-db'",
		)
	})

	it("uses raw SQL exactly where the metrics builder can't express the question", () => {
		// A ratio of two metrics, and a regression over one — neither is a
		// builder query.
		for (const id of ["ps-storage-used", "ps-storage-runway"]) {
			const [rule] = getAlertTemplate(id)!.build({
				values: {},
				destinationIds: DESTINATIONS,
				enabled: true,
			})
			assert.strictEqual(rule!.signalType, "raw_query", id)
			assert.isString(rule!.rawQuerySql)
			assert.isNotNull(rule!.rawQueryReducer ?? null)
		}
	})

	it("reduces the runway rule to the branch with the least headroom", () => {
		const [rule] = getAlertTemplate("ps-storage-runway")!.build({
			values: {},
			destinationIds: DESTINATIONS,
			enabled: true,
		})
		assert.strictEqual(rule!.comparator, "lt")
		assert.strictEqual(rule!.rawQueryReducer, "min")
	})

	it("falls back to the documented default when a numeric parameter is unparseable", () => {
		const [rule] = getAlertTemplate("ps-replica-lag")!.build({
			values: { thresholdSeconds: "not-a-number" },
			destinationIds: DESTINATIONS,
			enabled: true,
		})
		assert.strictEqual(rule!.threshold, 30)
	})

	it("does not duplicate branch OOM as a metric rule", () => {
		// It arrives as a webhook, already opens a triage issue, and already
		// notifies. A second path would double-page on an event that is not a metric.
		assert.isUndefined(
			ALERT_TEMPLATES.find((template) => template.id.includes("oom")),
			"branch OOM must stay in the issue hub",
		)
	})
})
