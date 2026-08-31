import type { ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"

/**
 * The secondary identity line under a resource's name.
 *
 * Two bugs it exists to remove, both of which were copy-pasted into the pod,
 * host, container and workload tables:
 *
 *  1. **The dangling separator.** Each item rendered its own LEADING `·`, so a
 *     wrap put that separator at the end of the previous line — a row reading
 *     "ns default · deploy prd-debezium ·" with nothing after the dot.
 *     Separators are interposed here instead, so there is exactly one between
 *     two items and never one at an edge.
 *  2. **The three-line row.** `flex-wrap` let a long node name push the line to
 *     two or three rows, so a table of pods had rows of varying height and the
 *     numeric columns stopped lining up with anything. This truncates as one
 *     line: the name is the identity, the rest is context, and context that
 *     costs you a legible table is not worth its pixels. The full text stays
 *     available through `title`.
 *
 * Absent items are dropped before separators are placed, which is what makes an
 * absent namespace leave no trace. "Absent" includes the EMPTY STRING: the call
 * sites guard with `value && \`ns ${value}\``, and `"" && x` evaluates to `""`,
 * not to `false` — so a host with no arch was rendering "linux · ·".
 */

export type MetaItem = ReactNode | null | undefined | false

export function MetaLine({
	items,
	title,
	className,
}: {
	items: ReadonlyArray<MetaItem>
	/** Plain-text fallback for the truncated line. */
	title?: string
	className?: string
}) {
	const present = items.filter(
		(item): item is ReactNode => item !== null && item !== undefined && item !== false && item !== "",
	)
	if (present.length === 0) return null

	return (
		<div
			className={cn(
				"mt-1 flex min-w-0 items-center gap-x-2 truncate font-mono text-[11px] text-muted-foreground/80",
				className,
			)}
			title={title}
		>
			{present.map((item, index) => (
				// Index keys: these are positional fragments of one line, not a
				// reorderable list.
				<span key={index} className="flex shrink-0 items-center gap-x-2">
					{index > 0 && <span className="text-foreground/20">·</span>}
					{item}
				</span>
			))}
		</div>
	)
}
