import * as React from "react"

import { ChevronDownIcon, type IconComponent, MagnifierIcon, XmarkIcon } from "../icons"
import { Checkbox } from "../ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "../ui/input-group"
import { Label } from "../ui/label"
import { getServiceColor } from "../../lib/colors"
import { cn } from "../../lib/utils"
import { FILTER_SECTION_LABEL } from "./filter-styles"

export interface FilterOption {
	name: string
	count: number
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

	const labelFor = (name: string) => getOptionLabel?.(name) ?? name

	const filteredOptions =
		searchable && searchText
			? options.filter((o) => labelFor(o.name).toLowerCase().includes(searchText.toLowerCase()))
			: options

	const visibleOptions = showAll || searchText ? filteredOptions : filteredOptions.slice(0, maxVisible)
	const hasMore = !searchText && filteredOptions.length > maxVisible

	const toggleOption = (name: string) => {
		if (selected.includes(name)) {
			onChange(selected.filter((s) => s !== name))
		} else {
			onChange([...selected, name])
		}
	}

	const handleOpenChange = (open: boolean) => {
		setIsOpen(open)
		if (!open) {
			setSearchText("")
			setShowAll(false)
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
							"size-3.5 shrink-0 text-muted-foreground/40 transition-[transform,color] group-hover:text-muted-foreground",
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
									<span className="text-xs text-muted-foreground tabular-nums">
										{option.count.toLocaleString()}
									</span>
								</div>
							)
						})
					)}
					{hasMore && (
						<button
							type="button"
							onClick={() => setShowAll(!showAll)}
							className="text-xs text-muted-foreground hover:text-foreground transition-colors"
						>
							{showAll ? "Show less" : `Show ${options.length - maxVisible} more`}
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
