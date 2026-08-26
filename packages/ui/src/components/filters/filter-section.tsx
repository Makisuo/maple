import * as React from "react"

import { ChevronDownIcon, type IconComponent, MagnifierIcon, XmarkIcon } from "../icons"
import { Checkbox } from "../ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "../ui/input-group"
import { Label } from "../ui/label"
import { useSectionCollapse } from "../../hooks/use-section-collapse"
import { getServiceColor } from "../../lib/colors"
import { formatNumber } from "../../lib/format"
import { cn } from "../../lib/utils"
import { FILTER_SECTION_LABEL } from "./filter-styles"

export interface FilterOption {
	name: string
	count: number
}

/**
 * Matches rendered while searching. Without a cap, one character in a 200-option facet paints every
 * near-match — which is neither useful nor cheap. Past this the answer is a longer search term.
 */
export const MAX_SEARCH_RESULTS = 50

/** Stable identity for the default `excluded`, so it never churns the option memo. */
const EMPTY: ReadonlyArray<string> = []

export interface VisibleFilterOptions {
	visible: ReadonlyArray<FilterOption>
	/** Whether the collapsed view is hiding options behind "Show N more". */
	hasMore: number
	/** Matches the search cap dropped, so the section can say so instead of looking complete. */
	overflowingMatches: number
}

/**
 * Which options a section actually paints, given what's chosen, typed, and expanded.
 *
 * Chosen options — included *and* excluded — sort first. Facets are ranked by traffic, so a value
 * picked from deep in the list would otherwise vanish behind "Show N more" the moment the counts
 * refresh, leaving no way to undo it from the section it was set in. That matters more for an
 * exclusion than an inclusion: an inclusion is visible in the results, a hidden exclusion is only
 * visible as absence. `Array#sort` is stable, so traffic rank survives inside each group.
 */
export function visibleFilterOptions({
	options,
	selected,
	excluded = [],
	search,
	showAll,
	maxVisible,
	getOptionLabel,
}: {
	options: ReadonlyArray<FilterOption>
	selected: ReadonlyArray<string>
	excluded?: ReadonlyArray<string>
	/** Empty when the section isn't searchable or nothing is typed. */
	search: string
	showAll: boolean
	maxVisible: number
	getOptionLabel?: (name: string) => string
}): VisibleFilterOptions {
	const labelFor = (name: string) => getOptionLabel?.(name) ?? name

	let ordered = options
	if (selected.length > 0 || excluded.length > 0) {
		const chosen = new Set([...selected, ...excluded])
		// A chosen value that carries no traffic in the window is absent from the facet list, and a
		// row that never paints is a filter that cannot be undone where it was set. Synthesize it at
		// zero rather than letting it strand — most visible for an exclusion, whose whole job is to
		// drive a value's count to nothing.
		const present = new Set(options.map((o) => o.name))
		const missing = [...chosen].filter((name) => !present.has(name)).map((name) => ({ name, count: 0 }))
		ordered = [...options, ...missing].sort(
			(a, b) => Number(chosen.has(b.name)) - Number(chosen.has(a.name)),
		)
	}

	if (search === "") {
		return {
			visible: showAll ? ordered : ordered.slice(0, maxVisible),
			hasMore: Math.max(0, ordered.length - maxVisible),
			overflowingMatches: 0,
		}
	}

	const needle = search.toLowerCase()
	const matches = ordered.filter((o) => labelFor(o.name).toLowerCase().includes(needle))
	return {
		visible: matches.slice(0, MAX_SEARCH_RESULTS),
		hasMore: 0,
		overflowingMatches: Math.max(0, matches.length - MAX_SEARCH_RESULTS),
	}
}

interface FilterSectionBaseProps {
	title: string
	options: ReadonlyArray<FilterOption>
	selected: ReadonlyArray<string>
	onChange: (selected: string[]) => void
	defaultOpen?: boolean
	/** Overrides the remembered-collapse key, which defaults to `title`. */
	persistKey?: string
	maxVisible?: number
	colorMap?: Record<string, string>
	/** Option-name → icon, rendered before the label (like colorMap's swatch). */
	getOptionIcon?: (name: string) => IconComponent | undefined
	/**
	 * Option-name → an already-rendered icon node, in the same slot as
	 * `getOptionIcon`. Separate from it rather than a widening of it, because
	 * `IconComponent` is `ComponentType<SVGProps<SVGSVGElement>>` and the icons
	 * that need this are remote `<img>` favicons, which do not honestly satisfy
	 * that type. A section sets one or the other, never both.
	 */
	renderOptionIcon?: (name: string) => React.ReactNode
	/** Option-name → display text, for fixed vocabularies whose URL value differs from its label. */
	getOptionLabel?: (name: string) => string
	/**
	 * Values this facet is filtering *out*. Pass with `onExcludedChange` to turn the section
	 * tri-state; omit both and the section stays include-only, which is what every caller that
	 * has no `excluded*` search param wants.
	 */
	excluded?: ReadonlyArray<string>
	onExcludedChange?: (excluded: string[]) => void
}

