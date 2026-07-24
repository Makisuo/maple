import type { ReactNode } from "react"

import { ScrollArea } from "../ui/scroll-area"
import { Separator } from "../ui/separator"
import { Skeleton } from "../ui/skeleton"
import { cn } from "../../lib/utils"

interface FilterSidebarFrameProps {
	children: ReactNode
	waiting?: boolean
	className?: string
}

export function FilterSidebarFrame({ children, waiting = false, className }: FilterSidebarFrameProps) {
	// Width is owned by the container (e.g. the web app's PageLayout.FilterSidebar: an inline aside
	// on desktop, a sheet below lg). Setting one here would fight it — callers that own their own
	// layout (local mode) pass a width via className instead.
	return (
		<div className={cn("flex h-full w-full flex-col", waiting && "opacity-60", className)}>
			{children}
		</div>
	)
}

interface FilterSidebarHeaderProps {
	title?: string
	canClear?: boolean
	onClear?: () => void
}

export function FilterSidebarHeader({
	title = "Filters",
	canClear = false,
	onClear,
}: FilterSidebarHeaderProps) {
	return (
		<div className="flex items-center justify-between py-2">
			<h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{title}</h3>
			{canClear && onClear && (
				<button
					type="button"
					onClick={onClear}
					className="text-xs text-muted-foreground hover:text-foreground"
				>
					Clear all
				</button>
			)}
		</div>
	)
}

export function FilterSidebarBody({ children }: { children: ReactNode }) {
	return (
		<>
			<Separator className="my-2" />
			<div className="relative min-h-0 flex-1">
				<ScrollArea className="h-full">
					<div className="space-y-1 pr-4 pb-6">{children}</div>
				</ScrollArea>
				<div
					aria-hidden
					className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent"
				/>
			</div>
		</>
	)
}

interface FilterSidebarLoadingProps {
	sectionCount?: number
}

export function FilterSidebarLoading({ sectionCount = 3 }: FilterSidebarLoadingProps) {
	return (
		<FilterSidebarFrame>
			<div className="flex items-center justify-between py-2">
				<Skeleton className="h-5 w-16" />
			</div>
			<Separator className="my-2" />
			<div className="space-y-4">
				{Array.from({ length: sectionCount }).map((_, i) => (
					<div key={i} className="space-y-2">
						<Skeleton className="h-4 w-24" />
						<Skeleton className="h-4 w-full" />
						<Skeleton className="h-4 w-full" />
						<Skeleton className="h-4 w-3/4" />
					</div>
				))}
			</div>
		</FilterSidebarFrame>
	)
}
