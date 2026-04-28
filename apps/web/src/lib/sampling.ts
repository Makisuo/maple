/**
 * Parse OTel probability sampling threshold from hex string.
 * Threshold format: hex digits representing rejection probability.
 * e.g., "e668" -> ~90% rejection -> ~10% acceptance -> weight ~10
 */
export function parseSamplingThreshold(thresholdHex: string): {
	acceptanceProbability: number
	weight: number
} {
	if (!thresholdHex || thresholdHex === "0") {
		return { acceptanceProbability: 1, weight: 1 }
	}
	const thresholdInt = parseInt(thresholdHex, 16)
	const maxInt = Math.pow(16, thresholdHex.length)
	const rejectionRate = thresholdInt / maxInt
	const acceptanceProbability = Math.max(1 - rejectionRate, 0.0001) // floor to avoid div/0
	const weight = 1 / acceptanceProbability
	return { acceptanceProbability, weight }
}

/**
 * Estimate actual throughput from sampled + unsampled span counts.
 */
export function estimateThroughput(
	sampledCount: number,
	unsampledCount: number,
	thresholdHex: string,
	durationSeconds: number,
): { traced: number; estimated: number; hasSampling: boolean; weight: number } {
	const { weight } = parseSamplingThreshold(thresholdHex)
	const hasSampling = sampledCount > 0 && weight > 1.01
	const estimatedTotal = sampledCount * weight + unsampledCount
	const tracedTotal = sampledCount + unsampledCount
	return {
		traced: durationSeconds > 0 ? tracedTotal / durationSeconds : 0,
		estimated: durationSeconds > 0 ? estimatedTotal / durationSeconds : 0,
		hasSampling,
		weight,
	}
}
