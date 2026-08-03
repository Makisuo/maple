// Audits an org's Maple setup and reports what is broken or missing. Pure and dependency-free so it
// runs identically in the API (apps/api/src/services/SetupAuditService.ts), in the MCP tool, and in
// unit tests — same shape as `./recommendations`.
//
// Architecture: fetch-once → pure evaluation. One IO pass populates `SetupAuditInputs`; every check is
// a pure function over it. Checks share inputs heavily (alert rules + destinations feed four checks),
// and warehouse degradation becomes ONE decision instead of N: when `inputs.warehouse` is undefined,
// every `needsWarehouse` check emits `skip` and the report still returns the config findings.
//
// Severity is fixed per check, never computed inside `evaluate`. Conditional severity ("critical if
// referenced, warn otherwise") is a smell — split it into two checks or pick the honest one.
//
// Checks deliberately NOT included, so nobody re-adds them: escalation policy disabled (defaults to
// false — would fire on nearly every org), AI triage disabled (opt-in by design), no scrape targets /
// no VCS repo / no integrations (absence of an optional feature is not a finding), destination never
// tested (delivery works fine without ever pressing Test), onboarding checklist incomplete (owned by
// the onboarding surface). A check that fires on every healthy org is noise, not an audit.

export type AuditSeverity = "critical" | "warn" | "info"
export type AuditStatus = "pass" | "fail" | "skip"

export type AuditCategory =
	| "alerting"
	| "notifications"
	| "ingestion"
	| "attributes"
	| "traces"
	| "integrations"
	| "data_platform"

/** A concrete thing a finding points at, so the UI can chip it and deep-link to its editor. */
export interface AuditAffectedEntity {
	readonly kind:
		| "service"
		| "alert_rule"
		| "alert_destination"
		| "attribute_mapping"
		| "scrape_target"
		| "repository"
		| "integration"
		| "attribute_key"
	/** Internal id when the entity has one; encoded to a public id at the wire boundary. */
	readonly id?: string
	readonly name: string
	/** Per-entity evidence, e.g. `last error: timeout after 5s`. */
	readonly note?: string
}

export interface AuditEvaluation {
	readonly status: "pass" | "fail"
	/** Human sentence describing the finding. Omitted on pass. */
	readonly detail?: string
	readonly affected?: ReadonlyArray<AuditAffectedEntity>
	/** Total affected before capping; defaults to `affected.length`. */
	readonly affectedCount?: number
}

export interface AuditCheck {
	/** Stable, human-readable id — `CFG-ALERT-03`. Doubles as the wire identifier. */
	readonly id: string
	readonly category: AuditCategory
	readonly title: string
	readonly severity: AuditSeverity
	/** When true and `inputs.warehouse` is undefined, the runner emits `skip` without evaluating. */
	readonly needsWarehouse?: boolean
	readonly fixHint: string
	readonly evaluate: (inputs: SetupAuditInputs) => AuditEvaluation
}

export interface AuditCheckResult {
	readonly id: string
	readonly category: AuditCategory
	readonly title: string
	readonly severity: AuditSeverity
	readonly status: AuditStatus
	readonly detail: string | null
	readonly affected: ReadonlyArray<AuditAffectedEntity>
	readonly affectedCount: number
	readonly fixHint: string
}

export interface SetupAuditSummary {
	readonly critical: number
	readonly warn: number
	readonly info: number
	readonly pass: number
	readonly skip: number
}

export interface SetupAuditReport {
	readonly generatedAt: number
	/** `no_data` short-circuits the whole report — see `runSetupAudit`. */
	readonly dataStatus: "ok" | "no_data"
	readonly warehouseAvailable: boolean
	readonly summary: SetupAuditSummary
	readonly checks: ReadonlyArray<AuditCheckResult>
	readonly openRecommendationCount: number
}

// ---------------------------------------------------------------------------
// Inputs
//
// Flat readonly structs of exactly the fields the checks read — never Drizzle row types or ClickHouse
// row shapes. That boundary is what keeps this module driver-free and its tests infra-free.
// ---------------------------------------------------------------------------

export interface AuditAlertRule {
	readonly id: string
	readonly name: string
	readonly enabled: boolean
	readonly destinationIds: ReadonlyArray<string>
	readonly windowMinutes: number
	readonly lastScheduledAt: number | null
	readonly createdAt: number
}

export interface AuditAlertRuleState {
	readonly ruleId: string
	readonly lastEvaluatedAt: number | null
	readonly lastError: string | null
}

export interface AuditAlertDestination {
	readonly id: string
	readonly name: string
	readonly enabled: boolean
	readonly lastTestError: string | null
}

export interface AuditAttributeMapping {
	readonly id: string
	readonly name: string
	readonly enabled: boolean
	readonly sourceContext: string
	readonly sourceKey: string
	readonly targetKey: string
}

export interface ConfigAuditInputs {
	/** Null when the org has never received telemetry — gates the whole report. */
	readonly firstDataReceivedAt: number | null
	readonly alertRules: ReadonlyArray<AuditAlertRule>
	readonly alertRuleStates: ReadonlyArray<AuditAlertRuleState>
	readonly alertDestinations: ReadonlyArray<AuditAlertDestination>
	/** Missing row means Maple defaults: enabled, but with no destinations. */
	readonly errorNotificationPolicy: {
		readonly enabled: boolean
		readonly destinationIds: ReadonlyArray<string>
	} | null
	/** Missing row means enabled — the detector is zero-config. */
	readonly anomalyDetector: { readonly enabled: boolean } | null
	readonly dashboardCount: number
	/** Missing row means no sampling (ratio 1). */
	readonly samplingPolicy: {
		readonly traceSampleRatio: number
		readonly alwaysKeepErrorSpans: boolean
	} | null
	readonly attributeMappings: ReadonlyArray<AuditAttributeMapping>
	/** Null when the org is on managed Tinybird rather than BYO ClickHouse. */
	readonly clickhouse: {
		readonly syncStatus: string
		readonly lastSyncError: string | null
		readonly schemaVersion: string | null
		readonly expectedSchemaVersion: string
	} | null
	readonly integrations: ReadonlyArray<{ readonly provider: string; readonly revokedAt: number | null }>
	readonly cloudflareAnalytics: ReadonlyArray<{
		readonly dataset: string
		readonly zoneName: string | null
		readonly lastSuccessAt: number | null
		readonly lastErrorAt: number | null
		readonly lastError: string | null
	}>
	readonly vcsRepositories: ReadonlyArray<{
		readonly id: string
		readonly fullName: string
		readonly syncStatus: string
		readonly lastSyncError: string | null
	}>
	readonly scrapeTargets: ReadonlyArray<{
		readonly id: string
		readonly name: string
		readonly enabled: boolean
		readonly lastScrapeError: string | null
	}>
	readonly openRecommendationCount: number
}

export interface AuditAttributeKey {
	/** `span` | `resource` | `log` | `metric`. */
	readonly scope: string
	readonly key: string
	readonly usageCount: number
}

export interface AuditServiceUsage {
	readonly serviceName: string
	readonly logCount: number
	readonly traceCount: number
	readonly metricCount: number
}

