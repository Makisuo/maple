import {
	optionalNumberParam,
	optionalStringParam,
	optionalTimeParam,
	requiredStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { warehouseToMcpHandlers } from "@/mcp/lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import {
	resolveTimeRange,
	rangeExceededResult,
	MCP_DISCOVERY_MAX_HOURS,
} from "@/mcp/lib/time"
import { clampLimit } from "@/mcp/lib/limits"
import { formatTable, formatNumber, formatPercent, truncate } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { createDualContent } from "@/mcp/lib/structured-output"
import { Effect, Result, Schema } from "effect"
import {
	FUNNEL_MAX_STEPS,
	FunnelBreakdownBy,
	FunnelKeyBy,
	FunnelStep,
	funnelStepLabel,
	type FunnelKeyBy as FunnelKeyByType,
	type FunnelStep as FunnelStepType,
} from "@maple/query-model"
import type { QueryFunnelData } from "@maple/domain"
import { productEventsFunnel, productEventsFunnelBreakdown } from "@maple/query-engine/observability"

const TOOL = "query_funnel"

const StepsFromJson = Schema.fromJsonString(Schema.Array(FunnelStep))
const decodeSteps = Schema.decodeEffect(StepsFromJson)
const decodeBreakdownBy = Schema.decodeUnknownOption(FunnelBreakdownBy)
const decodeKeyBy = Schema.decodeUnknownOption(FunnelKeyBy)

const DEFAULT_WINDOW_SECONDS = 24 * 3600
const DEFAULT_RANGE_HOURS = 7 * 24
const BREAKDOWN_MAX_GROUPS = 20

const STEPS_EXAMPLE =
	'[{"kind":"page","pagePath":"/pricing"},{"kind":"event","eventName":"signup_completed"},{"kind":"event","eventName":"plan_started","attributeEquals":{"plan":"pro"}}]'

const KEY_BY_NOUN = {
	person: "persons",
	visitor: "visitors",
	user: "users",
	session: "sessions",
} satisfies Record<FunnelKeyByType, string>

/** Share of `denominator`, or null when there is nothing to divide by. */
const ratio = (numerator: number, denominator: number): number | null =>
	denominator > 0 ? numerator / denominator : null

const fmtPct = (fraction: number | null): string => (fraction === null ? "—" : formatPercent(fraction))

