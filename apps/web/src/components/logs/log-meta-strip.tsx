import { toast } from "sonner"
import { Link } from "@tanstack/react-router"
import { ClockIcon, CopyIcon, PulseIcon } from "@/components/icons"

import { useClipboard } from "@maple/ui/hooks/use-clipboard"
import { CopyableValue } from "@/components/attributes"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import type { Log } from "@/api/tinybird/logs"

interface LogMetaStripProps {
	log: Log
	timeZone: string
	jsonPayload: string
}

export function LogMetaStrip({ log, timeZone, jsonPayload }: LogMetaStripProps) {
	const clipboard = useClipboard()

	return (
		<div className="flex items-center gap-3 border-b px-4 py-1.5 text-xs shrink-0">
			<div className="flex items-center gap-1.5">
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
					className="inline-flex items-center gap-1 rounded border border-primary/20 bg-primary/5 px-1.5 py-0.5 font-mono text-[10px] text-primary hover:bg-primary/10 transition-colors"
					title={`View trace ${log.traceId}`}
				>
					<PulseIcon size={10} />
					trace:{log.traceId.slice(0, 8)}
				</Link>
			)}

			{log.spanId && (
				<span className="font-mono text-[10px] text-muted-foreground">
					<CopyableValue value={log.spanId}>span:{log.spanId.slice(0, 8)}</CopyableValue>
				</span>
			)}

			<button
				type="button"
				onClick={() => {
					clipboard.copy(jsonPayload)
					toast.success("Copied log as JSON")
				}}
				className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
				title="Copy entire log as JSON"
			>
				<CopyIcon size={10} />
				Copy JSON
			</button>
		</div>
	)
}
