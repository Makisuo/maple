export function formatDuration(ms: number): string {
	if (ms < 1) {
		return `${(ms * 1000).toFixed(0)}μs`
	}
	if (ms < 1000) {
		return `${ms.toFixed(1)}ms`
	}
	return `${(ms / 1000).toFixed(2)}s`
}
