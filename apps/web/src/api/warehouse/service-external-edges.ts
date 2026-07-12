import { summarizeSampling } from "@/lib/sampling"

type ServiceExternalTargetType = "http" | "messaging" | "rpc"

export interface ServiceExternalEdge {
	sourceService: string
	targetType: ServiceExternalTargetType
	targetSystem: string
	targetName: string
	callCount: number
	estimatedCallCount: number
	errorCount: number
	errorRate: number
	avgDurationMs: number
	p95DurationMs: number
	hasSampling: boolean
	samplingWeight: number
}

const knownTargetTypes: ReadonlySet<ServiceExternalTargetType> = new Set(["http", "messaging", "rpc"])

function coerceTargetType(value: unknown): ServiceExternalTargetType {
	return knownTargetTypes.has(value as ServiceExternalTargetType)
		? (value as ServiceExternalTargetType)
		: "http"
}

export function transformExternalEdge(
	row: Record<string, unknown>,
	durationSeconds: number,
): ServiceExternalEdge {
	const callCount = Number(row.callCount ?? 0)
	const errorCount = Number(row.errorCount ?? 0)
	const estimatedSpanCount = Number(row.estimatedSpanCount ?? 0)
	const sampling = summarizeSampling(estimatedSpanCount, callCount, durationSeconds)
	const estimatedCallCount = sampling.hasSampling ? Math.round(estimatedSpanCount) : callCount
	return {
		sourceService: String(row.sourceService ?? ""),
		targetType: coerceTargetType(row.targetType),
		targetSystem: String(row.targetSystem ?? ""),
		targetName: String(row.targetName ?? ""),
		callCount,
		estimatedCallCount,
		errorCount,
		errorRate: callCount > 0 ? errorCount / callCount : 0,
		avgDurationMs: Number(row.avgDurationMs ?? 0),
		p95DurationMs: Number(row.p95DurationMs ?? 0),
		hasSampling: sampling.hasSampling,
		samplingWeight: sampling.weight,
	}
}