export function registerQueryFunnelTool(server: McpToolRegistrar) {
	server.tool(
		TOOL,
		'Run a conversion funnel over product events — page views, browser `track()` events and server-side events, stitched per person. Give 1–10 ordered steps as `steps_json`; each step is `{kind:"event", eventName, attributeEquals?}`, `{kind:"page", pagePath, host?}`, or (step 1 only) `{kind:"session", dimension, value}` for how the session was acquired (`dimension`: referrerHost | utmSource | utmMedium | utmCampaign | country | host). Returns per-step counts, share of step 1, step-to-step conversion and drop-off; optionally broken down by an acquisition dimension or an event attribute (`breakdown_by`: one of the session dimensions, or `attribute:<key>`). Call `list_product_events` first to see which event names exist. Filters (`host`, `page_path`, `referrer_host`, `country`, `utm_*`, `device_type`, `browser`) narrow the population to persons with a matching session.',
		Schema.Struct({
			steps_json: requiredStringParam(
				`JSON array of 1–${FUNNEL_MAX_STEPS} funnel steps, in order. Example: ${STEPS_EXAMPLE}`,
			),
			key_by: optionalStringParam(
				"What to count: `person` (default — user id when known, else the visitor's linked user, else the visitor), `visitor`, `user`, or `session` (per-session funnel; server events take no part).",
			),
			window_seconds: optionalNumberParam(
				"The whole chain must complete within this many seconds of the step-1 event. Default 86400 (24h).",
			),
			breakdown_by: optionalStringParam(
				"Group persons by `referrerHost`, `utmSource`, `utmMedium`, `utmCampaign`, `country`, `host`, or `attribute:<key>` (an attribute on their events). Top groups by step-1 count.",
			),
			breakdown_limit: optionalNumberParam(
				`Groups to keep when breaking down (default 10, max ${BREAKDOWN_MAX_GROUPS}).`,
			),
			start_time: optionalTimeParam(
				"Start of time range (YYYY-MM-DD HH:mm:ss). Default: last 7 days.",
			),
			end_time: optionalTimeParam("End of time range (YYYY-MM-DD HH:mm:ss)."),
			host: optionalStringParam("Only persons with a session on this site host."),
			page_path: optionalStringParam("Only persons with a session that viewed this page path."),
			referrer_host: optionalStringParam("Only persons whose session was referred by this host."),
			country: optionalStringParam("Only persons with a session from this country (ISO code)."),
			utm_source: optionalStringParam("Only persons with a session carrying this utm_source."),
			utm_medium: optionalStringParam("Only persons with a session carrying this utm_medium."),
			utm_campaign: optionalStringParam("Only persons with a session carrying this utm_campaign."),
			device_type: optionalStringParam(
				"Only persons with a session on this device type (desktop, mobile, tablet).",
			),
			browser: optionalStringParam("Only persons with a session in this browser (e.g. Chrome)."),
		}),
		Effect.fn("McpTool.queryFunnel")(function* (params) {
			const range = resolveTimeRange(params.start_time, params.end_time, {
				defaultHours: DEFAULT_RANGE_HOURS,
				maxHours: MCP_DISCOVERY_MAX_HOURS,
			})
			const { st, et } = range
			if (range.exceeded) return rangeExceededResult(range, TOOL)

			const stepsResult = yield* Effect.result(decodeSteps(params.steps_json))
			if (Result.isFailure(stepsResult)) {
				return validationError(`Invalid steps_json: ${String(stepsResult.failure)}`, STEPS_EXAMPLE)
			}
			const steps: ReadonlyArray<FunnelStepType> = stepsResult.success
			if (steps.length === 0)
				return validationError("steps_json must contain at least one step.", STEPS_EXAMPLE)
			if (steps.length > FUNNEL_MAX_STEPS) {
				return validationError(`A funnel has at most ${FUNNEL_MAX_STEPS} steps, got ${steps.length}.`)
			}
			const lateSession = steps.findIndex((step, index) => index > 0 && step.kind === "session")
			if (lateSession !== -1) {
				return validationError(
					`A session step is only valid as step 1, found one at step ${lateSession + 1}.`,
					'[{"kind":"session","dimension":"utmSource","value":"twitter"},{"kind":"event","eventName":"signup_completed"}]',
				)
			}

			const keyByOption = params.key_by === undefined ? undefined : decodeKeyBy(params.key_by)
			if (keyByOption !== undefined && keyByOption._tag === "None") {
				return validationError(
					`key_by must be one of ${FunnelKeyBy.literals.join(", ")}; got "${params.key_by}".`,
				)
			}
			const keyBy = keyByOption === undefined ? "person" : keyByOption.value

			const windowSeconds = params.window_seconds ?? DEFAULT_WINDOW_SECONDS
			if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
				return validationError(
					`window_seconds must be a positive number; got ${String(params.window_seconds)}.`,
				)
			}

			const breakdownOption =
				params.breakdown_by === undefined ? undefined : decodeBreakdownBy(params.breakdown_by)
			if (breakdownOption !== undefined && breakdownOption._tag === "None") {
				return validationError(
					`breakdown_by must be one of referrerHost, utmSource, utmMedium, utmCampaign, country, host, or attribute:<key>; got "${params.breakdown_by}".`,
					'{ "breakdown_by": "attribute:plan" }',
				)
			}
			const breakdownBy = breakdownOption?.value

			const filters = {
				host: params.host ?? undefined,
				pagePath: params.page_path ?? undefined,
				referrerHost: params.referrer_host ?? undefined,
				country: params.country ?? undefined,
				utmSource: params.utm_source ?? undefined,
				utmMedium: params.utm_medium ?? undefined,
				utmCampaign: params.utm_campaign ?? undefined,
				deviceType: params.device_type ?? undefined,
				browserName: params.browser ?? undefined,
			}

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				steps: steps.length,
				keyBy,
				windowSeconds,
				breakdownBy: breakdownBy ?? "none",
			})

			const definition = { steps, keyBy, windowSeconds, filters, startTime: st, endTime: et }

			// The builder's own validation is the last word (it also catches what the
			// checks above did not think of); its rejection is a caller error, not a
			// tool failure.
			const outcome = yield* withTenantExecutor(productEventsFunnel(definition)).pipe(
				Effect.catchTags(warehouseToMcpHandlers(TOOL)),
				Effect.catchTag("@maple/query-engine/ProductEventsFunnelError", (error) =>
					Effect.succeed({ invalid: error.message }),
				),
			)
			if ("invalid" in outcome) return validationError(outcome.invalid, STEPS_EXAMPLE)
			const counts = new Map(outcome.map((row) => [Number(row.step), Number(row.count) || 0]))

			const first = counts.get(1) ?? 0
			const stepData = steps.map((step, index) => {
				const count = counts.get(index + 1) ?? 0
				const previous = index === 0 ? null : (counts.get(index) ?? 0)
				return {
					step: index + 1,
					label: funnelStepLabel(step),
					count,
					ofFirst: index === 0 ? (first > 0 ? 1 : 0) : (ratio(count, first) ?? 0),
					ofPrevious: previous === null ? null : ratio(count, previous),
					dropOff: previous === null ? 0 : Math.max(0, previous - count),
				}
			})
			const conversion = steps.length < 2 ? null : ratio(stepData[stepData.length - 1]!.count, first)
			const noun = KEY_BY_NOUN[keyBy]

			const lines: string[] = [
				`## Funnel (${steps.length} step${steps.length === 1 ? "" : "s"}, by ${keyBy}, within ${windowSeconds}s)`,
				`Time range: ${st} — ${et}`,
				"",
			]
			if (first === 0) {
				lines.push(`Nobody matched step 1 (${funnelStepLabel(steps[0]!)}) in this window.`)
			} else {
				lines.push(
					formatTable(
						[
							"#",
							"Step",
							noun[0]!.toUpperCase() + noun.slice(1),
							"Of first",
							"Of previous",
							"Drop-off",
						],
						stepData.map((stat) => [
							String(stat.step),
							truncate(stat.label, 60),
							formatNumber(stat.count),
							fmtPct(stat.ofFirst),
							fmtPct(stat.ofPrevious),
							stat.step === 1 ? "—" : `-${formatNumber(stat.dropOff)}`,
						]),
					),
					"",
					conversion === null
						? "Add a second step to measure conversion."
						: `**Conversion: ${formatPercent(conversion)}** (${formatNumber(stepData[stepData.length - 1]!.count)} of ${formatNumber(first)} ${noun}).`,
				)
			}

			let breakdown: QueryFunnelData["breakdown"]
			if (breakdownBy !== undefined && first > 0) {
				const limit = clampLimit(params.breakdown_limit, {
					defaultValue: 10,
					max: BREAKDOWN_MAX_GROUPS,
				})
				const groupRows = yield* withTenantExecutor(
					productEventsFunnelBreakdown({ ...definition, breakdownBy, limit }),
				).pipe(
					Effect.catchTags(warehouseToMcpHandlers(TOOL)),
					// The definition already ran once above, so a builder rejection here
					// cannot happen; keep the channel typed rather than dying on it.
					Effect.catchTag("@maple/query-engine/ProductEventsFunnelError", () => Effect.succeed([])),
				)
				const byGroup = new Map<string, number[]>()
				for (const row of groupRows) {
					const group = String(row.group)
					let arr = byGroup.get(group)
					if (!arr) {
						arr = new Array<number>(steps.length).fill(0)
						byGroup.set(group, arr)
					}
					const index = Number(row.step) - 1
					if (index >= 0 && index < steps.length) arr[index] = Number(row.count) || 0
				}
				const groups = [...byGroup.entries()].map(([group, groupCounts]) => ({
					group,
					counts: groupCounts,
					conversion:
						steps.length < 2
							? null
							: ratio(groupCounts[groupCounts.length - 1] ?? 0, groupCounts[0] ?? 0),
				}))
				breakdown = { by: breakdownBy, groups }

				lines.push("", `### By ${breakdownBy} (top ${groups.length} by step 1)`, "")
				lines.push(
					formatTable(
						[breakdownBy, ...steps.map((_, index) => `Step ${index + 1}`), "Conv."],
						groups.map((group) => [
							group.group === "" ? "(none)" : truncate(group.group, 40),
							...group.counts.map((count) => formatNumber(count)),
							fmtPct(group.conversion),
						]),
					),
				)
			}

			lines.push(
				formatNextSteps([
					"`list_product_events` — see which event names exist before adding a step",
					'`add_dashboard_widget panel_type="funnel"` with `display_json.funnel.steps` — pin this funnel to a board',
					breakdownBy === undefined
						? '`query_funnel breakdown_by="utmSource"` — see where the converters came from'
						: `\`search_sessions\` — read the sessions behind a group`,
				]),
			)

			const data: QueryFunnelData = {
				timeRange: { start: st, end: et },
				keyBy,
				windowSeconds,
				steps: stepData,
				conversion,
				...(breakdown !== undefined ? { breakdown } : undefined),
			}
			return { content: createDualContent(lines.join("\n"), { tool: TOOL, data }) }
		}),
	)
}
