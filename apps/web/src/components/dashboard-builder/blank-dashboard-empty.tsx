import { Link } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"

import { ChartBarIcon, ChartBarTrendUpIcon, PlusIcon, TextWrapIcon } from "@/components/icons"

/**
 * The board's own shape, drawn small: three dashed tiles in the same proportions
 * a real row lands in, so the empty state reads as "your grid, unfilled" rather
 * than as a generic illustration. Aria-hidden — every word it carries is already
 * in the copy below it.
 */
function GridPreview() {
	const tiles = [
		{ Glyph: ChartBarTrendUpIcon, className: "h-16 grow" },
		{ Glyph: ChartBarIcon, className: "h-16 w-16" },
		{ Glyph: TextWrapIcon, className: "h-16 w-10" },
	]

	return (
		<div aria-hidden className="flex w-64 gap-2">
			{tiles.map(({ Glyph, className }, index) => (
				<div
					key={index}
					className={`${className} flex items-center justify-center rounded-md border border-dashed border-border bg-card/40`}
				>
					<Glyph size={16} className="text-muted-foreground/50" />
				</div>
			))}
		</div>
	)
}

/**
 * A dashboard that exists but holds nothing. Distinct from the *list's* empty
 * state: the board is already created and named, so the only question left is
 * what goes on it.
 */
export function BlankDashboardEmpty({
	readOnly,
	onAddWidget,
}: {
	readOnly: boolean
	onAddWidget: () => void
}) {
	return (
		<Empty className="py-16">
			<EmptyMedia>
				<GridPreview />
			</EmptyMedia>

			<EmptyHeader>
				<EmptyTitle>Nothing on this board yet</EmptyTitle>
				<EmptyDescription>
					Widgets read from the traces, logs, metrics and errors you already send — charts, single
					stats, tables and markdown notes.
				</EmptyDescription>
			</EmptyHeader>

			<EmptyContent className="max-w-none">
				<div className="flex flex-wrap items-center justify-center gap-2">
					<Button size="sm" onClick={onAddWidget} disabled={readOnly}>
						<PlusIcon size={14} />
						Add your first widget
					</Button>
					<Button
						size="sm"
						variant="outline"
						render={<Link to="/dashboards/templates" search={{}} />}
					>
						Start from a template
					</Button>
				</div>
				{/* Templates instantiate into a *new* board, so say so here rather than
				    letting the button read as "fill this one in for me". */}
				<p className="text-muted-foreground font-mono text-[11px]">
					{readOnly
						? "Read-only — you can’t add widgets to this dashboard."
						: "Templates create a new dashboard from this org’s data."}
				</p>
			</EmptyContent>
		</Empty>
	)
}