export interface AuditSpanShape {
	readonly serviceName: string
	readonly spanCount: number
	readonly errorCount: number
	readonly serverCount: number
	readonly consumerCount: number
	readonly noEnvCount: number
	readonly spanNameCount: number
	readonly badStatusCodes: ReadonlyArray<string>
	readonly badSpanKinds: ReadonlyArray<string>
}

export interface AuditLogCorrelation {
	readonly serviceName: string
	readonly logCount: number
	readonly uncorrelatedCount: number
	readonly errorLogCount: number
	readonly uncorrelatedErrorCount: number
}

/**
 * Telemetry-derived inputs. `undefined` on `SetupAuditInputs` means the warehouse was unreachable and
 * every `needsWarehouse` check skips.
 *
 * THE SEAM: new warehouse checks extend this interface and the fetcher in SetupAuditService; the check
 * bodies below stay pure.
 */
export interface WarehouseAuditInputs {
	readonly lookbackHours: number
	/** Every attribute key observed over the lookback window, tagged with its scope. */
	readonly attributeKeys: ReadonlyArray<AuditAttributeKey>
	/** Per-service signal volumes — the answer to "what is this service actually sending". */
	readonly serviceUsage: ReadonlyArray<AuditServiceUsage>
	readonly spanShape: ReadonlyArray<AuditSpanShape>
	readonly logSeverity: ReadonlyArray<{
		readonly serviceName: string
		readonly severityText: string
		readonly logCount: number
	}>
	readonly metricLabels: ReadonlyArray<{
		readonly attributeKey: string
		readonly valueCardinality: number
	}>
	readonly peerValues: ReadonlyArray<{
		readonly attributeKey: string
		readonly attributeValue: string
		readonly usageCount: number
	}>
	readonly dbEdges: ReadonlyArray<{
		readonly serviceName: string
		readonly dbSystem: string
		readonly callCount: number
		readonly unknownNamespaceCallCount: number
	}>
	/** Log correlation is sampled over a shorter window than the rest — see `logCorrelationHours`. */
	readonly logCorrelation: ReadonlyArray<AuditLogCorrelation>
	readonly logCorrelationHours: number
	/**
	 * Trace-completeness samples. These come from a short, lagged window and (on high-volume orgs) a
	 * fraction of traces, so they are rates to reason about — never exact counts.
	 */
	readonly traceCompleteness: TraceCompletenessInputs | undefined
}

export interface TraceCompletenessInputs {
	/** Length of the sampled window, in minutes. */
	readonly windowMinutes: number
	/** 1 = every trace examined; N = one in N. */
	readonly traceSampleModulus: number
	readonly orphans: ReadonlyArray<{
		readonly serviceName: string
		readonly childCount: number
		readonly orphanCount: number
		/** Orphans inside sampling-marked traces, where a missing parent is expected. */
		readonly sampledOrphanCount: number
		readonly sampleTraceIds: ReadonlyArray<string>
	}>
	readonly rootless: ReadonlyArray<{
		readonly entryService: string
		readonly traceCount: number
		readonly rootlessCount: number
		readonly sampledRootlessCount: number
	}>
}

export interface SetupAuditInputs {
	readonly now: number
	readonly config: ConfigAuditInputs
	readonly warehouse: WarehouseAuditInputs | undefined
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** How many affected entities a single finding carries; the rest are counted, not listed. */
const AFFECTED_LIMIT = 20

/** An enabled rule whose scheduler claim is older than this has stopped being picked up. */
const RULE_SCHEDULE_STALE_MS = 30 * 60_000
/** Grace period before a never-scheduled rule counts as broken rather than brand new. */
const RULE_NEVER_SCHEDULED_GRACE_MS = 2 * 60 * 60_000
/** Max characters of a provider error quoted into a finding, ellipsis included. */
const ERROR_EXCERPT_LIMIT = 160

const PASS: AuditEvaluation = { status: "pass" }

const fail = (detail: string, affected: ReadonlyArray<AuditAffectedEntity> = []): AuditEvaluation => ({
	status: "fail",
	detail,
	affected: affected.slice(0, AFFECTED_LIMIT),
	affectedCount: affected.length,
})

const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
	`${count} ${count === 1 ? singular : pluralForm}`

/**
 * Subject-verb agreement for finding sentences, which always lead with a count. Without it every
 * multi-item finding reads as "3 services emits …".
 */
const conj = (count: number, singular: string, pluralForm: string) => (count === 1 ? singular : pluralForm)

const formatAgo = (ms: number): string => {
	const minutes = Math.floor(ms / 60_000)
	if (minutes < 60) return `${plural(Math.max(minutes, 1), "minute")}`
	const hours = Math.floor(minutes / 60)
	if (hours < 48) return `${plural(hours, "hour")}`
	return `${plural(Math.floor(hours / 24), "day")}`
}

/** Truncates a provider error so one pathological message can't dominate the report. */
const briefError = (message: string): string =>
	message.length > ERROR_EXCERPT_LIMIT ? `${message.slice(0, ERROR_EXCERPT_LIMIT - 1)}…` : message

const percent = (numerator: number, denominator: number): string =>
	denominator === 0 ? "0%" : `${Math.round((numerator / denominator) * 100)}%`

const keysForScope = (warehouse: WarehouseAuditInputs, scope: string): Set<string> =>
	new Set(warehouse.attributeKeys.filter((row) => row.scope === scope).map((row) => row.key))

const spanKeySet = (warehouse: WarehouseAuditInputs): Set<string> => keysForScope(warehouse, "span")

/** Reports whichever of `keys` is missing from the org's resource attributes, as one finding. */
const resourceKeyCheck = (
	id: string,
	title: string,
	keys: ReadonlyArray<string>,
	detail: string,
	fixHint: string,
): AuditCheck => ({
	id,
	category: "attributes",
	title,
	severity: "warn",
	needsWarehouse: true,
	fixHint,
	evaluate: ({ warehouse }) => {
		if (!warehouse) return PASS
		const present = keysForScope(warehouse, "resource")
		return keys.some((key) => present.has(key)) ? PASS : fail(detail)
	},
})

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const alertingChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "CFG-ALERT-01",
		category: "alerting",
		title: "At least one notification destination is enabled",
		severity: "critical",
		fixHint: "Add a destination in Alerts → Destinations (Slack, PagerDuty, webhook, email, …).",
		evaluate: ({ config }) =>
			config.alertDestinations.some((destination) => destination.enabled)
				? PASS
				: fail(
						"No enabled notification destinations. Alert rules, error notifications and escalations all deliver through destinations, so every notification is silently dropped.",
					),
	},
	{
		id: "CFG-ALERT-02",
		category: "alerting",
		title: "At least one alert rule is defined",
		severity: "warn",
		fixHint:
			"Create a rule in Alerts → Rules, starting with error rate or p95 latency on your busiest service.",
		evaluate: ({ config }) => {
			if (config.alertRules.some((rule) => rule.enabled)) return PASS
			// A missing settings row means the detector is on — see the schema comment on
			// anomaly_detector_settings.
			const anomalyOn = config.anomalyDetector === null || config.anomalyDetector.enabled
			return fail(
				anomalyOn
					? "No enabled alert rules. Anomaly detection is on and will catch sudden shifts, but it can't enforce the thresholds your SLOs actually care about."
					: "No enabled alert rules, and anomaly detection is also disabled. Nothing will notify you when a service degrades.",
			)
		},
	},
	{
		id: "CFG-ALERT-03",
		category: "alerting",
		title: "Every enabled alert rule routes somewhere",
		severity: "critical",
		fixHint: "Open each rule and pick at least one enabled destination under Notifications.",
		evaluate: ({ config }) => {
			const deliverable = new Set(config.alertDestinations.filter((d) => d.enabled).map((d) => d.id))
			const broken = config.alertRules
				.filter((rule) => rule.enabled)
				.flatMap((rule) => {
					if (rule.destinationIds.length === 0) {
						return [
							{
								kind: "alert_rule" as const,
								id: rule.id,
								name: rule.name,
								note: "no destinations selected",
							},
						]
					}
					if (rule.destinationIds.some((id) => deliverable.has(id))) return []
					return [
						{
							kind: "alert_rule" as const,
							id: rule.id,
							name: rule.name,
							note: "every selected destination is disabled or deleted",
						},
					]
				})
			return broken.length === 0
				? PASS
				: fail(
						`${plural(broken.length, "enabled alert rule")} will evaluate and breach but deliver to nobody.`,
						broken,
					)
		},
	},
	{
		id: "CFG-ALERT-04",
		category: "alerting",
		title: "Notification destinations delivered successfully on their last test",
		severity: "warn",
		fixHint:
			"Re-test the destination in Alerts → Destinations; a stale webhook URL or revoked token is the usual cause.",
		evaluate: ({ config }) => {
			const failing = config.alertDestinations
				.filter((destination) => destination.enabled && destination.lastTestError !== null)
				.map((destination) => ({
					kind: "alert_destination" as const,
					id: destination.id,
					name: destination.name,
					note: briefError(destination.lastTestError ?? ""),
				}))
			return failing.length === 0
				? PASS
				: fail(`${plural(failing.length, "destination")} failed the last delivery test.`, failing)
		},
	},
	{
		id: "CFG-ALERT-05",
		category: "alerting",
		title: "Enabled alert rules are actually being evaluated",
		severity: "warn",
		fixHint:
			"Check the rule's query and filters; a rule that never evaluates cannot fire regardless of its threshold.",
		evaluate: ({ config, now }) => {
			const statesByRule = new Map<string, AuditAlertRuleState[]>()
			for (const state of config.alertRuleStates) {
				const bucket = statesByRule.get(state.ruleId)
				if (bucket) bucket.push(state)
				else statesByRule.set(state.ruleId, [state])
			}

			const stalled = config.alertRules
				.filter((rule) => rule.enabled)
				.flatMap((rule) => {
					const states = statesByRule.get(rule.id) ?? []
					const errored = states.find((state) => state.lastError !== null)
					if (errored?.lastError != null) {
						return [
							{
								kind: "alert_rule" as const,
								id: rule.id,
								name: rule.name,
								note: `evaluation error: ${briefError(errored.lastError)}`,
							},
						]
					}
					if (rule.lastScheduledAt === null) {
						return now - rule.createdAt > RULE_NEVER_SCHEDULED_GRACE_MS
							? [
									{
										kind: "alert_rule" as const,
										id: rule.id,
										name: rule.name,
										note: "never evaluated",
									},
								]
							: []
					}
					// The scheduler re-claims each rule every tick under a 30s lock, so a claim this old
					// means the rule has fallen out of the rotation entirely.
					const age = now - rule.lastScheduledAt
					return age > RULE_SCHEDULE_STALE_MS
						? [
								{
									kind: "alert_rule" as const,
									id: rule.id,
									name: rule.name,
									note: `last evaluated ${formatAgo(age)} ago`,
								},
							]
						: []
				})

			return stalled.length === 0
				? PASS
				: fail(
						`${plural(stalled.length, "enabled alert rule")} ${conj(stalled.length, "is", "are")} not evaluating cleanly, so ${conj(stalled.length, "it", "they")} cannot fire.`,
						stalled,
					)
		},
	},
]

const notificationChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "CFG-NOTIF-01",
		category: "notifications",
		title: "New errors notify someone",
		severity: "warn",
		fixHint: "Settings → Notifications: enable error notifications and select at least one destination.",
		evaluate: ({ config }) => {
			// A missing row means Maple's defaults apply: enabled, but with an empty destination list —
			// which still routes nowhere, so the second arm below catches it.
			const policy = config.errorNotificationPolicy ?? { enabled: true, destinationIds: [] }
			if (!policy.enabled) {
				return fail(
					"Error notifications are turned off — new and regressed errors will surface in the dashboard only.",
				)
			}
			const deliverable = new Set(config.alertDestinations.filter((d) => d.enabled).map((d) => d.id))
			if (policy.destinationIds.some((id) => deliverable.has(id))) return PASS
			return fail(
				policy.destinationIds.length === 0
					? "Error notifications are enabled but no destination is selected, so nothing is delivered."
					: "Every destination selected for error notifications is disabled or deleted.",
			)
		},
	},
	{
		id: "CFG-ANOM-01",
		category: "notifications",
		title: "Anomaly detection is enabled",
		severity: "info",
		fixHint:
			"Settings → Automation: re-enable anomaly detection to get baseline-relative alerts without authoring rules.",
		evaluate: ({ config }) =>
			// Only an explicit opt-out counts; a missing row means the zero-config default (enabled).
			config.anomalyDetector !== null && !config.anomalyDetector.enabled
				? fail(
						"Anomaly detection is explicitly disabled — Maple will not flag sudden shifts in latency, throughput or error volume.",
					)
				: PASS,
	},
	{
		id: "CFG-DASH-01",
		category: "notifications",
		title: "At least one dashboard exists",
		severity: "info",
		fixHint:
			"Create a dashboard, or ask the Maple MCP to build one from your busiest service's operations.",
		evaluate: ({ config }) =>
			config.dashboardCount > 0
				? PASS
				: fail(
						"No dashboards yet. Service views cover a lot, but a dashboard is how you put your own metrics side by side.",
					),
	},
]

const ingestionChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "CFG-SAMP-01",
		category: "ingestion",
		title: "Trace sampling is understood",
		severity: "info",
		fixHint:
			"Span counts and throughput are scaled estimates while sampling is on. Nothing to fix if this is intentional.",
		evaluate: ({ config }) => {
			const policy = config.samplingPolicy
			if (policy === null || policy.traceSampleRatio >= 1) return PASS
			const percent = Math.round(policy.traceSampleRatio * 1000) / 10
			const kept = policy.alwaysKeepErrorSpans
				? "Error spans are always kept."
				: "Error spans are sampled at the same rate — errors can be missed entirely."
			return fail(
				`The ingest gateway keeps ${percent}% of traces. Span counts and throughput are extrapolated, not exact. ${kept}`,
			)
		},
	},
	{
		id: "CFG-ATTR-01",
		category: "attributes",
		title: "No open instrumentation recommendations",
		severity: "warn",
		fixHint:
			"Settings → Ingestion → Recommended mappings: apply the renames or dismiss the ones you don't plan to act on.",
		evaluate: ({ config }) =>
			config.openRecommendationCount === 0
				? PASS
				: fail(
						`${plural(config.openRecommendationCount, "open instrumentation recommendation")} — deprecated or non-conforming attribute keys detected in your live spans.`,
					),
	},
	{
		id: "CFG-MAP-01",
		category: "attributes",
		title: "Every attribute mapping still matches live telemetry",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Delete the mapping, or fix its source key — it is dead configuration that will mislead the next reader.",
		evaluate: ({ config, warehouse }) => {
			if (!warehouse) return PASS
			const present = spanKeySet(warehouse)
			const dead = config.attributeMappings
				.filter(
					(mapping) =>
						mapping.enabled &&
						mapping.sourceContext === "span" &&
						!present.has(mapping.sourceKey),
				)
				.map((mapping) => ({
					kind: "attribute_mapping" as const,
					id: mapping.id,
					name: mapping.name,
					note: `${mapping.sourceKey} no longer arrives`,
				}))
			return dead.length === 0
				? PASS
				: fail(
						`${plural(dead.length, "enabled attribute mapping")} references a key that has not arrived in the last ${warehouse.lookbackHours}h.`,
						dead,
					)
		},
	},
	{
		id: "CFG-MAP-02",
		category: "attributes",
		title: "No attribute mapping is a silent no-op",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Stop emitting the source key at the SDK — the mapping cannot merge two keys, so it will never run.",
		evaluate: ({ config, warehouse }) => {
			if (!warehouse) return PASS
			const present = spanKeySet(warehouse)
			// The ingest gateway never overwrites an existing target key (apps/ingest/src/telemetry.rs
			// `apply_attribute_mappings`), so a mapping whose target already arrives can never fire.
			const noop = config.attributeMappings
				.filter((mapping) => mapping.enabled && present.has(mapping.targetKey))
				.map((mapping) => ({
					kind: "attribute_mapping" as const,
					id: mapping.id,
					name: mapping.name,
					note: `${mapping.targetKey} already arrives natively`,
				}))
			return noop.length === 0
				? PASS
				: fail(
						`${plural(noop.length, "enabled attribute mapping")} can never fire — the target key is already present on incoming spans, and mappings never overwrite an existing value.`,
						noop,
					)
		},
	},
]

const platformChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "CFG-BYOC-01",
		category: "data_platform",
		title: "Bring-your-own ClickHouse is reachable",
		severity: "critical",
		fixHint:
			"Settings → Data Platform: re-test the connection. Credentials, network policy and cluster health are the usual causes.",
		evaluate: ({ config }) => {
			const clickhouse = config.clickhouse
			if (clickhouse === null || clickhouse.syncStatus !== "error") return PASS
			return fail(
				`Your ClickHouse connection is in an error state${clickhouse.lastSyncError ? `: ${briefError(clickhouse.lastSyncError)}` : "."} Queries and ingest both depend on it.`,
			)
		},
	},
	{
		id: "CFG-BYOC-02",
		category: "data_platform",
		title: "Bring-your-own ClickHouse schema is up to date",
		severity: "warn",
		fixHint:
			"Settings → Data Platform → Apply schema. Newer Maple features query tables the older schema doesn't have.",
		evaluate: ({ config }) => {
			const clickhouse = config.clickhouse
			if (clickhouse === null) return PASS
			if (clickhouse.schemaVersion === clickhouse.expectedSchemaVersion) return PASS
			// Rows written by older code stored a project revision hash here rather than a migration
			// version. Abbreviate it — a 64-character hash in a finding sentence tells nobody anything.
			const applied = clickhouse.schemaVersion
			const shown =
				applied === null
					? "an unrecognized version"
					: applied.length > 12
						? `an unrecognized version (${applied.slice(0, 8)}…)`
						: `schema ${applied}`
			return fail(
				`Your cluster reports ${shown}; Maple expects schema ${clickhouse.expectedSchemaVersion}.`,
			)
		},
	},
]

const integrationChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "CFG-INTEG-01",
		category: "integrations",
		title: "No integration connection has been revoked",
		severity: "warn",
		fixHint:
			"Reconnect the integration — a revoked grant makes its poller skip silently, with no other surface.",
		evaluate: ({ config }) => {
			const revoked = config.integrations
				.filter((integration) => integration.revokedAt !== null)
				.map((integration) => ({
					kind: "integration" as const,
					name: integration.provider,
					note: "access revoked — reconnect required",
				}))
			return revoked.length === 0
				? PASS
				: fail(
						`${plural(revoked.length, "integration")} lost access. ${conj(revoked.length, "Its", "Their")} data stopped arriving when the grant was revoked.`,
						revoked,
					)
		},
	},
	{
		id: "CFG-INTEG-02",
		category: "integrations",
		title: "Cloudflare analytics collection is succeeding",
		severity: "warn",
		fixHint:
			"Check the Cloudflare integration's permissions — an expired token or a dataset the plan doesn't include is the usual cause.",
		evaluate: ({ config }) => {
			const failing = config.cloudflareAnalytics
				.filter(
					(state) => state.lastErrorAt !== null && state.lastErrorAt > (state.lastSuccessAt ?? 0),
				)
				.map((state) => ({
					kind: "integration" as const,
					name: state.zoneName ? `${state.dataset} · ${state.zoneName}` : state.dataset,
					note: briefError(state.lastError ?? "last poll failed"),
				}))
			return failing.length === 0
				? PASS
				: fail(
						`${plural(failing.length, "Cloudflare dataset")} ${conj(failing.length, "has", "have")} failed since ${conj(failing.length, "its", "their")} last successful poll.`,
						failing,
					)
		},
	},
	{
		id: "CFG-INTEG-03",
		category: "integrations",
		title: "Source repositories are syncing",
		severity: "warn",
		fixHint:
			"Re-check the repository's installation in Settings → Integrations; commit linking and release markers depend on it.",
		evaluate: ({ config }) => {
			const failing = config.vcsRepositories
				.filter((repository) => repository.syncStatus === "error")
				.map((repository) => ({
					kind: "repository" as const,
					id: repository.id,
					name: repository.fullName,
					note: briefError(repository.lastSyncError ?? "sync failed"),
				}))
			return failing.length === 0
				? PASS
				: fail(
						`${plural(failing.length, "repository", "repositories")} failed to sync — release markers and commit context will be stale.`,
						failing,
					)
		},
	},
	{
		id: "CFG-SCRAPE-01",
		category: "integrations",
		title: "Prometheus scrape targets are reachable",
		severity: "warn",
		fixHint: "Verify the target URL and credentials in Settings → Integrations → Prometheus.",
		evaluate: ({ config }) => {
			const failing = config.scrapeTargets
				.filter((target) => target.enabled && target.lastScrapeError !== null)
				.map((target) => ({
					kind: "scrape_target" as const,
					id: target.id,
					name: target.name,
					note: briefError(target.lastScrapeError ?? "scrape failed"),
				}))
			return failing.length === 0
				? PASS
				: fail(
						`${plural(failing.length, "scrape target")} failed ${conj(failing.length, "its", "their")} last scrape.`,
						failing,
					)
		},
	},
]

