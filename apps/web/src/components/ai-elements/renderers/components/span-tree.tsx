import type { BaseComponentProps } from "@json-render/react"
import { cn } from "@maple/ui/utils"
import { formatDuration } from "@/lib/format"

interface SpanNode {
	spanId: string
	parentSpanId: string
	spanName: string
	serviceName: string
	durationMs: number
	statusCode: string
	statusMessage: string
	children: SpanNode[]
}

interface SpanTreeProps {
	traceId: string
	spans: SpanNode[]
}

function SpanNode({ span, isLast, depth }: { span: SpanNode; isLast: boolean; depth: number }) {
	const prefix = depth === 0 ? "" : isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 "
	const isError = span.statusCode === "Error"

	return (
		<div>
			<div className="flex items-center gap-1 py-0.5 text-[11px]">
				<span
					className="shrink-0 font-mono text-muted-foreground"
					style={{ paddingLeft: `${depth * 16}px` }}
				>
					{prefix}
				</span>
				<span className={cn("shrink-0", isError ? "text-severity-error" : "text-severity-info")}>
					{isError ? "\u2717" : "\u2713"}
				</span>
				<span className="truncate font-medium">{span.spanName}</span>
				<span className="shrink-0 text-muted-foreground">{span.serviceName}</span>
				<span className="ml-auto shrink-0 font-mono text-muted-foreground">
					{formatDuration(span.durationMs)}
				</span>
			</div>
			{span.children.map((child, i) => (
				<SpanNode
					key={child.spanId}
					span={child}
					isLast={i === span.children.length - 1}
					depth={depth + 1}
				/>
			))}
		</div>
	)
}

export function SpanTree({ props }: BaseComponentProps<SpanTreeProps>) {
	const { spans, traceId } = props

	return (
		<div className="space-y-1">
			<div className="text-[10px] text-muted-foreground">
				Trace{" "}
				<a href={`/traces/${traceId}`} className="font-mono text-primary hover:underline">
					{traceId.slice(0, 12)}
				</a>
			</div>
			<div className="max-h-[400px] overflow-y-auto">
				{spans.map((span, i) => (
					<SpanNode key={span.spanId} span={span} isLast={i === spans.length - 1} depth={0} />
				))}
			</div>
		</div>
	)
}