interface FilterSectionProps extends FilterSectionBaseProps {}

interface SearchableFilterSectionProps extends FilterSectionBaseProps {}

function FilterSectionBase({
	title,
	options,
	selected,
	onChange,
	defaultOpen = true,
	persistKey,
	maxVisible = 5,
	searchable,
	colorMap,
	getOptionIcon,
	renderOptionIcon,
	getOptionLabel,
	excluded = EMPTY,
	onExcludedChange,
}: FilterSectionBaseProps & { searchable: boolean }) {
	const [isOpen, setIsOpen] = useSectionCollapse(persistKey ?? title, defaultOpen)
	const [showAll, setShowAll] = React.useState(false)
	const [searchText, setSearchText] = React.useState("")
	const inputRef = React.useRef<HTMLInputElement>(null)
	// Deferred so the input paints on the keystroke and the option list trails it. A high-cardinality
	// facet (200 paths) re-filters and re-renders every match otherwise, on every character.
	const deferredSearch = React.useDeferredValue(searchText)

	const labelFor = (name: string) => getOptionLabel?.(name) ?? name

	const {
		visible: visibleOptions,
		hasMore,
		overflowingMatches,
	} = React.useMemo(
		() =>
			visibleFilterOptions({
				options,
				selected,
				excluded,
				search: searchable ? deferredSearch : "",
				showAll,
				maxVisible,
				getOptionLabel,
			}),
		[options, selected, excluded, searchable, deferredSearch, showAll, maxVisible, getOptionLabel],
	)

	// Include and exclude are mutually exclusive per value, enforced here rather than left to each
	// caller: `IN (x) AND NOT IN (x)` is always an empty result and never what anyone meant.
	const toggleOption = (name: string) => {
		if (excluded.includes(name)) onExcludedChange?.(excluded.filter((s) => s !== name))
		if (selected.includes(name)) {
			onChange(selected.filter((s) => s !== name))
		} else {
			onChange([...selected, name])
		}
	}

	const toggleExcluded = (name: string) => {
		if (!onExcludedChange) return
		if (selected.includes(name)) onChange(selected.filter((s) => s !== name))
		if (excluded.includes(name)) {
			onExcludedChange(excluded.filter((s) => s !== name))
		} else {
			onExcludedChange([...excluded, name])
		}
	}

	/**
	 * "Only" is what people reach for when they mean "exclude everything else" — without it a
	 * fifteen-value facet costs fourteen clicks to say one thing.
	 */
	const selectOnly = (name: string) => {
		onChange([name])
		if (excluded.length > 0) onExcludedChange?.([])
	}

	const handleOpenChange = (open: boolean) => {
		setIsOpen(open)
		// Only reset what's actually dirty. Writing these unconditionally re-rendered the panel
		// mid-collapse, and because `searchText` feeds `useDeferredValue` that scheduled a second,
		// transition-priority render that landed while Base UI was animating the measured height.
		if (!open) {
			if (searchText !== "") setSearchText("")
			if (showAll) setShowAll(false)
		}
	}

	// A section with an active exclusion always paints, even when the facet came back empty —
	// otherwise the filter has no home to be undone from.
	if (options.length === 0 && excluded.length === 0 && selected.length === 0) {
		return null
	}

	return (
		<Collapsible open={isOpen} onOpenChange={handleOpenChange}>
			<CollapsibleTrigger
				className={cn(
					"group flex w-full items-center justify-between gap-2 py-2 hover:text-foreground text-muted-foreground transition-colors",
					FILTER_SECTION_LABEL,
				)}
			>
				<span className="truncate">{title}</span>
				<span className="flex items-center gap-1.5">
					{!isOpen && selected.length > 0 && (
						<span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] tabular-nums tracking-normal text-foreground">
							{selected.length}
						</span>
					)}
					{/* Its own badge, not folded into the count above: a collapsed section hiding an
					    exclusion is exactly the state that reads as "my data is missing". */}
					{!isOpen && excluded.length > 0 && (
						<span className="rounded-sm bg-destructive/10 px-1.5 py-0.5 text-[10px] tabular-nums tracking-normal text-destructive">
							−{excluded.length}
						</span>
					)}
					<ChevronDownIcon
						className={cn(
							// Duration matches the panel's 200ms; without it the chevron settles at
							// 150ms and reads as arriving before the section has finished closing.
							"size-3.5 shrink-0 text-muted-foreground/40 transition-[transform,color] duration-200 ease-out group-hover:text-muted-foreground",
							isOpen && "rotate-180",
						)}
					/>
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="pb-3">
				{searchable && (
					<InputGroup className="mb-2">
						<InputGroupAddon>
							<MagnifierIcon />
						</InputGroupAddon>
						<InputGroupInput
							ref={inputRef}
							size="sm"
							value={searchText}
							onChange={(e) => {
								setSearchText(e.target.value)
								setShowAll(false)
							}}
							placeholder={`Search ${title.toLowerCase()}...`}
						/>
						{searchText && (
							<InputGroupAddon align="inline-end">
								<InputGroupButton
									aria-label="Clear search"
									onClick={() => {
										setSearchText("")
										inputRef.current?.focus()
									}}
								>
									<XmarkIcon />
								</InputGroupButton>
							</InputGroupAddon>
						)}
					</InputGroup>
				)}
				<div className="space-y-2">
					{visibleOptions.length === 0 ? (
						<p className="text-xs text-muted-foreground py-1">No matches found</p>
					) : (
						visibleOptions.map((option) => {
							const OptionIcon = getOptionIcon?.(option.name)
							const label = labelFor(option.name)
							const isExcluded = excluded.includes(option.name)
							return (
								<div
									key={option.name}
									className="group/option flex items-center gap-2"
									data-excluded={isExcluded || undefined}
								>
									<Checkbox
										id={`${title}-${option.name}`}
										checked={selected.includes(option.name) || isExcluded}
										indeterminate={isExcluded}
										aria-label={isExcluded ? `${label} — excluded` : undefined}
										className={cn(
											// Tinted rather than filled. The included state is a solid
											// primary block, and an exclusion painted the same weight in
											// red outshouts it — backwards, since excluding is the
											// quieter, subtractive act. Color carries the state; weight
											// stays below the positive one.
											isExcluded &&
												"border-destructive/40 [&_[data-slot=checkbox-indicator]]:bg-destructive/12 [&_[data-slot=checkbox-indicator]]:text-destructive",
										)}
										onCheckedChange={() => toggleOption(option.name)}
									/>
									<Label
										htmlFor={`${title}-${option.name}`}
										className={cn(
											"flex-1 min-w-0 flex items-center gap-1.5 cursor-pointer text-xs font-normal",
											// Struck through as well as dimmed, so the state survives a
											// colorblind reading. The rule is neutral and hairline: a
											// red one across grey text is a second color signal in the
											// same row as the box, and it lands right where the word
											// needs to stay readable.
											isExcluded
												? "text-muted-foreground/70 line-through decoration-1 decoration-muted-foreground/50"
												: "text-foreground",
										)}
										title={isExcluded ? `${label} (excluded)` : label}
										// The power path, on the label rather than the row so it hangs
										// off something already interactive. A plain click stays
										// include-only on purpose: a checkbox that cycles into a third
										// state on every click is a well-known way to leave people
										// filtering out data they never meant to.
										onClick={(e) => {
											if (!onExcludedChange || !e.altKey) return
											e.preventDefault()
											toggleExcluded(option.name)
										}}
									>
										{colorMap?.[option.name] && (
											<span
												className={cn(
													"size-2.5 rounded-[35%] [corner-shape:squircle] shrink-0",
													// A full-strength swatch next to a struck, dimmed
													// label reads as the row still being live.
													isExcluded && "opacity-40",
												)}
												style={{ backgroundColor: colorMap[option.name] }}
											/>
										)}
										{OptionIcon ? (
											<OptionIcon
												className={cn(
													"size-3.5 shrink-0",
													isExcluded && "opacity-40",
												)}
											/>
										) : (
											renderOptionIcon?.(option.name)
										)}
										<span className="truncate">{label}</span>
									</Label>
									{/* Count and actions share one slot — the sidebar has no room for
									    both, and the count is the thing you stop needing the moment
									    you have decided to act on the row. The actions stay mounted
									    and merely transparent so Tab can still reach them; revealing
									    them on hover alone would put exclusion out of keyboard reach
									    entirely. */}
									<span className="relative flex shrink-0 items-center justify-end">
										<span
											className={cn(
												"text-xs text-muted-foreground tabular-nums transition-opacity",
												onExcludedChange &&
													"group-hover/option:opacity-0 group-focus-within/option:opacity-0",
											)}
											title={option.count.toLocaleString()}
										>
											{formatNumber(option.count)}
										</span>
										{onExcludedChange && (
											<span className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1 opacity-0 transition-opacity group-hover/option:pointer-events-auto group-hover/option:opacity-100 group-focus-within/option:pointer-events-auto group-focus-within/option:opacity-100">
												<FilterRowAction
													onClick={() => selectOnly(option.name)}
													label={`Show only ${label}`}
												>
													Only
												</FilterRowAction>
												{/* A toggle, not two verbs: "Exclude" lit means the row
												    is excluded and pressing it again undoes that. */}
												<FilterRowAction
													onClick={() => toggleExcluded(option.name)}
													label={
														isExcluded
															? `Stop excluding ${label}`
															: `Exclude ${label}`
													}
													pressed={isExcluded}
												>
													Exclude
												</FilterRowAction>
											</span>
										)}
									</span>
								</div>
							)
						})
					)}
					{overflowingMatches > 0 && (
						<p className="text-xs text-muted-foreground py-1">
							{overflowingMatches.toLocaleString()} more match
							{overflowingMatches === 1 ? "" : "es"} — keep typing to narrow
						</p>
					)}
					{hasMore > 0 && (
						<button
							type="button"
							onClick={() => setShowAll(!showAll)}
							className="text-xs text-muted-foreground hover:text-foreground transition-colors"
						>
							{showAll ? "Show less" : `Show ${hasMore} more`}
						</button>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}

interface FilterRowActionProps {
	onClick: () => void
	/** Full sentence for assistive tech; the visible text is only two words wide. */
	label: string
	pressed?: boolean
	children: React.ReactNode
}

/**
 * The per-row hover verb. Text rather than a glyph: every icon for "exclude" (ban, slash, minus,
 * crossed eye) reads as something else to someone, and the word costs about the same width as the
 * count it replaces.
 */
function FilterRowAction({ onClick, label, pressed, children }: FilterRowActionProps) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			aria-pressed={pressed}
			onClick={onClick}
			className={cn(
				"rounded-sm px-1 py-0.5 text-[10px] uppercase tracking-[0.06em] transition-colors",
				pressed
					? "bg-destructive/12 text-destructive hover:bg-destructive/20"
					: "text-muted-foreground hover:bg-muted hover:text-foreground",
			)}
		>
			{children}
		</button>
	)
}

