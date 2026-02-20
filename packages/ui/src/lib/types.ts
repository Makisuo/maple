export interface Span {
  traceId: string
  spanId: string
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
}
