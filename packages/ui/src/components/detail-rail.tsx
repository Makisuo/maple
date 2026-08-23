import type * as React from "react"

import { cn } from "../lib/utils"

/* -------------------------------------------------------------------------------------------------
 * DetailRail — the label/value rail every detail page hangs off its trailing edge.
 *
 * `Group` and `Row` existed as byte-identical private copies in the anomaly
 * sidebar, the issue sidebar and the recommendation route, which is how the
 * investigation page ended up reaching for stacked `Card`s instead and reading
 * like a different product. They live here now.
 *
 * Deliberately *not* the outer container: each page wraps this in its own aside
 * (widths, borders and backgrounds differ, and `PageLayout.RightSidebar` already
 * owns that job on some of them). Only the two repeated pieces are shared.
 * -----------------------------------------------------------------------------------------------*/

function Group({
	label,
	children,
	className,
}: {
	label: string
	children: React.ReactNode
	className?: string
}) {
	return (
		<section
			data-slot="detail-rail-group"
			className={cn(
				"flex flex-col gap-1.5 border-b border-border/40 px-4 py-3.5 last:border-b-0",
				className,
			)}
		>
			<h3 className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</h3>
			<div className="flex flex-col gap-1">{children}</div>
		</section>
	)
}

function Row({
	label,
	/**
	 * Provenance or scope for the value, set under the label in the label's own
	 * column ("Severity / AI triage") — the label column is where "what is this
	 * row" lives, so that is where "and where did it come from" belongs too,
	 * rather than a stray line under the value.
	 */
	hint,
	title,
	children,
	/** Width of the label column. Narrow rails (recommendations) run tighter. */
	labelWidth = "88px",
}: {
	label: string
	hint?: string
	title?: string
	children: React.ReactNode
	labelWidth?: string
}) {
	return (
		<div
			data-slot="detail-rail-row"
			title={title}
			className="grid min-h-8 items-center gap-x-3 py-0.5"
			style={{ gridTemplateColumns: `${labelWidth} 1fr` }}
		>
			<span className="flex min-w-0 flex-col text-xs text-muted-foreground">
				<span className="truncate">{label}</span>
				{hint ? <span className="truncate text-[10px] text-muted-foreground/70">{hint}</span> : null}
			</span>
			<div className="flex min-w-0 items-center justify-end">{children}</div>
		</div>
	)
}

/**
 * Label above a full-width value, for values too long for `Row`'s 88px label
 * column to leave room for — service names, environment lists, anything that
 * truncated at "kafka-consumers-…" when squeezed beside a label. Same label
 * type as `Row`, so a rail can mix the two without a visible seam.
 */
function Field({
	label,
	hint,
	title,
	children,
}: {
	label: string
	hint?: string
	title?: string
	children: React.ReactNode
}) {
	return (
		<div data-slot="detail-rail-field" title={title} className="flex flex-col gap-1 py-1">
			<span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
				<span>{label}</span>
				{hint ? <span className="text-[10px] text-muted-foreground/70">{hint}</span> : null}
			</span>
			<div className="min-w-0">{children}</div>
		</div>
	)
}

/**
 * Monospace metadata row for infra detail pages (node/workload/pod, host
 * metadata) — a denser, divider-separated sibling of `Row`. Renders nothing
 * for absent values so callers can list every candidate field unconditionally.
 */
function MetaRow({ label, value }: { label: string; value: string | null | undefined }) {
	if (!value) return null
	return (
		<div
			data-slot="detail-rail-meta-row"
			className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 last:border-0"
		>
			<span className="font-mono text-[11px] text-muted-foreground">{label}</span>
			<span className="break-all text-right font-mono text-[11px] tabular-nums text-foreground/85">
				{value}
			</span>
		</div>
	)
}

export const DetailRail = { Group, Row, Field, MetaRow }
