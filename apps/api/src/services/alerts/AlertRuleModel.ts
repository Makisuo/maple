import {
	alertWindowBucketSeconds,
	CompiledAlertQueryPlan,
	QueryEngineAlertReducer,
	QueryEngineNoDataBehavior,
	type QueryEngineSampleCountStrategy,
	QuerySpec,
} from "@maple/query-engine"
import { buildTimeseriesQuerySpec, resolveGroupBy } from "@maple/query-engine/query-builder"
import { prepareRawSql, type AlertBucketSource } from "@maple/query-engine/runtime"
import {
	AlertComparator as AlertComparatorSchema,
	AlertDestinationDocument,
	AlertGroupBy as AlertGroupBySchema,
	AlertNotificationTemplate,
	AlertRuleDocument,
	AlertRuleStoredConfigInvalidError,
	AlertSeverity as AlertSeveritySchema,
	AlertSignalType as AlertSignalTypeSchema,
	AlertValidationError,
	QueryBuilderQueryDraftSchema,
	UNGROUPED_GROUP_KEY,
	UserId,
	type AlertComparator,
	type AlertDestinationId,
	type AlertGroupBy,
	type AlertRuleId,
	type AlertRuleUpsertRequest,
	type AlertSeverity,
	type AlertSignalType,
	type QueryBuilderQueryDraftPayload,
	type OrgId,
} from "@maple/domain/http"
import type { AlertRuleRow } from "@maple/db"
import { Array as Arr, Effect, Result, Schema } from "effect"
import { dateToMs, msToDate } from "@/platform/time"
import type { AlertRuntimeApi } from "./AlertRuntime"
import type { QueryBuilderDataSource } from "@maple/query-model"

const StringArraySchema = Schema.Array(Schema.String)
const DestinationIdArraySchema = Schema.Array(AlertDestinationDocument.fields.id)
const AlertGroupByFromJson = Schema.fromJsonString(AlertGroupBySchema)

const decodeAlertRuleIdSync = Schema.decodeUnknownSync(AlertRuleDocument.fields.id)
const decodeQuerySpecSync = Schema.decodeUnknownSync(QuerySpec)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(AlertDestinationDocument.fields.createdAt)
const decodeAlertSeveritySync = Schema.decodeUnknownSync(AlertSeveritySchema)
const decodeAlertSignalTypeSync = Schema.decodeUnknownSync(AlertSignalTypeSchema)
const decodeAlertComparatorSync = Schema.decodeUnknownSync(AlertComparatorSchema)
const decodeQueryEngineAlertReducerSync = Schema.decodeUnknownSync(QueryEngineAlertReducer)
const decodeNoDataBehaviorSync = Schema.decodeUnknownSync(QueryEngineNoDataBehavior)
const decodeUserIdSync = Schema.decodeUnknownSync(UserId)

export interface NormalizedRule {
	readonly id: AlertRuleId
	readonly name: string
	readonly notificationTemplate: AlertNotificationTemplate | null
	readonly enabled: boolean
	readonly severity: AlertSeverity
	readonly serviceName: string | null
	readonly serviceNames: ReadonlyArray<string>
	readonly excludeServiceNames: ReadonlyArray<string>
	readonly environments: ReadonlyArray<string>
	readonly tags: ReadonlyArray<string>
	readonly groupBy: AlertGroupBy | null
	readonly signalType: AlertSignalType
	readonly comparator: AlertComparator
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly windowMinutes: number
	readonly minimumSampleCount: number
	readonly consecutiveBreachesRequired: number
	readonly consecutiveHealthyRequired: number
	readonly renotifyIntervalMinutes: number
	readonly apdexThresholdMs: number | null
	readonly queryBuilderDraft: QueryBuilderQueryDraftPayload | null
	readonly rawQuerySql: string | null
	readonly rawQueryReducer: QueryEngineAlertReducer | null
	readonly destinationIds: ReadonlyArray<AlertDestinationId>
	readonly compiledPlan: Schema.Schema.Type<typeof CompiledAlertQueryPlan>
	readonly createdAt: number
	readonly updatedAt: number
}

