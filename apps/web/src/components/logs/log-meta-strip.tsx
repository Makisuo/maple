import { Link } from "@tanstack/react-router"
import { ClockIcon, CopyIcon, ExternalLinkIcon, LinkIcon, PulseIcon } from "@/components/icons"

import { CopyableValue } from "@/components/attributes"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { encodeLogKey } from "@/lib/log-key"
import { buildLogJsonPayload } from "./log-raw-panel"
import type { Log } from "@/api/warehouse/logs"

interface LogMetaStripProps {
	log: Log
	timeZone: string
	/**
	 * Show the "Open full page" link. `true` in the drawer; `false` on the
	 * standalone `/logs/$logId` page, where the link would point at itself.
	 */
	showOpenFullPage?: boolean
}

export function LogMetaStrip({ log, timeZone, showOpenFullPage = true }: LogMetaStripProps) {
	const linkCopy = useCopyToClipboard("Log link")
	const jsonCopy = useCopyToClipboard("Log JSON")

	return (
		<div className="flex items-center gap-2 overflow-x-auto border-b px-4 py-1.5 text-xs shrink-0 whitespace-nowrap">
			<div className="flex items-center gap-1.5 shrink-0">
				<ClockIcon size={12} className="text-muted-foreground" />
				<span className="font-mono">
					<CopyableValue value={log.timestamp}>
						{formatTimestampInTimezone(log.timestamp, {
							timeZone,
							withMilliseconds: true,
						})}
					</CopyableValue>
				</span>
			</div>

			{log.traceId && (
				<Link
					to="/traces/$traceId"
					params={{ traceId: log.traceId }}
					search={{ t: log.timestamp }}
					className="inline-flex shrink-0 items-center gap-1 rounded border border-primary/20 bg-primary/5 px-1.5 py-0.5 font-mono text-[11px] text-primary hover:bg-primary/10 transition-colors"
					title={`View trace ${log.traceId}`}
				>
					<PulseIcon size={10} />
					trace:{log.traceId.slice(0, 8)}
				</Link>
			)}

			{log.spanId && (
				<span className="shrink-0 font-mono text-[11px] text-muted-foreground">
					<CopyableValue value={log.spanId}>span:{log.spanId.slice(0, 8)}</CopyableValue>
				</span>
			)}

			{/* Icon-only actions keep the strip on a single line in the narrow drawer. */}
			<div className="ml-auto flex shrink-0 items-center gap-0.5">
				{showOpenFullPage && (
					<Link
						to="/logs/$logId"
						params={{ logId: encodeLogKey(log) }}
						className="flex shrink-0 items-center rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
						title="Open in full page"
						aria-label="Open in full page"
					>
						<ExternalLinkIcon size={13} />
					</Link>
				)}

				<button
					type="button"
					onClick={() => linkCopy.copy(`${window.location.origin}/logs/${encodeLogKey(log)}`)}
					className="flex shrink-0 items-center rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
					title="Copy a shareable link to this log"
					aria-label="Copy shareable link"
				>
					<LinkIcon size={13} />
				</button>

				<button
					type="button"
					onClick={() => jsonCopy.copy(buildLogJsonPayload(log))}
					className="flex shrink-0 items-center rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
					title="Copy entire log as JSON"
					aria-label="Copy log as JSON"
				>
					<CopyIcon size={13} />
				</button>
			</div>
		</div>
	)
}
