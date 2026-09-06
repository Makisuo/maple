import { ToolbarSearch, ToolbarStat } from "@maple/ui/components/toolbar"
import { StopwatchIcon } from "@maple/ui/components/icons"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Switch } from "@maple/ui/components/ui/switch"
import { cn } from "@maple/ui/lib/utils"
import {
	CreditCardIcon,
	GearIcon,
	HistoryIcon,
	LayersIcon,
	PixelSparkleIcon,
	PixelTriangleWarningIcon,
	type IconComponent,
} from "@/components/icons"
import { CATEGORY_TEXT } from "./session-detail/span-visuals"
import {
	AGENT_SESSIONS_SORT_OPTIONS,
	DEFAULT_SORT_OPTION,
	type AgentSessionsSortOption,
} from "./agent-sessions-filter-inputs"

/**
 * Each sort's glyph and hue: the measure the list is ordered by reads at a
 * glance, and in the same colours the rows draw that measure in — calls and
 * tools from the session page's vocabulary, errors in the destructive tone,
 * time in the neutral.
 */
const SORT_VISUALS = {
	newest: { icon: HistoryIcon, tone: "text-muted-foreground" },
	oldest: { icon: HistoryIcon, tone: "text-muted-foreground" },
	longest: { icon: StopwatchIcon, tone: "text-chart-1" },
	cost: { icon: CreditCardIcon, tone: "text-chart-3" },
	tokens: { icon: LayersIcon, tone: "text-chart-5" },
	errors: { icon: PixelTriangleWarningIcon, tone: "text-destructive" },
	"llm-calls": { icon: PixelSparkleIcon, tone: CATEGORY_TEXT.inference },
	"tool-calls": { icon: GearIcon, tone: CATEGORY_TEXT.tool },
} satisfies Record<string, { icon: IconComponent; tone: string }>

function SortLabel({ option }: { option: AgentSessionsSortOption }) {
	const { icon: Icon, tone } = SORT_VISUALS[option.key as keyof typeof SORT_VISUALS] ?? SORT_VISUALS.newest
	return (
		<span className="inline-flex items-center gap-2">
			<Icon size={14} className={cn("shrink-0", tone)} aria-hidden />
			{option.label}
		</span>
	)
}

interface AgentSessionsToolbarProps {
	/** Current `q` search param (session / trace id prefix). */
	query: string
	onSearch: (value: string | undefined) => void
	/** `hasErrors` URL filter state — the switch toggles it. */
	errorsOnly: boolean
	onToggleErrorsOnly: () => void
	sortKey: string
	onSortChange: (option: AgentSessionsSortOption) => void
	/** Sessions loaded so far, for the count beside the controls. */
	sessionCount: number
	/** Dim the controls while the list is refetching. */
	waiting?: boolean
}

/**
 * Search, the loaded count, the one-click error triage switch, and the sort.
 * This row answers "which of these first".
 */
export function AgentSessionsToolbar({
	query,
	onSearch,
	errorsOnly,
	onToggleErrorsOnly,
	sortKey,
	onSortChange,
	sessionCount,
	waiting = false,
}: AgentSessionsToolbarProps) {
	const sortOption =
		AGENT_SESSIONS_SORT_OPTIONS.find((option) => option.key === sortKey) ?? DEFAULT_SORT_OPTION
	return (
		// Bare container rather than the shared `Toolbar`: this sits inside
		// `DashboardLayout.Sticky`, which already supplies the border and padding.
		<div className="flex flex-wrap items-center justify-between gap-3">
			<ToolbarSearch
				query={query}
				onSearch={onSearch}
				placeholder="Session or trace ID…"
				className="w-full sm:max-w-sm"
			/>

			<div
				className={cn(
					"flex flex-wrap items-center gap-4 transition-opacity",
					waiting && "opacity-60",
				)}
			>
				<div className="hidden sm:block">
					<ToolbarStat value={sessionCount} label="sessions" />
				</div>

				{/* A switch, not a chip: it is a filter that is on or off, and a
				    chip in the destructive tone read as a warning about the list. */}
				<label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium">
					<Switch
						checked={errorsOnly}
						onCheckedChange={onToggleErrorsOnly}
						className="[--thumb-size:--spacing(3.5)] data-checked:bg-destructive sm:[--thumb-size:--spacing(3.5)]"
					/>
					With errors
				</label>

				<Select
					value={sortKey}
					onValueChange={(value) => {
						const option = AGENT_SESSIONS_SORT_OPTIONS.find(
							(candidate) => candidate.key === value,
						)
						if (option) onSortChange(option)
					}}
				>
					<SelectTrigger size="sm" className="h-7 w-44 text-xs" aria-label="Sort sessions">
						<SelectValue>
							<SortLabel option={sortOption} />
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{AGENT_SESSIONS_SORT_OPTIONS.map((option) => (
							<SelectItem key={option.key} value={option.key}>
								<SortLabel option={option} />
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		</div>
	)
}