export interface RuleEvaluationState {
	readonly error: string | null
	readonly evaluatedAt: number | null
}

export const normalizedRuleToDocument = (
	rule: NormalizedRule,
	options: {
		readonly notes: string | null
		readonly userId: Schema.Schema.Type<typeof UserId>
		readonly timestamp: number
		readonly txid?: AlertRuleDocument["txid"]
	},
): AlertRuleDocument => {
	const timestamp = decodeIsoDateTimeStringSync(msToDate(options.timestamp).toISOString())
	return new AlertRuleDocument({
		id: rule.id,
		name: rule.name,
		notes: options.notes,
		notificationTemplate: rule.notificationTemplate,
		enabled: rule.enabled,
		severity: rule.severity,
		serviceNames: [...rule.serviceNames],
		excludeServiceNames: [...rule.excludeServiceNames],
		environments: [...rule.environments],
		tags: [...rule.tags],
		groupBy: rule.groupBy,
		signalType: rule.signalType,
		comparator: rule.comparator,
		threshold: rule.threshold,
		thresholdUpper: rule.thresholdUpper,
		windowMinutes: rule.windowMinutes,
		minimumSampleCount: rule.minimumSampleCount,
		consecutiveBreachesRequired: rule.consecutiveBreachesRequired,
		consecutiveHealthyRequired: rule.consecutiveHealthyRequired,
		renotifyIntervalMinutes: rule.renotifyIntervalMinutes,
		apdexThresholdMs: rule.apdexThresholdMs,
		queryBuilderDraft: rule.queryBuilderDraft,
		rawQuerySql: rule.rawQuerySql,
		rawQueryReducer: rule.rawQueryReducer,
		destinationIds: [...rule.destinationIds],
		noDataBehavior: rule.compiledPlan.noDataBehavior,
		lastEvaluationError: null,
		lastEvaluatedAt: null,
		lastScheduledAt: null,
		createdAt: timestamp,
		updatedAt: timestamp,
		createdBy: options.userId,
		updatedBy: options.userId,
		...(!(options.txid === undefined) ? { txid: options.txid } : undefined),
	})
}

