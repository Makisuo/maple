import * as React from "react"

import { ChevronDownIcon, type IconComponent, MagnifierIcon, XmarkIcon } from "../icons"
import { Checkbox } from "../ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "../ui/input-group"
import { Label } from "../ui/label"
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

export interface VisibleFilterOptions {
	visible: ReadonlyArray<FilterOption>
	/** Whether the collapsed view is hiding options behind "Show N more". */
	hasMore: number
	/** Matches the search cap dropped, so the section can say so instead of looking complete. */
	overflowingMatches: number
}

/**
 * Which options a section actually paints, given what's selected, typed, and expanded.
 *
 * Selected options sort first. Facets are ranked by traffic, so a value chosen from deep in the list
 * would otherwise vanish behind "Show N more" the moment the counts refresh — leaving no way to
 * untick it from the section it was ticked in. `Array#sort` is stable, so traffic rank survives
 * inside each group.
 */
export function visibleFilterOptions({
	options,
	selected,
	search,
	showAll,
	maxVisible,
	getOptionLabel,
}: {
	options: ReadonlyArray<FilterOption>
	selected: ReadonlyArray<string>
	/** Empty when the section isn't searchable or nothing is typed. */
	search: string
	showAll: boolean
	maxVisible: number
	getOptionLabel?: (name: string) => string
}): VisibleFilterOptions {
	const labelFor = (name: string) => getOptionLabel?.(name) ?? name

	let ordered = options
	if (selected.length > 0) {
		const chosen = new Set(selected)
		ordered = [...options].sort((a, b) => Number(chosen.has(b.name)) - Number(chosen.has(a.name)))
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
	maxVisible?: number
	colorMap?: Record<string, string>
	/** Option-name → icon, rendered before the label (like colorMap's swatch). */
	getOptionIcon?: (name: string) => IconComponent | undefined
	/** Option-name → display text, for fixed vocabularies whose URL value differs from its label. */
	getOptionLabel?: (name: string) => string
}

interface FilterSectionProps extends FilterSectionBaseProps {}

interface SearchableFilterSectionProps extends FilterSectionBaseProps {}

function FilterSectionBase({
	title,
	options,
	selected,
	onChange,
	defaultOpen = true,
	maxVisible = 5,
	searchable,
	colorMap,
	getOptionIcon,
	getOptionLabel,
}: FilterSectionBaseProps & { searchable: boolean }) {
	const [isOpen, setIsOpen] = React.useState(defaultOpen)
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
				search: searchable ? deferredSearch : "",
				showAll,
				maxVisible,
				getOptionLabel,
			}),
		[options, selected, searchable, deferredSearch, showAll, maxVisible, getOptionLabel],
	)

	const toggleOption = (name: string) => {
		if (selected.includes(name)) {
			onChange(selected.filter((s) => s !== name))
		} else {
			onChange([...selected, name])
		}
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

	if (options.length === 0) {
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
							return (
								<div key={option.name} className="flex items-center gap-2">
									<Checkbox
										id={`${title}-${option.name}`}
										checked={selected.includes(option.name)}
										onCheckedChange={() => toggleOption(option.name)}
									/>
									<Label
										htmlFor={`${title}-${option.name}`}
										className="flex-1 min-w-0 flex items-center gap-1.5 cursor-pointer text-xs text-foreground font-normal"
										title={labelFor(option.name)}
									>
										{colorMap?.[option.name] && (
											<span
												className="size-2.5 rounded-[35%] [corner-shape:squircle] shrink-0"
												style={{ backgroundColor: colorMap[option.name] }}
											/>
										)}
										{OptionIcon && <OptionIcon className="size-3.5 shrink-0" />}
										<span className="truncate">{labelFor(option.name)}</span>
									</Label>
									<span
										className="text-xs text-muted-foreground tabular-nums"
										title={option.count.toLocaleString()}
									>
										{formatNumber(option.count)}
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
