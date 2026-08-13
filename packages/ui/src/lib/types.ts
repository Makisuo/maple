import type { SpanId, TraceId } from "@maple/domain"

export interface Span {
	traceId: TraceId
	spanId: SpanId
	parentSpanId: string
	spanName: string
	serviceName: string
	spanKind: string
	durationMs: number
	startTime: string
	statusCode: string
	statusMessage: string
	spanAttributes: Record<string, string>
	resourceAttributes: Record<string, string>
}

export interface SpanNode extends Span {
	children: SpanNode[]
	depth: number
	isMissing?: boolean
	/**
	 * Milliseconds this span's position was shifted to compensate for clock skew
	 * between the process that recorded it and the one that recorded its parent
	 * (see `adjustClockSkew`). `startTime` stays as reported — detail panes must
	 * show what the service actually sent — so every *chart* reads a span's
	 * position through `spanStartMs`, never `new Date(startTime)` directly.
	 */
	clockSkewMs?: number
}