export const normalizeOptionalString = (value: string | null | undefined) => {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

export const makeAlertValidationError = (
	message: string,
	details: ReadonlyArray<string> = [],
	cause?: unknown,
) =>
	new AlertValidationError({
		message,
		details,
		...(!(cause === undefined) ? { cause } : undefined),
	})

const normalizeTags = (tags: ReadonlyArray<string> | undefined): ReadonlyArray<string> => {
	if (!tags || tags.length === 0) return []
	return Arr.dedupe(
		Arr.filter(
			Arr.map(tags, (tag) => tag.trim().toLowerCase()),
			(tag) => tag.length > 0,
		),
	)
}

const planGroupingTokens = (
	plan: Schema.Schema.Type<typeof CompiledAlertQueryPlan>,
): ReadonlyArray<string> | null => {
	if (plan.kind !== "spec" || plan.query == null || plan.query.kind !== "timeseries") return null
	const groupBy = plan.query.groupBy
	if (groupBy == null || groupBy.length === 0 || groupBy.includes("none")) return null
	return groupBy
}

export const isGroupedPlan = (plan: Schema.Schema.Type<typeof CompiledAlertQueryPlan>): boolean =>
	plan.kind === "raw_sql" || planGroupingTokens(plan) != null

/**
 * Translate a group key from the query engine's vocabulary into storage's.
 *
 * The engine emits a generic `"all"` for an ungrouped result; storage, the wire
 * and the UI all spell that `UNGROUPED_GROUP_KEY` (`"__total__"`). The two must
 * not be conflated — an `alert_rule_states` row keyed `"all"` is invisible to
 * every reader — and the translation was previously open-coded at each of the
 * three sites that needed it (scheduler evaluation, preview series, preview's
 * empty-range seed), which is exactly the shape of bug that survives review.
 *
 * `evaluateRule` and `previewRule` are the only boundaries; everything
 * downstream of them is already in storage vocabulary.
 */
export const toStorageGroupKey = (
	plan: Schema.Schema.Type<typeof CompiledAlertQueryPlan>,
	engineGroupKey: string,
): string => (isGroupedPlan(plan) ? engineGroupKey : UNGROUPED_GROUP_KEY)

export const planEvaluateSource = (
	plan: Schema.Schema.Type<typeof CompiledAlertQueryPlan>,
	windowMinutes: number,
): Effect.Effect<AlertBucketSource, AlertValidationError> => {
	if (plan.kind === "raw_sql") {
		if (plan.rawSql == null) {
			return Effect.fail(makeAlertValidationError("Compiled alert plan is missing its SQL query"))
		}
		return Effect.succeed({ kind: "raw_sql", sql: plan.rawSql, windowMinutes })
	}
	if (plan.query == null || plan.sampleCountStrategy == null) {
		return Effect.fail(makeAlertValidationError("Compiled alert plan is missing its query spec"))
	}
	return Effect.succeed({ kind: "spec", query: plan.query })
}

export const compileRulePlan = Effect.fn("AlertsService.compileRulePlan")(function* (rule: {
	readonly signalType: AlertSignalType
	readonly serviceName: string | null
	readonly environments: ReadonlyArray<string>
	readonly apdexThresholdMs: number | null
	readonly queryBuilderDraft: QueryBuilderQueryDraftPayload | null
	readonly rawQuerySql: string | null
	readonly rawQueryReducer: QueryEngineAlertReducer | null
	readonly comparator: AlertComparator
	readonly windowMinutes: number
	readonly groupBy: AlertGroupBy | null
}): Effect.fn.Return<Schema.Schema.Type<typeof CompiledAlertQueryPlan>, AlertValidationError> {
	const bucketSeconds = alertWindowBucketSeconds(rule.windowMinutes)
	const envFilter = rule.environments.length > 0 ? { environments: rule.environments } : {}
	const baseTraceFilters = {
		...(!(rule.serviceName == null) ? { serviceName: rule.serviceName } : undefined),
		...envFilter,
	}

	const noDataBehavior: QueryEngineNoDataBehavior =
		rule.signalType === "throughput" && ["lt", "lte"].includes(rule.comparator) ? "zero" : "skip"
	const traceSignalMetrics: Record<string, string> = {
		error_rate: "error_rate",
		p95_latency: "p95_duration",
		p99_latency: "p99_duration",
		throughput: "count",
		apdex: "apdex",
	} satisfies Record<string, string>

	const resolveRuleGroupBy = (
		source: QueryBuilderDataSource,
	): Effect.Effect<
		{
			readonly tokens: ReadonlyArray<string>
			readonly attributeKeys: ReadonlyArray<string>
			readonly resourceAttributeKeys: ReadonlyArray<string>
		} | null,
		AlertValidationError
	> => {
		if (rule.groupBy == null || rule.groupBy.length === 0) return Effect.succeed(null)
		const resolved = resolveGroupBy(source, rule.groupBy)
		if (resolved.warnings.length > 0) {
			return Effect.fail(
				makeAlertValidationError(`Invalid groupBy for ${source} alert`, [...resolved.warnings]),
			)
		}
		if (resolved.tokens.length === 0) {
			return Effect.fail(
				makeAlertValidationError(`groupBy did not resolve to any usable dimension for ${source}`),
			)
		}
		if (source === "metrics" && resolved.attributeKeys.length > 1) {
			return Effect.fail(
				makeAlertValidationError(
					"Metrics alerts support at most one attr.* groupBy dimension",
					resolved.attributeKeys.map(
						(key) => `Unsupported additional metrics groupBy attribute: ${key}`,
					),
				),
			)
		}
		if (source === "metrics" && resolved.resourceAttributeKeys.length > 1) {
			return Effect.fail(
				makeAlertValidationError(
					"Metrics alerts support at most one resource.* groupBy dimension",
					resolved.resourceAttributeKeys.map(
						(key) => `Unsupported additional metrics groupBy resource attribute: ${key}`,
					),
				),
			)
		}
		if (
			source === "metrics" &&
			resolved.attributeKeys.length > 0 &&
			resolved.resourceAttributeKeys.length > 0
		) {
			return Effect.fail(
				makeAlertValidationError(
					"Metrics alerts cannot combine attr.* and resource.* groupBy dimensions",
				),
			)
		}
		return Effect.succeed({
			tokens: resolved.tokens,
			attributeKeys: resolved.attributeKeys,
			resourceAttributeKeys: resolved.resourceAttributeKeys,
		})
	}

	let query: QuerySpec
	let sampleCountStrategy: QueryEngineSampleCountStrategy
	const traceMetric = traceSignalMetrics[rule.signalType]
	if (traceMetric) {
		const groupResolved = yield* resolveRuleGroupBy("traces")
		const filters: Record<string, unknown> = {
			...baseTraceFilters,
			rootSpansOnly: true,
		} satisfies Record<string, unknown>
		if (groupResolved && groupResolved.attributeKeys.length > 0) {
			filters.groupByAttributeKeys = [...groupResolved.attributeKeys]
		}
		query = decodeQuerySpecSync({
			kind: "timeseries",
			source: "traces",
			metric: traceMetric,
			groupBy: groupResolved ? [...groupResolved.tokens] : ["none"],
			bucketSeconds,
			...(rule.signalType === "apdex" ? { apdexThresholdMs: rule.apdexThresholdMs ?? 500 } : undefined),
			filters,
		})
		sampleCountStrategy = "trace_count"
	} else if (rule.signalType === "builder_query") {
		if (rule.queryBuilderDraft == null) {
			return yield* Effect.fail(
				makeAlertValidationError("builder_query alerts require a queryBuilderDraft"),
			)
		}
		const built = buildTimeseriesQuerySpec(rule.queryBuilderDraft)
		if (built.error != null || built.query == null) {
			return yield* Effect.fail(
				makeAlertValidationError(built.error ?? "Failed to build query builder spec", [
					...built.warnings,
				]),
			)
		}
		query = decodeQuerySpecSync({ ...built.query, bucketSeconds })
		sampleCountStrategy =
			rule.queryBuilderDraft.dataSource === "logs"
				? "log_count"
				: rule.queryBuilderDraft.dataSource === "metrics"
					? "metric_data_points"
					: "trace_count"
	} else if (rule.signalType === "raw_query") {
		const sql = rule.rawQuerySql?.trim() ?? ""
		if (sql.length === 0) {
			return yield* Effect.fail(makeAlertValidationError("raw_query alerts require rawQuerySql"))
		}
		if (!sql.includes("$__orgFilter")) {
			return yield* Effect.fail(
				makeAlertValidationError("raw_query SQL must reference $__orgFilter for org scoping"),
			)
		}
		return new CompiledAlertQueryPlan({
			kind: "raw_sql",
			query: null,
			rawSql: sql,
			reducer: rule.rawQueryReducer ?? "identity",
			sampleCountStrategy: null,
			noDataBehavior,
		})
	} else {
		return yield* Effect.fail(makeAlertValidationError(`Unsupported signal type: ${rule.signalType}`))
	}

	return new CompiledAlertQueryPlan({
		kind: "spec",
		query,
		rawSql: null,
		reducer: "identity",
		sampleCountStrategy,
		noDataBehavior,
	})
})

const parseCompiledPlan = (
	row: Pick<
		AlertRuleRow,
		| "id"
		| "signalType"
		| "querySpecJson"
		| "rawQuerySql"
		| "reducer"
		| "sampleCountStrategy"
		| "noDataBehavior"
	>,
): Effect.Effect<Schema.Schema.Type<typeof CompiledAlertQueryPlan>, AlertRuleStoredConfigInvalidError> => {
	const invalid = (message: string, cause: unknown) =>
		new AlertRuleStoredConfigInvalidError({
			message,
			ruleId: row.id,
			component: "compiled_plan",
			cause,
		})
	if (row.signalType === "raw_query") {
		if (row.rawQuerySql == null) {
			return Effect.fail(
				invalid("Stored raw alert is missing its SQL query", new Error("rawQuerySql is null")),
			)
		}
		return Schema.decodeUnknownEffect(CompiledAlertQueryPlan)({
			kind: "raw_sql",
			query: null,
			rawSql: row.rawQuerySql,
			reducer: row.reducer,
			sampleCountStrategy: null,
			noDataBehavior: row.noDataBehavior,
		}).pipe(Effect.mapError((cause) => invalid("Stored compiled alert plan is invalid", cause)))
	}
	return Schema.decodeUnknownEffect(QuerySpec)(row.querySpecJson).pipe(
		Effect.flatMap((query) =>
			Schema.decodeUnknownEffect(CompiledAlertQueryPlan)({
				kind: "spec",
				query,
				rawSql: null,
				reducer: row.reducer,
				sampleCountStrategy: row.sampleCountStrategy,
				noDataBehavior: row.noDataBehavior,
			}),
		),
		Effect.mapError((cause) => invalid("Stored compiled alert plan is invalid", cause)),
	)
}

type IsoDateTimeValue = Schema.Schema.Type<typeof AlertDestinationDocument.fields.createdAt>

const toIso = (value: Date | null | undefined): IsoDateTimeValue | null =>
	value == null ? null : decodeIsoDateTimeStringSync(value.toISOString())

type StoredRuleComponent = AlertRuleStoredConfigInvalidError["component"]

const decodeStoredRuleComponent = <S extends Schema.Top>(
	ruleId: AlertRuleId,
	component: StoredRuleComponent,
	schema: S,
	value: unknown,
): Effect.Effect<S["Type"], AlertRuleStoredConfigInvalidError, S["DecodingServices"]> =>
	Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError(
			(cause) =>
				new AlertRuleStoredConfigInvalidError({
					message: `Stored alert rule ${component} is invalid`,
					ruleId,
					component,
					cause,
				}),
		),
	)

