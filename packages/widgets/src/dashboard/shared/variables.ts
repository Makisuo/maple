import { Schema } from "effect"

// Dashboard variables

// Must not start with an underscore so `$name` references can never collide
// with the `$__` built-in macros ($__startTime, $__timeFilter, ...).
export const DashboardVariableName = Schema.String.check(
	Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]*$/),
).annotate({ identifier: "@maple/DashboardVariableName", title: "Dashboard Variable Name" })
export type DashboardVariableName = Schema.Schema.Type<typeof DashboardVariableName>

/**
 * Auto-refresh cadence in seconds; `0` or absent means off. A closed literal set
 * rather than a free number so a hand-edited document (or `?refresh=`) can't ask
 * the browser to re-query every 100ms.
 */
export const DashboardRefreshIntervalSeconds = Schema.Literals([0, 5, 10, 30, 60, 300, 900]).annotate({
	identifier: "@maple/DashboardRefreshIntervalSeconds",
	title: "Dashboard Refresh Interval Seconds",
})
export type DashboardRefreshIntervalSeconds = typeof DashboardRefreshIntervalSeconds.Type

export const DashboardQueryVariableFacet = Schema.Literals([
	"service",
	"environment",
	"span_name",
	"http_method",
	"http_status_code",
	"log_severity",
])
export type DashboardQueryVariableFacet = typeof DashboardQueryVariableFacet.Type

export const DashboardQueryVariableSourceSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("facet"),
		facet: DashboardQueryVariableFacet,
	}),
	Schema.Struct({
		kind: Schema.Literal("attribute"),
		scope: Schema.Literals(["span", "resource"]),
		attributeKey: Schema.String,
	}),
])
export type DashboardQueryVariableSource = typeof DashboardQueryVariableSourceSchema.Type

const dashboardVariableBaseFields = {
	name: DashboardVariableName,
	label: Schema.optionalKey(Schema.String),
	includeAll: Schema.optionalKey(Schema.Boolean),
	defaultValue: Schema.optionalKey(Schema.String),
}

export const DashboardVariableSchema = Schema.Union([
	Schema.Struct({
		...dashboardVariableBaseFields,
		type: Schema.Literal("query"),
		source: DashboardQueryVariableSourceSchema,
	}),
	Schema.Struct({
		...dashboardVariableBaseFields,
		type: Schema.Literal("custom"),
		options: Schema.Array(
			Schema.Struct({
				value: Schema.String,
				label: Schema.optionalKey(Schema.String),
			}),
		),
	}),
	Schema.Struct({
		...dashboardVariableBaseFields,
		type: Schema.Literal("textbox"),
	}),
])
export type DashboardVariable = typeof DashboardVariableSchema.Type