/** Option-name → deterministic service color, for Service facets' swatches. */
export function serviceColorMap(options: ReadonlyArray<FilterOption>): Record<string, string> {
	return Object.fromEntries(options.map((o) => [o.name, getServiceColor(o.name)]))
}

export function FilterSection(props: FilterSectionProps) {
	return <FilterSectionBase {...props} searchable={false} />
}

export function SearchableFilterSection(props: SearchableFilterSectionProps) {
	return <FilterSectionBase {...props} searchable />
}

interface SingleCheckboxFilterProps {
	title: string
	checked: boolean
	onChange: (checked: boolean) => void
	count?: number
}

export function SingleCheckboxFilter({ title, checked, onChange, count }: SingleCheckboxFilterProps) {
	return (
		<div className="flex items-center gap-2 py-1.5">
			<Checkbox
				id={`filter-${title}`}
				checked={checked}
				onCheckedChange={(val) => onChange(val === true)}
			/>
			<Label
				htmlFor={`filter-${title}`}
				className="flex-1 min-w-0 truncate cursor-pointer text-xs text-foreground font-normal"
				title={title}
			>
				{title}
			</Label>
			{count !== undefined && (
				<span className="text-xs text-muted-foreground tabular-nums">{count.toLocaleString()}</span>
			)}
		</div>
	)
}