// ---------------------------------------------------------------------------
// Telemetry checks — what you are actually ingesting, and whether it follows the
// conventions Maple's features read.
// ---------------------------------------------------------------------------

/** Below this a service's log volume is too small for a correlation rate to mean anything. */
const LOG_CORRELATION_MIN_LOGS = 20
/** Share of a service's logs that must lack a TraceId before correlation counts as broken. */
const LOG_CORRELATION_FAIL_RATIO = 0.9
/** Share of a service's spans that must lack an environment before it is worth reporting. */
const MISSING_ENV_RATIO = 0.5
/** Distinct span names per service above which operation grouping stops being useful. */
const SPAN_NAME_CARDINALITY_LIMIT = 500
/** Distinct values for a single metric label above which series counts explode. */
const METRIC_LABEL_CARDINALITY_LIMIT = 1_000
/** Share of a service's database calls that may lack a namespace before the node loses its identity. */
const DB_NAMESPACE_MISSING_RATIO = 0.5
/** Org-wide log volume above which having no structured log attributes is a real finding. */
const UNSTRUCTURED_LOG_MIN_VOLUME = 1_000
/** Distinct log-scope attribute keys below which logging is effectively unstructured. */
const UNSTRUCTURED_LOG_KEY_LIMIT = 3

const STANDARD_SEVERITIES = new Set(["TRACE", "DEBUG", "INFO", "WARN", "WARNING", "ERROR", "FATAL"])

/**
 * Attribute keys people invent instead of the semconv names Maple reads. `deployment.commit_sha` is
 * deliberately absent — Maple's own rollups pre-extract it, so it is supported, not invented.
 */
const INVENTED_RESOURCE_KEYS = [
	"env",
	"environment",
	"git.repo",
	"git.commit",
	"git.sha",
	"repo.url",
	"commit.sha",
	"app.repo_url",
	"service.env",
]

/**
 * Key-name fragments that suggest a secret is being written into telemetry. Matched per separator-
 * delimited segment (plus a few compounds) rather than as substrings, so `gen_ai.usage.output_tokens`
 * does not trip the `token` rule. Values are never scanned — that would mean reading every attribute
 * map in the warehouse.
 */
const SENSITIVE_SEGMENTS = new Set([
	"password",
	"passwd",
	"secret",
	"token",
	"authorization",
	"credential",
	"credentials",
	"ssn",
	"cvv",
	"pin",
])
const SENSITIVE_COMPOUNDS = [
	"apikey",
	"accesstoken",
	"refreshtoken",
	"sessiontoken",
	"privatekey",
	"creditcard",
	"setcookie",
]

/** True when an attribute key name looks like it carries a secret. */
export const looksSensitive = (key: string): boolean => {
	const lower = key.toLowerCase()
	if (lower.split(/[.\-_/]/).some((segment) => SENSITIVE_SEGMENTS.has(segment))) return true
	const squashed = lower.replaceAll(/[.\-_/]/g, "")
	return SENSITIVE_COMPOUNDS.some((needle) => squashed.includes(needle))
}

const ingestCoverageChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "RES-01",
		category: "ingestion",
		title: "Every service sets service.name",
		severity: "critical",
		needsWarehouse: true,
		fixHint:
			"Set `service.name` explicitly on the OTel resource in each service's bootstrap — the SDK default is not a usable identity.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			// Both failure modes of an unset resource: the SDK's synthetic default, and an empty
			// string where the attribute was omitted entirely.
			const unknown = warehouse.serviceUsage
				.filter(
					(service) =>
						service.serviceName === "" || service.serviceName.startsWith("unknown_service"),
				)
				.map((service) => ({
					kind: "service" as const,
					name: service.serviceName === "" ? "(no service.name)" : service.serviceName,
					note: `${service.traceCount} traces, ${service.logCount} logs`,
				}))
			return unknown.length === 0
				? PASS
				: fail(
						"Telemetry is arriving with no usable `service.name` — either the SDK's synthetic `unknown_service` default or an empty value. It is invisible to the services list, the service map and any alert scoped by service.",
						unknown,
					)
		},
	},
	{
		id: "ING-01",
		category: "ingestion",
		title: "Service names agree across signals",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Share one resource (and therefore one `service.name`) between the tracer and the logger in each service.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			// Logs-only, deliberately NOT metrics-only: scraped exporters, cloud-platform collectors
			// and synthetic checks all legitimately ship metrics under a name that never traces, and
			// flagging them buries the real signal. A service shipping OTLP logs almost always has a
			// tracer in the same process, so logs without traces really does mean the names disagree.
			// Unnamed services are RES-01's finding, not a mismatch.
			const split = warehouse.serviceUsage
				.filter(
					(service) =>
						service.traceCount === 0 && service.logCount > 0 && service.serviceName !== "",
				)
				.map((service) => ({
					kind: "service" as const,
					name: service.serviceName,
					note: "logs but no traces",
				}))
			return split.length === 0
				? PASS
				: fail(
						`${plural(split.length, "service name")} ${conj(split.length, "appears", "appear")} in logs but never in traces — usually the tracer and the logger were configured with different \`service.name\` values, which splits one service into two everywhere in Maple.`,
						split,
					)
		},
	},
	{
		id: "LOG-01",
		category: "ingestion",
		title: "Traced services also ship logs",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Wire an OTLP log bridge under the service's existing logger — stdout-only logging never reaches Maple.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			// Gated on the org logging at all: a traces-only setup is a legitimate choice, an
			// inconsistent one is the finding.
			if (!warehouse.serviceUsage.some((service) => service.logCount > 0)) return PASS
			const silent = warehouse.serviceUsage
				.filter((service) => service.traceCount > 0 && service.logCount === 0)
				.map((service) => ({
					kind: "service" as const,
					name: service.serviceName,
					note: "traces only",
				}))
			return silent.length === 0
				? PASS
				: fail(
						`${plural(silent.length, "service")} ${conj(silent.length, "sends", "send")} traces but no logs, while the rest of the org logs normally. Jumping from a trace to its logs will dead-end there.`,
						silent,
					)
		},
	},
	{
		id: "LOG-02",
		category: "ingestion",
		title: "Logs carry trace context",
		severity: "critical",
		needsWarehouse: true,
		fixHint:
			"The log bridge is not on the path the app logs through. Attach it to the logger the code actually calls, inside the active span's context.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const traced = new Set(
				warehouse.serviceUsage.filter((s) => s.traceCount > 0).map((s) => s.serviceName),
			)
			const broken = warehouse.logCorrelation
				.filter(
					(row) =>
						traced.has(row.serviceName) &&
						row.logCount >= LOG_CORRELATION_MIN_LOGS &&
						row.uncorrelatedCount / row.logCount > LOG_CORRELATION_FAIL_RATIO,
				)
				.map((row) => ({
					kind: "service" as const,
					name: row.serviceName,
					note: `${percent(row.uncorrelatedCount, row.logCount)} of logs have no trace_id${
						row.uncorrelatedErrorCount > 0
							? `, including ${row.uncorrelatedErrorCount} error-level`
							: ""
					}`,
				}))
			return broken.length === 0
				? PASS
				: fail(
						`${plural(broken.length, "service")} ${conj(broken.length, "emits", "emit")} logs with no trace context despite being traced (last ${warehouse.logCorrelationHours}h). Trace↔log correlation is unavailable for them.`,
						broken,
					)
		},
	},
	{
		id: "LOG-03",
		category: "ingestion",
		title: "Logs are structured",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Pass fields as log attributes (`order_id`, `user_id`) instead of interpolating them into the message string.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const totalLogs = warehouse.serviceUsage.reduce((sum, service) => sum + service.logCount, 0)
			if (totalLogs < UNSTRUCTURED_LOG_MIN_VOLUME) return PASS
			const logKeys = keysForScope(warehouse, "log").size
			return logKeys >= UNSTRUCTURED_LOG_KEY_LIMIT
				? PASS
				: fail(
						`${totalLogs.toLocaleString("en-US")} log records arrived carrying ${plural(logKeys, "distinct attribute key")}. Attribute chips, filtering and pattern mining all read those keys.`,
					)
		},
	},
	{
		id: "LOG-04",
		category: "ingestion",
		title: "Log severities use the standard levels",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Map your logger's levels onto TRACE/DEBUG/INFO/WARN/ERROR/FATAL in the OTLP bridge — severity drives row coloring and the error banner.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const offenders = warehouse.logSeverity
				.filter((row) => {
					const text = row.severityText.trim().toUpperCase()
					if (text === "") return false
					// OTel allows a numeric suffix within a level, e.g. `DEBUG3`.
					return !STANDARD_SEVERITIES.has(text.replace(/\d+$/, ""))
				})
				.map((row) => ({
					kind: "service" as const,
					name: row.serviceName,
					note: `severity "${row.severityText}" (${row.logCount} records)`,
				}))
			return offenders.length === 0
				? PASS
				: fail(
						`${plural(offenders.length, "non-standard severity value")} in use. Maple colors rows and raises the error banner from the standard levels only.`,
						offenders,
					)
		},
	},
]

