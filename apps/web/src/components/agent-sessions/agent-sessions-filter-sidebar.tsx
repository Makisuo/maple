import { getRouteApi } from "@tanstack/react-router"

import { Result } from "@/lib/effect-atom"
import {
	FilterSection,
	SearchableFilterSection,
	SingleCheckboxFilter,
	type FilterOption,
} from "@/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import { RangeFilterSection, type RangePreset } from "@maple/ui/components/filters/range-filter-section"
import { Separator } from "@maple/ui/components/ui/separator"
import { vendorIcon } from "@/lib/agent-sessions/vendor-icon"
import { vendorLabel } from "@/lib/agent-sessions/vendor-label"
import { shortTarget } from "@/lib/agent-sessions/span-filters"
import {
	AGENT_SESSIONS_FILTER_KEYS,
	hasAgentSessionsFilters,
	type AgentSessionsSearchState,
} from "./agent-sessions-filter-inputs"

const routeApi = getRouteApi("/agent-sessions/")

/** Selected values absent from the current window stay checkable (count 0). */
function withSelected(
	options: ReadonlyArray<FilterOption>,
	selected: ReadonlyArray<string> = [],
): FilterOption[] {
	const missing = selected.filter((value) => !options.some((option) => option.name === value))
	return [...missing.map((name) => ({ name, count: 0 })), ...options]
}

// No distribution behind these — a histogram would need the fan-out for every
// session in the window, which the facets read is built to avoid. Static
// thresholds, named for the question each one answers.
const DURATION_PRESETS: RangePreset[] = [
	{ key: "quick", label: "Quick", value: "<10s", max: 10 },
	{ key: "minute", label: "Over a minute", value: ">1m", min: 60 },
	{ key: "long", label: "Long-running", value: ">10m", min: 600 },
]
const COST_PRESETS: RangePreset[] = [
	{ key: "dime", label: "Over 10¢", value: ">$0.10", min: 0.1 },
	{ key: "dollar", label: "Over $1", value: ">$1", min: 1 },
]
const TOKEN_PRESETS: RangePreset[] = [
	{ key: "100k", label: "Over 100k", min: 100_000 },
	{ key: "1m", label: "Over 1M", min: 1_000_000 },
]
const LLM_CALL_PRESETS: RangePreset[] = [
	{ key: "single", label: "Single call", value: "1", min: 1, max: 1 },
	{ key: "loop", label: "Over 10", min: 10 },
	{ key: "deep", label: "Over 50", min: 50 },
]
const TOOL_CALL_PRESETS: RangePreset[] = [
	{ key: "none", label: "No tools", value: "0", max: 0 },
	{ key: "many", label: "Over 10", min: 10 },
]

type ListKey = "vendors" | "services" | "environments" | "models" | "agents" | "tools"
type RangeKey =
	| "durationMin"
	| "durationMax"
	| "costMin"
	| "costMax"
	| "tokensMin"
	| "tokensMax"
	| "llmCallsMin"
	| "llmCallsMax"
	| "toolCallsMin"
	| "toolCallsMax"

interface AgentSessionsFilterSidebarProps {
	/**
	 * Distinct sessions per option, aggregated over the whole window rather than
	 * over the page of rows the list returned. Deliberately unfiltered, so
	 * selecting one option leaves the others visible and countable.
	 */
	facetsResult: Result.Result<
		{
			readonly vendors: ReadonlyArray<FilterOption>
			readonly services: ReadonlyArray<FilterOption>
			readonly environments: ReadonlyArray<FilterOption>
			readonly models: ReadonlyArray<FilterOption>
			readonly agents: ReadonlyArray<FilterOption>
			readonly tools: ReadonlyArray<FilterOption>
		},
		unknown
	>
}

