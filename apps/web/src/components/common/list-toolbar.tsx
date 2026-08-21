import { cn } from "@maple/ui/lib/utils"

interface ListToolbarTab<T extends string> {
	value: T
	label: string
	count?: number
}

export interface ListToolbarProps<T extends string> {
	tabs: ReadonlyArray<ListToolbarTab<T>>
	active: T
	onChange: (value: T) => void
	/** What the tabs filter, for the tablist's accessible name. */
	label: string
	totalCount?: number
	/** Singular/plural noun for the count readout. */
	countNoun?: readonly [string, string]
	/** Replaces the computed count readout when the page can't state a total. */
	countLabel?: React.ReactNode
	/** Extra controls rendered right-aligned, before the count readout. */
	trailing?: React.ReactNode
}

export function ListToolbar<T extends string>({
	tabs,
	active,
	onChange,
	label,
	totalCount,
	countNoun = ["item", "items"],
	countLabel,
	trailing,
}: ListToolbarProps<T>) {
	return (
		<div className="flex flex-wrap items-center gap-2 gap-y-1.5 border-b border-border/60 px-2 py-1.5">
			<div role="tablist" aria-label={label} className="flex flex-wrap items-center gap-0.5">
				{tabs.map((tab) => {
					const isActive = active === tab.value
					return (
						<button
							key={tab.value}
							type="button"
							role="tab"
							aria-selected={isActive}
							onClick={() => onChange(tab.value)}
							className={cn(
								"inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
								isActive
									? "bg-muted text-foreground"
									: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
							)}
						>
							{tab.label}
							{tab.count !== undefined ? (
								<span
									className={cn(
										"tabular-nums",
										isActive ? "text-muted-foreground" : "text-muted-foreground/70",
									)}
								>
									{tab.count}
								</span>
							) : null}
						</button>
					)
				})}
			</div>
			<div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
				{trailing}
				{countLabel !== undefined ? (
					<span className="text-xs text-muted-foreground tabular-nums">{countLabel}</span>
				) : totalCount !== undefined ? (
					<span className="text-xs text-muted-foreground tabular-nums">
						{totalCount} {totalCount === 1 ? countNoun[0] : countNoun[1]}
					</span>
				) : null}
			</div>
		</div>
	)
}