const attributeQualityChecks: ReadonlyArray<AuditCheck> = [
	resourceKeyCheck(
		"RES-02",
		"Services report their version",
		["service.version"],
		"No `service.version` on any resource. Per-version slices on service overview are empty, so a regression cannot be tied to a release.",
		"Set `service.version` on the OTel resource from your build's release or short commit SHA.",
	),
	resourceKeyCheck(
		"RES-04",
		"Telemetry links back to source",
		["vcs.repository.url.full"],
		"No `vcs.repository.url.full` on any resource, so Maple cannot link a service back to its repository for source context in error debugging.",
		"Set `vcs.repository.url.full` to the canonical https repo URL — not an SSH remote, not a local path.",
	),
	resourceKeyCheck(
		"RES-05",
		"Deploys are identifiable",
		["vcs.ref.head.revision", "deployment.commit_sha"],
		"No commit revision on any resource. Release markers and per-deploy comparisons have nothing to anchor to.",
		"Set `vcs.ref.head.revision` best-effort from the build environment (`VERCEL_GIT_COMMIT_SHA`, `GITHUB_SHA`, …). Never shell out to git at runtime.",
	),
	{
		id: "RES-06",
		category: "attributes",
		title: "No invented resource keys alongside the semconv ones",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Rename to the semantic-convention key. Invented keys are stored faithfully but no Maple feature reads them.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const present = keysForScope(warehouse, "resource")
			const invented = INVENTED_RESOURCE_KEYS.filter((key) => present.has(key)).map((key) => ({
				kind: "attribute_key" as const,
				name: key,
			}))
			return invented.length === 0
				? PASS
				: fail(
						`${plural(invented.length, "resource attribute")} ${conj(invented.length, "duplicates", "duplicate")} a semantic-convention key under a name nothing reads. The data arrives, but environment filtering and source linking stay empty.`,
						invented,
					)
		},
	},
	{
		id: "RES-03",
		category: "attributes",
		title: "Spans carry a deployment environment",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Set `deployment.environment.name` (Maple also accepts the legacy `deployment.environment`) on the resource in each service's bootstrap.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const missing = warehouse.spanShape
				.filter(
					(service) =>
						service.spanCount > 0 && service.noEnvCount / service.spanCount > MISSING_ENV_RATIO,
				)
				.map((service) => ({
					kind: "service" as const,
					name: service.serviceName,
					note: `${percent(service.noEnvCount, service.spanCount)} of spans have no environment`,
				}))
			return missing.length === 0
				? PASS
				: fail(
						`${plural(missing.length, "service")} ${conj(missing.length, "sends", "send")} most of ${conj(missing.length, "its", "their")} spans with no deployment environment, so environment filtering silently drops them.`,
						missing,
					)
		},
	},
	{
		id: "NAME-02",
		category: "attributes",
		title: "Span names are low-cardinality",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Use `domain.verb` span names (`order.process`) and move IDs and URLs into attributes — never into the name.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const exploded = warehouse.spanShape
				.filter((service) => service.spanNameCount > SPAN_NAME_CARDINALITY_LIMIT)
				.map((service) => ({
					kind: "service" as const,
					name: service.serviceName,
					note: `${service.spanNameCount.toLocaleString("en-US")} distinct span names`,
				}))
			return exploded.length === 0
				? PASS
				: fail(
						`${plural(exploded.length, "service")} ${conj(exploded.length, "emits", "emit")} more than ${SPAN_NAME_CARDINALITY_LIMIT.toLocaleString("en-US")} distinct span names — a sign IDs or URLs are in the name. Operation grouping and top-operations become unusable.`,
						exploded,
					)
		},
	},
	{
		id: "NAME-03",
		category: "attributes",
		title: "The maple_* namespace is left alone",
		severity: "warn",
		needsWarehouse: true,
		fixHint: "Rename these to your own namespace — `maple_*` is reserved and hidden from the UI.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const reserved = warehouse.attributeKeys
				.filter((row) => row.scope !== "resource" && row.key.toLowerCase().startsWith("maple_"))
				.map((row) => ({ kind: "attribute_key" as const, name: row.key, note: row.scope }))
			return reserved.length === 0
				? PASS
				: fail(
						`${plural(reserved.length, "attribute")} ${conj(reserved.length, "uses", "use")} the reserved \`maple_*\` namespace and ${conj(reserved.length, "is", "are")} hidden from the UI — the data is stored but you cannot see it.`,
						reserved,
					)
		},
	},
	{
		id: "PII-01",
		category: "attributes",
		title: "No secrets in attribute names",
		severity: "critical",
		needsWarehouse: true,
		fixHint:
			"Stop emitting these at the SDK and rotate anything already sent — telemetry is broadly visible within the workspace and retained.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const sensitive = warehouse.attributeKeys
				.filter((row) => looksSensitive(row.key))
				.map((row) => ({ kind: "attribute_key" as const, name: row.key, note: row.scope }))
			return sensitive.length === 0
				? PASS
				: fail(
						`${plural(sensitive.length, "attribute key")} ${conj(sensitive.length, "is", "are")} named as though ${conj(sensitive.length, "it carries", "they carry")} a credential. Only the key names were inspected — check the values before assuming this is a false positive.`,
						sensitive,
					)
		},
	},
	{
		id: "MET-01",
		category: "attributes",
		title: "Metric labels are low-cardinality",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Drop unbounded IDs (user, order, request, raw URL) from metric labels — put them on spans instead, where cardinality is free.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const exploded = warehouse.metricLabels
				.filter((label) => label.valueCardinality > METRIC_LABEL_CARDINALITY_LIMIT)
				.map((label) => ({
					kind: "attribute_key" as const,
					name: label.attributeKey,
					note: `~${label.valueCardinality.toLocaleString("en-US")} distinct values`,
				}))
			return exploded.length === 0
				? PASS
				: fail(
						`${plural(exploded.length, "metric label")} ${conj(exploded.length, "has", "have")} very high cardinality, which multiplies stored series and slows every metrics query. Counter metrics only — gauges and histograms are not covered by this check.`,
						exploded,
					)
		},
	},
]

const serviceMapChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "STAT-01",
		category: "traces",
		title: "Span status and kind use the values Maple stores",
		severity: "critical",
		needsWarehouse: true,
		fixHint:
			"Set status through the SDK's status API rather than hand-stamping a string — error analytics match `Error` exactly, so wrong casing yields zero errors.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const offenders = warehouse.spanShape
				.filter((service) => service.badStatusCodes.length > 0 || service.badSpanKinds.length > 0)
				.map((service) => ({
					kind: "service" as const,
					name: service.serviceName,
					note: [
						...service.badStatusCodes.map((value) => `status "${value}"`),
						...service.badSpanKinds.map((value) => `kind "${value}"`),
					].join(", "),
				}))
			return offenders.length === 0
				? PASS
				: fail(
						`${plural(offenders.length, "service")} ${conj(offenders.length, "emits", "emit")} span status or kind values Maple does not recognize. Those spans are invisible to error rate, the service map and every alert that filters on them.`,
						offenders,
					)
		},
	},
	{
		id: "STAT-02",
		category: "traces",
		title: "Failures are recorded on the span, not just logged",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"On failure paths set Error status and record the exception before rethrowing — a span that swallows the error stays `Unset` and hides it.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const errorLogsByService = new Map<string, number>()
			for (const row of warehouse.logSeverity) {
				const text = row.severityText.trim().toUpperCase().replace(/\d+$/, "")
				if (text !== "ERROR" && text !== "FATAL") continue
				errorLogsByService.set(
					row.serviceName,
					(errorLogsByService.get(row.serviceName) ?? 0) + row.logCount,
				)
			}
			const swallowed = warehouse.spanShape
				.filter(
					(service) =>
						service.spanCount > 0 &&
						service.errorCount === 0 &&
						(errorLogsByService.get(service.serviceName) ?? 0) > 0,
				)
				.map((service) => ({
					kind: "service" as const,
					name: service.serviceName,
					note: `${errorLogsByService.get(service.serviceName)} error logs, no error spans`,
				}))
			return swallowed.length === 0
				? PASS
				: fail(
						`${plural(swallowed.length, "service")} ${conj(swallowed.length, "logs", "log")} errors but never ${conj(swallowed.length, "marks", "mark")} a span as failed, so ${conj(swallowed.length, "its", "their")} error rate reads as zero and ${conj(swallowed.length, "its", "their")} failures never open an issue.`,
						swallowed,
					)
		},
	},
	{
		id: "STAT-04",
		category: "traces",
		title: "Inbound work produces Server or Consumer spans",
		severity: "info",
		needsWarehouse: true,
		fixHint:
			"Expected for cron jobs and workers with no inbound traffic. For anything serving requests, register the HTTP-server or queue-consumer instrumentation.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const noEntry = warehouse.spanShape
				.filter(
					(service) =>
						service.spanCount > 0 && service.serverCount === 0 && service.consumerCount === 0,
				)
				.map((service) => ({
					kind: "service" as const,
					name: service.serviceName,
					note: "no Server or Consumer spans",
				}))
			return noEntry.length === 0
				? PASS
				: fail(
						`${plural(noEntry.length, "service")} ${conj(noEntry.length, "emits", "emit")} no entry-point spans. If they serve requests or consume a queue, that instrumentation is not registered — and route views, throughput attribution and Apdex stay empty for them.`,
						noEntry,
					)
		},
	},
	{
		id: "MAP-02",
		category: "traces",
		title: "Database calls identify their database",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Set `db.namespace` (or the legacy `db.name`) on database client spans so each database gets its own node.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			const anonymous = warehouse.dbEdges
				.filter(
					(edge) =>
						edge.callCount > 0 &&
						edge.unknownNamespaceCallCount / edge.callCount > DB_NAMESPACE_MISSING_RATIO,
				)
				.map((edge) => ({
					kind: "service" as const,
					name: `${edge.serviceName} → ${edge.dbSystem}`,
					note: `${percent(edge.unknownNamespaceCallCount, edge.callCount)} of calls have no db.namespace`,
				}))
			return anonymous.length === 0
				? PASS
				: fail(
						`${plural(anonymous.length, "database dependency", "database dependencies")} ${conj(anonymous.length, "arrives", "arrive")} without a namespace, so every database behind that driver collapses into one anonymous node on the service map.`,
						anonymous,
					)
		},
	},
	{
		id: "MAP-03",
		category: "traces",
		title: "Dependencies are spelled consistently",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Pick one canonical spelling per dependency and use it in every service — Maple treats the strings as distinct nodes.",
		evaluate: ({ warehouse }) => {
			if (!warehouse) return PASS
			// Group by (key, casefolded value); more than one raw spelling in a group is a collision.
			const spellings = new Map<string, Set<string>>()
			for (const row of warehouse.peerValues) {
				const groupKey = `${row.attributeKey}\x00${row.attributeValue.toLowerCase()}`
				const bucket = spellings.get(groupKey)
				if (bucket) bucket.add(row.attributeValue)
				else spellings.set(groupKey, new Set([row.attributeValue]))
			}
			const collisions = [...spellings.entries()]
				.filter(([, values]) => values.size > 1)
				.map(([groupKey, values]) => ({
					kind: "attribute_key" as const,
					name: groupKey.split("\x00")[0] ?? "",
					note: [...values].sort().join(" / "),
				}))
			return collisions.length === 0
				? PASS
				: fail(
						`${plural(collisions.length, "dependency name")} ${conj(collisions.length, "is", "are")} spelled more than one way. Each spelling becomes its own node, fragmenting one logical dependency across the service map.`,
						collisions,
					)
		},
	},
]

// ---------------------------------------------------------------------------
// Trace completeness
//
// These read a short, lagged, possibly trace-sampled window, so they speak in rates and never claim
// exact counts. Crucially they cannot detect ingest loss — the warehouse only ever sees what arrived.
// Every finding below is phrased as an internal-consistency result, which is what it actually is.
// ---------------------------------------------------------------------------

/** Below this many observed children a service's orphan rate is noise. */
const TRACE_MIN_SAMPLE = 50
/** Orphan / rootless share above which the gap is structural rather than incidental. */
const TRACE_GAP_RATIO = 0.1
/** Above this share, a rootless rate is systemic — one upstream finding, not one per service. */
const ROOTLESS_SYSTEMIC_RATIO = 0.95
/** Share of orphans that must sit inside sampled traces before sampling is the better explanation. */
const SAMPLING_EXPLAINS_RATIO = 0.5

