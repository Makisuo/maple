import { cn } from "@maple/ui/lib/utils"

export interface IssuesToolbarTab<T extends string> {
	value: T
	label: string
	count?: number
}

export interface IssuesToolbarProps<T extends string> {
	tabs: ReadonlyArray<IssuesToolbarTab<T>>
	active: T
	onChange: (value: T) => void
	totalCount?: number
}

export function IssuesToolbar<T extends string>({
	tabs,
	active,
	onChange,
	totalCount,
}: IssuesToolbarProps<T>) {
	return (
		<div className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
			<div role="tablist" aria-label="Filter issues" className="flex items-center gap-0.5">
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
			{totalCount !== undefined ? (
				<span className="ml-auto text-xs text-muted-foreground tabular-nums">
					{totalCount} {totalCount === 1 ? "issue" : "issues"}
				</span>
			) : null}
		</div>
	)
}