const decodeStoredStringArray = (
	ruleId: AlertRuleId,
	component: "service_names" | "exclude_service_names" | "environments" | "tags",
	value: unknown,
): Effect.Effect<ReadonlyArray<string>, AlertRuleStoredConfigInvalidError> =>
	value == null
		? Effect.succeed([])
		: decodeStoredRuleComponent(ruleId, component, StringArraySchema, value)

const decodeNullableStoredRuleComponent = <S extends Schema.Top>(
	ruleId: AlertRuleId,
	component: StoredRuleComponent,
	schema: S,
	value: unknown,
): Effect.Effect<S["Type"] | null, AlertRuleStoredConfigInvalidError, S["DecodingServices"]> =>
	value == null ? Effect.succeed(null) : decodeStoredRuleComponent(ruleId, component, schema, value)

export const decodeStoredAlertRuleMetadata = (row: AlertRuleRow) =>
	Effect.all({
		serviceNames: decodeStoredStringArray(row.id, "service_names", row.serviceNamesJson),
		excludeServiceNames: decodeStoredStringArray(
			row.id,
			"exclude_service_names",
			row.excludeServiceNamesJson,
		),
		environments: decodeStoredStringArray(row.id, "environments", row.environmentsJson),
		tags: decodeStoredStringArray(row.id, "tags", row.tagsJson),
		groupBy: decodeNullableStoredRuleComponent(row.id, "group_by", AlertGroupByFromJson, row.groupBy),
		notificationTemplate: decodeNullableStoredRuleComponent(
			row.id,
			"notification_template",
			AlertNotificationTemplate,
			row.notificationTemplateJson,
		),
		queryBuilderDraft: decodeNullableStoredRuleComponent(
			row.id,
			"query_builder_draft",
			QueryBuilderQueryDraftSchema,
			row.queryBuilderDraftJson,
		),
	})

