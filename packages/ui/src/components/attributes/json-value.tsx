"use client"

import { useMemo, useState } from "react"
import { ChevronRightIcon } from "../icons"
import { CopyButton } from "../ui/copy-button"
import { useAttributesConfig } from "./context"

interface CollapsibleJsonValueProps {
	value: string
	parsed: unknown
}

/**
 * Collapsed preview of a JSON attribute value that expands into a pretty-printed,
 * optionally syntax-highlighted block with a copy control. Highlighting is
 * supplied by the `AttributesProvider` (`highlightJson`); without it the JSON
 * renders as plain text.
 */
export function CollapsibleJsonValue({ value, parsed }: CollapsibleJsonValueProps) {
	const { highlightJson } = useAttributesConfig()
	const [expanded, setExpanded] = useState(false)

	const pretty = useMemo(() => (expanded ? JSON.stringify(parsed, null, 2) : ""), [expanded, parsed])
	const highlighted = useMemo(
		() => (expanded && highlightJson ? highlightJson(pretty) : ""),
		[expanded, highlightJson, pretty],
	)

	const preview = value.length > 80 ? value.slice(0, 80) + "…" : value

	return (
		<div className="min-w-0">
			<button
				type="button"
				className="flex items-start gap-1 w-full text-left font-mono text-xs break-all cursor-pointer hover:bg-muted/50 rounded px-0.5 -mx-0.5 transition-colors"
				onClick={() => setExpanded(!expanded)}
				title={expanded ? "Collapse" : "Expand JSON"}
			>
				<ChevronRightIcon
					size={12}
					className={`shrink-0 mt-0.5 transition-transform ${expanded ? "rotate-90" : ""}`}
				/>
				{!expanded && <span>{preview}</span>}
				{expanded && <span className="text-muted-foreground">JSON</span>}
			</button>
			{expanded && (
				<div className="mt-1 rounded-md bg-muted/30 border overflow-hidden">
					<div className="flex items-center justify-end px-2 py-1 border-b">
						<CopyButton
							value={value}
							label="JSON"
							idleLabel="Copy"
							size="xs"
							iconSize={10}
							onClick={(e) => e.stopPropagation()}
						/>
					</div>
					<div className="max-h-64 overflow-auto p-2">
						<pre className="text-xs leading-relaxed">
							{highlightJson ? (
								<code dangerouslySetInnerHTML={{ __html: highlighted }} />
							) : (
								<code>{pretty}</code>
							)}
						</pre>
					</div>
				</div>
			)}
		</div>
	)
}