const traceCompletenessChecks: ReadonlyArray<AuditCheck> = [
	{
		id: "TRC-01",
		category: "traces",
		title: "Spans arrive with their parent",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Either the caller's span never arrived (check its exporter and that `traceparent` survives the hop), or the caller modeled the outbound call as an `Internal` span — which also hides that call from the service map.",
		evaluate: ({ warehouse }) => {
			const traces = warehouse?.traceCompleteness
			if (!traces) return PASS
			const broken = traces.orphans
				.filter((row) => {
					if (row.childCount < TRACE_MIN_SAMPLE) return false
					// Orphans inside sampling-marked traces are expected — a dropped parent is the
					// sampler working. Those are reported by TRC-03 instead.
					const unsampled = row.orphanCount - row.sampledOrphanCount
					return unsampled / row.childCount > TRACE_GAP_RATIO
				})
				.map((row) => ({
					kind: "service" as const,
					name: row.serviceName,
					note: `${percent(row.orphanCount - row.sampledOrphanCount, row.childCount)} of entry spans reference a parent that never arrived${
						row.sampleTraceIds[0] ? ` (e.g. trace ${row.sampleTraceIds[0]})` : ""
					}`,
				}))
			return broken.length === 0
				? PASS
				: fail(
						`${plural(broken.length, "service")} ${conj(broken.length, "receives", "receive")} spans whose parent span is missing, so those traces render as fragments rather than one end-to-end view.`,
						broken,
					)
		},
	},
	{
		id: "TRC-02",
		category: "traces",
		title: "Traces have a root span",
		severity: "warn",
		needsWarehouse: true,
		fixHint:
			"Instrument the first hop that creates trace context, or let your ingress service start the trace instead of continuing one from upstream.",
		evaluate: ({ warehouse }) => {
			const traces = warehouse?.traceCompleteness
			if (!traces) return PASS
			const eligible = traces.rootless.filter((row) => row.traceCount >= TRACE_MIN_SAMPLE)
			const gaps = eligible.filter(
				(row) => (row.rootlessCount - row.sampledRootlessCount) / row.traceCount > TRACE_GAP_RATIO,
			)
			if (gaps.length === 0) return PASS

			// A near-total, uniform rootless rate is one architectural fact — trace context is being
			// created upstream of anything instrumented — not N independent per-service defects.
			const systemic =
				gaps.length === eligible.length &&
				eligible.every((row) => row.rootlessCount / row.traceCount > ROOTLESS_SYSTEMIC_RATIO)
			if (systemic) {
				return fail(
					"Essentially every trace arrives without a root span, across all services. Trace context is being created upstream of your instrumented services — typically a proxy, gateway or load balancer that injects `traceparent` but exports no spans of its own.",
				)
			}

			return fail(
				`${plural(gaps.length, "service")} ${conj(gaps.length, "starts", "start")} traces that have no root span. Trace duration and the waterfall's origin are both wrong for them.`,
				gaps.map((row) => ({
					kind: "service" as const,
					name: row.entryService,
					note: `${percent(row.rootlessCount - row.sampledRootlessCount, row.traceCount)} of traces entering here have no root`,
				})),
			)
		},
	},
	{
		id: "TRC-03",
		category: "traces",
		title: "Sampling is applied consistently across services",
		severity: "info",
		needsWarehouse: true,
		fixHint:
			"Use a consistent-probability sampler with the same ratio in every service, and propagate the sampling decision — otherwise a kept child can lose its dropped parent.",
		evaluate: ({ warehouse }) => {
			const traces = warehouse?.traceCompleteness
			if (!traces) return PASS
			const sampled = traces.orphans
				.filter(
					(row) =>
						row.orphanCount > 0 &&
						row.childCount >= TRACE_MIN_SAMPLE &&
						row.sampledOrphanCount / row.orphanCount > SAMPLING_EXPLAINS_RATIO,
				)
				.map((row) => ({
					kind: "service" as const,
					name: row.serviceName,
					note: `${percent(row.sampledOrphanCount, row.orphanCount)} of its incomplete traces were sampling-marked`,
				}))
			return sampled.length === 0
				? PASS
				: fail(
						`${plural(sampled.length, "service")} ${conj(sampled.length, "receives", "receive")} spans whose parent was dropped by sampling. Nothing is broken, but those traces are partial — services that disagree about sampling ratios produce exactly this.`,
						sampled,
					)
		},
	},
]

export const SETUP_AUDIT_CHECKS: ReadonlyArray<AuditCheck> = [
	...alertingChecks,
	...notificationChecks,
	...ingestionChecks,
	...ingestCoverageChecks,
	...attributeQualityChecks,
	...serviceMapChecks,
	...traceCompletenessChecks,
	...platformChecks,
	...integrationChecks,
]

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const emptySummary: SetupAuditSummary = { critical: 0, warn: 0, info: 0, pass: 0, skip: 0 }

/**
 * Evaluate every check against one input snapshot.
 *
 * Two short-circuits worth knowing about:
 *  - An org that has never received telemetry returns `no_data` with zero checks. Twenty failing
 *    checks against an org that hasn't connected yet is noise; the onboarding checklist owns that phase.
 *  - When the warehouse is unreachable, `needsWarehouse` checks report `skip` rather than failing the
 *    request, so the config half of the audit still lands.
 */
export function runSetupAudit(inputs: SetupAuditInputs): SetupAuditReport {
	const warehouseAvailable = inputs.warehouse !== undefined

	if (inputs.config.firstDataReceivedAt === null) {
		return {
			generatedAt: inputs.now,
			dataStatus: "no_data",
			warehouseAvailable,
			summary: emptySummary,
			checks: [],
			openRecommendationCount: inputs.config.openRecommendationCount,
		}
	}

	const checks: AuditCheckResult[] = []
	const summary = { ...emptySummary }

	for (const check of SETUP_AUDIT_CHECKS) {
		if (check.needsWarehouse === true && !warehouseAvailable) {
			summary.skip += 1
			checks.push({
				id: check.id,
				category: check.category,
				title: check.title,
				severity: check.severity,
				status: "skip",
				detail: "Requires telemetry data, which is currently unavailable.",
				affected: [],
				affectedCount: 0,
				fixHint: check.fixHint,
			})
			continue
		}

		const evaluation = check.evaluate(inputs)
		if (evaluation.status === "pass") summary.pass += 1
		else summary[check.severity] += 1

		checks.push({
			id: check.id,
			category: check.category,
			title: check.title,
			severity: check.severity,
			status: evaluation.status,
			detail: evaluation.detail ?? null,
			affected: evaluation.affected ?? [],
			affectedCount: evaluation.affectedCount ?? evaluation.affected?.length ?? 0,
			fixHint: check.fixHint,
		})
	}

	return {
		generatedAt: inputs.now,
		dataStatus: "ok",
		warehouseAvailable,
		summary,
		checks,
		openRecommendationCount: inputs.config.openRecommendationCount,
	}
}
