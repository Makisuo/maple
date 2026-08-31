import { CircleInfoIcon } from "@/components/icons"
import { Popover, PopoverContent, PopoverTrigger } from "@maple/ui/components/ui/popover"

import { HighlightedText } from "./highlighted-text"
import { LogSearchModeBadge, type LogSearchMode } from "./log-search-mode-badge"

interface Lookup {
	mode: LogSearchMode
	example: string
	does: string
	note: string
}

/** In recognizer order — the box tries the id shapes first, then falls back to text. */
const LOOKUPS: Lookup[] = [
	{
		mode: "trace",
		example: "4b1f2c3d4e5f60718293a4b5c6d7e8f9",
		does: "Scopes the page to that trace.",
		note: "32 hex",
	},
	{
		mode: "header",
		example: "00-4b1f2c3d…-00f067aa0ba902b7-01",
		does: "Same, from a pasted traceparent.",
		note: "W3C",
	},
	{
		mode: "text",
		example: "conn reset",
		does: "Any part of a message, case-insensitive.",
		note: "anything else",
	},
]

const TEXT_EXAMPLE = "redis: Conn reset by peer after 3 retries"

/**
 * What the search box accepts, from the info affordance beside the SEARCH
 * label. A popover rather than a tooltip: this is reference material (a table,
 * reachable on touch), not a label for an icon.
 */
export function LogSearchHelp() {
	return (
		<Popover>
			<PopoverTrigger
				openOnHover
				delay={200}
				className="cursor-pointer rounded-sm text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[popup-open]:text-foreground"
				aria-label="What you can search for"
			>
				<CircleInfoIcon size={12} />
			</PopoverTrigger>
			<PopoverContent align="start" side="right" className="w-80">
				<p className="font-medium text-foreground text-xs">What you can search</p>
				<p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
					One box. It reads the shape of what you type and picks the lookup.
				</p>

				<dl className="mt-3 space-y-2.5">
					{LOOKUPS.map((lookup) => (
						<div key={lookup.mode} className="grid grid-cols-[3.75rem_1fr] gap-x-2 gap-y-0.5">
							<dt className="mt-px h-fit">
								<LogSearchModeBadge mode={lookup.mode} className="block text-center" />
							</dt>
							<dd className="min-w-0 truncate font-mono text-[11px] text-foreground">
								{lookup.example}
							</dd>
							<dd className="col-start-2 text-[11px] text-muted-foreground leading-relaxed">
								{lookup.does}{" "}
								<span className="text-muted-foreground/60">({lookup.note})</span>
							</dd>
						</div>
					))}
				</dl>

				{/* The text row's claim, shown rather than asserted — and rendered through
				    the same splitter the stream uses, so it cannot drift. */}
				<div className="mt-3 break-words rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-[11px] text-foreground leading-relaxed">
					<HighlightedText text={TEXT_EXAMPLE} query="conn reset" />
				</div>

				<p className="mt-2.5 text-[11px] text-muted-foreground leading-relaxed">
					A trace scope becomes a chip you can remove. Wrap an id in{" "}
					<span className="font-mono text-foreground">"quotes"</span> to search it as text instead.
				</p>
			</PopoverContent>
		</Popover>
	)
}
