import { ExternalLinkIcon } from "@/components/icons"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import type { Log } from "@/api/warehouse/logs"
import { LogAttributesPanel } from "./log-attributes-panel"
import { buildLogJsonPayload } from "./log-raw-panel"
import { HighlightedText } from "./highlighted-text"

interface LogRowExpandedProps {
	log: Log
	/** Text to mark in the message, when the search box holds a text search. */
	highlight?: string
	/** Opens the full detail drawer (Attributes / Trace / Raw tabs). */
	onOpenDetail: () => void
}

/**
 * Inline expansion rendered beneath a log row's one-line header. Shows the full
 * wrapped body plus every attribute (via the shared `LogAttributesPanel`) in a
 * height-bounded, vertically scrollable panel so a wide event reads in place
 * without leaving the stream.
 */
export function LogRowExpanded({ log, highlight, onOpenDetail }: LogRowExpandedProps) {
	return (
		<div className="border-t border-border/60 bg-muted/15 px-3 py-2.5 font-mono">
			<div className="mb-2 flex items-center justify-end gap-3">
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation()
						onOpenDetail()
					}}
					className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
				>
					<ExternalLinkIcon size={10} />
					Open detail
				</button>
				<CopyButton
					value={() => buildLogJsonPayload(log)}
					label="Log JSON"
					idleLabel="JSON"
					iconSize={10}
					className="h-5 px-1.5 text-[10px]"
					onClick={(e) => e.stopPropagation()}
				/>
			</div>
			{/* Body + attributes share one height-bounded scroll area so even a very
			    wide event stays a predictable size and scrolls vertically in place. */}
			<div className="max-h-[60vh] space-y-2.5 overflow-auto">
				<p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground">
					<HighlightedText text={log.body} query={highlight} />
				</p>
				<LogAttributesPanel log={log} />
			</div>
		</div>
	)
}