export const decodeStoredAlertRuleDestinationIds = (
	ruleId: AlertRuleId,
	value: unknown,
): Effect.Effect<ReadonlyArray<AlertDestinationId>, AlertRuleStoredConfigInvalidError> =>
	Schema.decodeUnknownEffect(DestinationIdArraySchema)(value).pipe(
		Effect.mapError(
			(cause) =>
				new AlertRuleStoredConfigInvalidError({
					message: "Stored rule destinations are invalid",
					ruleId,
					component: "destination_ids",
					cause,
				}),
		),
	)

export const rowToRuleDocument = (
	row: AlertRuleRow,
	evaluationState?: RuleEvaluationState,
): Effect.Effect<AlertRuleDocument, AlertRuleStoredConfigInvalidError> =>
	Effect.gen(function* () {
		const stored = yield* decodeStoredAlertRuleMetadata(row)
		const destinationIds = yield* decodeStoredAlertRuleDestinationIds(row.id, row.destinationIdsJson)
		return yield* Effect.try({
			try: () => {
				return new AlertRuleDocument({
					id: decodeAlertRuleIdSync(row.id),
					name: row.name,
					notes: row.notes ?? null,
					notificationTemplate: stored.notificationTemplate,
					enabled: row.enabled,
					severity: decodeAlertSeveritySync(row.severity),
					serviceNames: [...stored.serviceNames],
					excludeServiceNames: [...stored.excludeServiceNames],
					environments: [...stored.environments],
					tags: [...stored.tags],
					groupBy: stored.groupBy,
					signalType: decodeAlertSignalTypeSync(row.signalType),
					comparator: decodeAlertComparatorSync(row.comparator),
					threshold: row.threshold,
					thresholdUpper: row.thresholdUpper,
					windowMinutes: row.windowMinutes,
					minimumSampleCount: row.minimumSampleCount,
					consecutiveBreachesRequired: row.consecutiveBreachesRequired,
					consecutiveHealthyRequired: row.consecutiveHealthyRequired,
					renotifyIntervalMinutes: row.renotifyIntervalMinutes,
					apdexThresholdMs: row.apdexThresholdMs,
					queryBuilderDraft: stored.queryBuilderDraft,
					rawQuerySql: row.signalType === "raw_query" ? (row.rawQuerySql ?? null) : null,
					rawQueryReducer:
						row.signalType === "raw_query"
							? decodeQueryEngineAlertReducerSync(row.reducer)
							: null,
					destinationIds,
					noDataBehavior: decodeNoDataBehaviorSync(row.noDataBehavior),
					lastEvaluationError: evaluationState?.error ?? null,
					lastEvaluatedAt:
						evaluationState?.evaluatedAt != null
							? decodeIsoDateTimeStringSync(msToDate(evaluationState.evaluatedAt).toISOString())
							: null,
					lastScheduledAt: toIso(row.lastScheduledAt),
					createdAt: decodeIsoDateTimeStringSync(row.createdAt.toISOString()),
					updatedAt: decodeIsoDateTimeStringSync(row.updatedAt.toISOString()),
					createdBy: decodeUserIdSync(row.createdBy),
					updatedBy: decodeUserIdSync(row.updatedBy),
				})
			},
			catch: (cause) =>
				new AlertRuleStoredConfigInvalidError({
					message: "Stored alert rule document is invalid",
					ruleId: row.id,
					component: "document",
					cause,
				}),
		})
	})

