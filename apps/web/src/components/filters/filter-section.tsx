import * as React from "react"
import { ChevronDownIcon, XmarkIcon, MagnifierIcon, type IconComponent } from "@/components/icons"

import { cn } from "@maple/ui/utils"
import { getServiceColor } from "@maple/ui/colors"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Label } from "@maple/ui/components/ui/label"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"

export interface FilterOption {
	name: string
	count: number
}

interface FilterSectionBaseProps {
	title: string
	options: ReadonlyArray<FilterOption>
	selected: string[]
	onChange: (selected: string[]) => void
	defaultOpen?: boolean
	maxVisible?: number
	colorMap?: Record<string, string>
	/** Option-name → icon, rendered before the label (like colorMap's swatch). */
	getOptionIcon?: (name: string) => IconComponent | undefined
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
}: FilterSectionBaseProps & { searchable: boolean }) {
	const [isOpen, setIsOpen] = React.useState(defaultOpen)
	const [showAll, setShowAll] = React.useState(false)
	const [searchText, setSearchText] = React.useState("")
	const inputRef = React.useRef<HTMLInputElement>(null)

	const filteredOptions =
		searchable && searchText
			? options.filter((o) => o.name.toLowerCase().includes(searchText.toLowerCase()))
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
			<CollapsibleTrigger className="flex w-full items-center justify-between py-2 text-sm font-medium hover:text-foreground text-muted-foreground transition-colors">
				<span>{title}</span>
				<ChevronDownIcon className={cn("size-4 transition-transform", isOpen && "rotate-180")} />
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
										title={option.name}
									>
										{colorMap?.[option.name] && (
											<span
												className="size-2.5 rounded-[35%] [corner-shape:squircle] shrink-0"
												style={{ backgroundColor: colorMap[option.name] }}
											/>
										)}
										{OptionIcon && <OptionIcon className="size-3.5 shrink-0" />}
										<span className="truncate">{option.name}</span>
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
							className="text-xs text-primary hover:underline"
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
		<div className="flex items-center gap-2 py-2">
			<Checkbox
				id={`filter-${title}`}
				checked={checked}
				onCheckedChange={(val) => onChange(val === true)}
			/>
			<Label
				htmlFor={`filter-${title}`}
				className="flex-1 min-w-0 truncate cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
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
