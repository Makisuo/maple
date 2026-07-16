import { useMemo } from "react"
import { CopyIcon } from "@/components/icons"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { highlightCode } from "@/lib/sugar-high"
import type { Log } from "@/api/warehouse/logs"

/** Serialize a log into the pretty-printed JSON shown in the Raw panel. */
export function buildLogJsonPayload(log: Log): string {
	return JSON.stringify(
		{
			timestamp: log.timestamp,
			severityText: log.severityText,
			severityNumber: log.severityNumber,
			serviceName: log.serviceName,
			body: log.body,
			traceId: log.traceId || undefined,
			spanId: log.spanId || undefined,
			logAttributes: log.logAttributes,
			resourceAttributes: log.resourceAttributes,
		},
		null,
		2,
	)
}

interface LogRawPanelProps {
	log: Log
}

/** Raw JSON payload of a log, with a copy-to-clipboard control. */
export function LogRawPanel({ log }: LogRawPanelProps) {
	const { copy } = useCopyToClipboard("Log JSON")
	const jsonPayload = buildLogJsonPayload(log)
	const highlighted = useMemo(() => highlightCode(jsonPayload), [jsonPayload])

	return (
		<div>
			<div className="flex items-center justify-between mb-2">
				<span className="text-xs font-medium text-muted-foreground">JSON Payload</span>
				<button
					type="button"
					onClick={() => copy(jsonPayload)}
					className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
				>
					<CopyIcon size={10} />
					Copy
				</button>
			</div>
			<pre className="rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
				<code dangerouslySetInnerHTML={{ __html: highlighted }} />
			</pre>
		</div>
	)
}