export const makeAlertRuleNormalizer = (runtime: AlertRuntimeApi) => {
	const normalizeRuleRow = Effect.fn("AlertsService.normalizeRuleRow")(function* (
		row: AlertRuleRow,
	): Effect.fn.Return<NormalizedRule, AlertRuleStoredConfigInvalidError> {
		const stored = yield* decodeStoredAlertRuleMetadata(row)
		const decoded = yield* Effect.try({
			try: () => {
				return {
					id: decodeAlertRuleIdSync(row.id),
					serviceName: stored.serviceNames.length === 1 ? (stored.serviceNames[0] ?? null) : null,
					signalType: decodeAlertSignalTypeSync(row.signalType),
					severity: decodeAlertSeveritySync(row.severity),
					comparator: decodeAlertComparatorSync(row.comparator),
					groupBy: stored.groupBy,
					rawQueryReducer:
						row.signalType === "raw_query"
							? decodeQueryEngineAlertReducerSync(row.reducer)
							: null,
				}
			},
			catch: (cause) =>
				new AlertRuleStoredConfigInvalidError({
					message: "Stored alert rule fields are invalid",
					ruleId: row.id,
					component: "document",
					cause,
				}),
		})
		return {
			id: decoded.id,
			name: row.name,
			notificationTemplate: stored.notificationTemplate,
			enabled: row.enabled,
			severity: decoded.severity,
			serviceName: decoded.serviceName,
			serviceNames: stored.serviceNames,
			excludeServiceNames: stored.excludeServiceNames,
			environments: stored.environments,
			tags: stored.tags,
			groupBy: decoded.groupBy,
			signalType: decoded.signalType,
			comparator: decoded.comparator,
			threshold: row.threshold,
			thresholdUpper: row.thresholdUpper,
			windowMinutes: row.windowMinutes,
			minimumSampleCount: row.minimumSampleCount,
			consecutiveBreachesRequired: row.consecutiveBreachesRequired,
			consecutiveHealthyRequired: row.consecutiveHealthyRequired,
			renotifyIntervalMinutes: row.renotifyIntervalMinutes,
			apdexThresholdMs: row.apdexThresholdMs,
			queryBuilderDraft: stored.queryBuilderDraft,
			rawQuerySql: row.rawQuerySql ?? null,
			rawQueryReducer: decoded.rawQueryReducer,
			destinationIds: yield* decodeStoredAlertRuleDestinationIds(row.id, row.destinationIdsJson),
			compiledPlan: yield* parseCompiledPlan(row),
			createdAt: dateToMs(row.createdAt),
			updatedAt: dateToMs(row.updatedAt),
		}
	})

	const normalizeRule = Effect.fn("AlertsService.normalizeRule")(function* (
		orgId: OrgId,
		request: AlertRuleUpsertRequest,
		options?: { readonly forPreview?: boolean },
	): Effect.fn.Return<NormalizedRule, AlertValidationError> {
		const name = request.name.trim()
		const serviceNames =
			request.serviceNames && request.serviceNames.length > 0
				? request.serviceNames
						.map((service) => service.trim())
						.filter((service) => service.length > 0)
				: []
		const serviceName = serviceNames.length === 1 ? (serviceNames[0] ?? null) : null
		const excludeServiceNames = request.excludeServiceNames
			? request.excludeServiceNames
					.map((service) => service.trim())
					.filter((service) => service.length > 0)
			: []
		const queryOwnsScope = request.signalType === "builder_query" || request.signalType === "raw_query"
		const environments =
			request.environments && !queryOwnsScope
				? Arr.dedupe(
						Arr.filterMap(request.environments, (environment) => {
							const trimmed = environment.trim()
							return trimmed.length > 0 ? Result.succeed(trimmed) : Result.failVoid
						}),
					)
				: []
		const tags = normalizeTags(request.tags)
		const groupBy = request.groupBy ?? null
		const destinationIds = Arr.dedupe(request.destinationIds)
		const details: string[] = []
		if (name.length === 0 && !options?.forPreview) details.push("name is required")
		if (destinationIds.length === 0 && !options?.forPreview) {
			details.push("at least one destination must be selected")
		}
		if (request.threshold == null || !Number.isFinite(request.threshold)) {
			details.push("threshold must be a finite number")
		}
		const isRange = request.comparator === "between" || request.comparator === "not_between"
		if (isRange) {
			if (request.thresholdUpper == null || !Number.isFinite(request.thresholdUpper)) {
				details.push("thresholdUpper is required for between / not_between comparators")
			} else if (request.threshold != null && request.thresholdUpper < request.threshold) {
				details.push("thresholdUpper must be greater than or equal to threshold")
			}
		} else if (request.thresholdUpper != null) {
			details.push("thresholdUpper is only supported for between / not_between comparators")
		}
		if (request.signalType === "builder_query" && !request.queryBuilderDraft) {
			details.push("queryBuilderDraft is required for builder_query alerts")
		}
		if (request.signalType === "raw_query") {
			const sql = request.rawQuerySql?.trim() ?? ""
			if (sql.length === 0) details.push("rawQuerySql is required for raw_query alerts")
			if (serviceNames.length > 0) details.push("serviceNames is not supported for raw_query alerts")
			if (groupBy != null) {
				details.push("groupBy is not supported for raw_query alerts; return a group column instead")
			}
		} else {
			if (normalizeOptionalString(request.rawQuerySql) != null) {
				details.push("rawQuerySql is only supported for raw_query alerts")
			}
			if (request.rawQueryReducer != null) {
				details.push("rawQueryReducer is only supported for raw_query alerts")
			}
		}
		if (groupBy != null && serviceNames.length > 0) {
			details.push("groupBy is only supported when no service is specified")
		}
		if (excludeServiceNames.length > 0 && serviceNames.length > 0) {
			details.push("excludeServiceNames is only supported when no specific services are selected")
		}
		if (
			excludeServiceNames.length > 0 &&
			!(groupBy != null && groupBy.length === 1 && groupBy[0] === "service.name")
		) {
			details.push('excludeServiceNames requires groupBy=["service.name"]')
		}
		if (details.length > 0) {
			return yield* Effect.fail(makeAlertValidationError("Invalid alert rule", details))
		}
		if (request.signalType === "raw_query") {
			yield* prepareRawSql({
				sql: request.rawQuerySql ?? "",
				orgId,
				startTime: "2000-01-01 00:00:00",
				endTime: "2000-01-01 00:05:00",
				granularitySeconds: 60,
				workload: "alert",
			}).pipe(
				Effect.mapError((error) =>
					makeAlertValidationError("Invalid raw SQL alert query", [error.message], error),
				),
			)
		}

		const nowMs = yield* runtime.now
		const normalizedBase = {
			id: decodeAlertRuleIdSync(runtime.makeUuid()),
			name,
			notificationTemplate: request.notificationTemplate ?? null,
			enabled: request.enabled ?? true,
			severity: request.severity,
			serviceName,
			serviceNames,
			excludeServiceNames,
			environments,
			tags,
			groupBy,
			signalType: request.signalType,
			comparator: request.comparator,
			threshold: request.threshold,
			thresholdUpper: request.thresholdUpper ?? null,
			windowMinutes: request.windowMinutes,
			minimumSampleCount: request.minimumSampleCount ?? 0,
			consecutiveBreachesRequired: request.consecutiveBreachesRequired ?? 2,
			consecutiveHealthyRequired: request.consecutiveHealthyRequired ?? 2,
			renotifyIntervalMinutes: request.renotifyIntervalMinutes ?? 30,
			apdexThresholdMs: request.apdexThresholdMs ?? (request.signalType === "apdex" ? 500 : null),
			queryBuilderDraft: request.queryBuilderDraft ?? null,
			rawQuerySql:
				request.signalType === "raw_query" ? normalizeOptionalString(request.rawQuerySql) : null,
			rawQueryReducer: request.signalType === "raw_query" ? (request.rawQueryReducer ?? null) : null,
			destinationIds,
			createdAt: nowMs,
			updatedAt: nowMs,
		}
		return {
			...normalizedBase,
			compiledPlan: yield* compileRulePlan(normalizedBase),
		}
	})

	return { normalizeRule, normalizeRuleRow }
}