export function AgentSessionsFilterSidebar({ facetsResult }: AgentSessionsFilterSidebarProps) {
	const navigate = routeApi.useNavigate()
	const search: AgentSessionsSearchState = routeApi.useSearch()

	const setList = (key: ListKey, values: string[]) => {
		navigate({ search: (prev) => ({ ...prev, [key]: values.length > 0 ? values : undefined }) })
	}

	const setRange =
		(minKey: RangeKey, maxKey: RangeKey) => (min: number | undefined, max: number | undefined) => {
			navigate({ search: (prev) => ({ ...prev, [minKey]: min, [maxKey]: max }) })
		}

	// Everything the sidebar and the toolbar own; the sort stays.
	const clearAllFilters = () => {
		navigate({
			search: (prev) => ({
				...prev,
				...Object.fromEntries(AGENT_SESSIONS_FILTER_KEYS.map((key) => [key, undefined])),
			}),
		})
	}

	return Result.builder(facetsResult)
		.onInitial(() => <FilterSidebarLoading sectionCount={4} />)
		.onError((error) => <FilterSidebarError error={error} />)
		.onSuccess((value, result) => {
			const vendors = withSelected(value.vendors, search.vendors)
			const services = withSelected(value.services, search.services)
			const environments = withSelected(value.environments, search.environments)
			const models = withSelected(value.models, search.models)
			const agents = withSelected(value.agents, search.agents)
			const tools = withSelected(value.tools, search.tools)

			return (
				<FilterSidebarFrame waiting={result.waiting}>
					<FilterSidebarHeader
						canClear={hasAgentSessionsFilters(search)}
						onClear={clearAllFilters}
					/>
					<FilterSidebarBody>
						{/* Counted facets first — they answer "what is in here" before you
						    know anything. The measured ranges follow, then the one structural
						    toggle. "With errors" is deliberately absent: the toolbar chip is
						    that filter, and two controls for one boolean read as a question
						    about whether they agree. */}
						<FilterSection
							title="Framework"
							options={vendors}
							selected={search.vendors ?? []}
							onChange={(vals) => setList("vendors", vals)}
							getOptionLabel={vendorLabel}
							getOptionIcon={vendorIcon}
						/>

						<SearchableFilterSection
							title="Service"
							options={services}
							selected={search.services ?? []}
							onChange={(vals) => setList("services", vals)}
						/>

						{/* Sections with nothing to offer hide themselves: most orgs never
						    set an environment, and a framework that names no agents or tools
						    would leave an empty list that reads as broken. */}
						{environments.length > 0 && (
							<FilterSection
								title="Environment"
								options={environments}
								selected={search.environments ?? []}
								onChange={(vals) => setList("environments", vals)}
							/>
						)}

						{models.length > 0 && (
							<SearchableFilterSection
								title="Model"
								options={models}
								selected={search.models ?? []}
								onChange={(vals) => setList("models", vals)}
								getOptionLabel={shortTarget}
							/>
						)}

						{agents.length > 0 && (
							<SearchableFilterSection
								title="Agent"
								options={agents}
								selected={search.agents ?? []}
								onChange={(vals) => setList("agents", vals)}
							/>
						)}

						{tools.length > 0 && (
							<SearchableFilterSection
								title="Tool"
								options={tools}
								selected={search.tools ?? []}
								onChange={(vals) => setList("tools", vals)}
							/>
						)}

						<Separator className="my-2" />

						<RangeFilterSection
							title="Session length"
							unit="s"
							minValue={search.durationMin}
							maxValue={search.durationMax}
							onRangeChange={setRange("durationMin", "durationMax")}
							presets={DURATION_PRESETS}
							defaultOpen={false}
						/>

						<RangeFilterSection
							title="Cost"
							hint="As priced by the instrumentation"
							unit="usd"
							minValue={search.costMin}
							maxValue={search.costMax}
							onRangeChange={setRange("costMin", "costMax")}
							presets={COST_PRESETS}
							defaultOpen={false}
						/>

						<RangeFilterSection
							title="Tokens"
							unit="count"
							minValue={search.tokensMin}
							maxValue={search.tokensMax}
							onRangeChange={setRange("tokensMin", "tokensMax")}
							presets={TOKEN_PRESETS}
							defaultOpen={false}
						/>

						<RangeFilterSection
							title="LLM calls"
							unit="count"
							minValue={search.llmCallsMin}
							maxValue={search.llmCallsMax}
							onRangeChange={setRange("llmCallsMin", "llmCallsMax")}
							presets={LLM_CALL_PRESETS}
							defaultOpen={false}
						/>

						<RangeFilterSection
							title="Tool calls"
							unit="count"
							minValue={search.toolCallsMin}
							maxValue={search.toolCallsMax}
							onRangeChange={setRange("toolCallsMin", "toolCallsMax")}
							presets={TOOL_CALL_PRESETS}
							defaultOpen={false}
						/>

						<Separator className="my-2" />

						{/* A framework with no session key files every trace as its own
						    session; for an org running one of those this is the difference
						    between a list of conversations and a list of requests. */}
						<SingleCheckboxFilter
							title="Hide single-trace sessions"
							checked={search.grouped === true}
							onChange={(checked) =>
								navigate({ search: (prev) => ({ ...prev, grouped: checked || undefined }) })
							}
						/>

						{vendors.length === 0 && services.length === 0 && (
							<p className="py-4 text-sm text-muted-foreground">
								No sessions in the last 7 days
							</p>
						)}
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}
