import { useMemo } from "react"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
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
	const jsonPayload = buildLogJsonPayload(log)
	const highlighted = useMemo(() => highlightCode(jsonPayload), [jsonPayload])

	return (
		<div>
			<div className="flex items-center justify-between mb-2">
				<span className="text-xs font-medium text-muted-foreground">JSON Payload</span>
				<CopyButton
					value={jsonPayload}
					label="Log JSON"
					idleLabel="Copy"
					iconSize={10}
					className="h-5 px-1.5 text-[10px]"
				/>
			</div>
			<pre className="rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
				<code dangerouslySetInnerHTML={{ __html: highlighted }} />
			</pre>
		</div>
	)
}
