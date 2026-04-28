import type { PriorityLevel } from "@/components/icons"

export function shortIssueId(id: string): string {
	return id.replace(/-/g, "").slice(0, 7).toUpperCase()
}

export function clampPriority(value: number): PriorityLevel {
	if (!Number.isFinite(value)) return 0
	const rounded = Math.trunc(value)
	if (rounded < 0) return 0
	if (rounded > 4) return 4
	return rounded as PriorityLevel
}
