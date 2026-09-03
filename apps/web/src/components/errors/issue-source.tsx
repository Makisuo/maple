import type { IssueKind } from "@maple/domain/http"

import { KIND_LABEL } from "@/lib/errors/error-filter-chips"

/**
 * What opened an issue, as a colour and a sentence.
 *
 * The column is `kind`, which as a word explains nothing. Every row in the list
 * is an issue in the same workflow; this is only about where it came from, and
 * the three sources get a hue each so the sidebar swatch, the legend and any
 * later badge agree without a lookup.
 *
 * Hues stay clear of the severity scale (red, orange, amber, sky): a source
 * swatch beside a severity dot must never read as a fifth level.
 */
export const SOURCES: ReadonlyArray<IssueKind> = ["error", "alert", "integration"]

export const SOURCE_COLOR = {
	error: "var(--color-rose-500)",
	alert: "var(--color-violet-500)",
	integration: "var(--color-teal-500)",
} satisfies Record<IssueKind, string>

export const SOURCE_DESCRIPTION = {
	error: "Fingerprinted errors from spans. Nearly every row.",
	alert: "Opened by an alert rule, one per rule and group, named after the rule.",
	integration: "Raised by a connected system, such as a PlanetScale event.",
} satisfies Record<IssueKind, string>

/** The Source section's tooltip: one line per source, swatch first. */
export function SourceLegend() {
	return (
		<div className="space-y-2 p-1 text-left">
			<p className="text-muted-foreground">What opened the issue.</p>
			<ul className="space-y-1.5">
				{SOURCES.map((source) => (
					<li key={source} className="flex items-start gap-2">
						<span
							aria-hidden="true"
							className="mt-[3px] size-2.5 shrink-0 rounded-[35%] [corner-shape:squircle]"
							style={{ backgroundColor: SOURCE_COLOR[source] }}
						/>
						<span className="min-w-0">
							<span className="font-medium text-foreground">{KIND_LABEL[source]}</span>{" "}
							<span className="text-muted-foreground">{SOURCE_DESCRIPTION[source]}</span>
						</span>
					</li>
				))}
			</ul>
		</div>
	)
}
