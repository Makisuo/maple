import type { BaseComponentProps } from "@json-render/react"
import { formatDuration, formatErrorRate, formatNumber } from "@/lib/format"

interface StatCardsProps {
	cards: Array<{
		label: string
		value: number | string
		format: "number" | "percent" | "duration" | "decimal" | "text"
	}>
}

function formatValue(value: number | string, format: string): string {
	if (format === "text" || typeof value === "string") {
		return String(value)
	}
	switch (format) {
		case "number":
			return formatNumber(value)
		case "percent":
			return formatErrorRate(value)
		case "duration":
			return formatDuration(value)
		case "decimal":
			return value.toFixed(3)
		default:
			return String(value)
	}
}

export function StatCards({ props }: BaseComponentProps<StatCardsProps>) {
	const { cards } = props

	return (
		<div className="flex flex-wrap gap-1.5">
			{cards.map((card) => (
				<div
					key={card.label}
					className="min-w-[80px] rounded border border-border/40 px-2 py-1.5"
				>
					<p className="text-[10px] text-muted-foreground">{card.label}</p>
					<p className="font-mono text-sm font-medium">{formatValue(card.value, card.format)}</p>
				</div>
			))}
		</div>
	)
}
