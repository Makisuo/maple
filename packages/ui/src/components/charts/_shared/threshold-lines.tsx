import type { ReactNode } from "react"
import { ReferenceLine } from "recharts"

import { validateCssColor } from "../../../lib/sanitizers"
import type { ChartThreshold } from "./chart-types"

/**
 * Builds the `<ReferenceLine>` elements for a chart's thresholds. Returned as
 * an array so it can be spread directly into a Recharts chart's children —
 * Recharts flattens arrays when locating its child components.
 */
export function thresholdReferenceLines(thresholds: ChartThreshold[] | undefined): ReactNode[] {
	if (!thresholds || thresholds.length === 0) return []

	return thresholds.map((threshold, index) => {
		const stroke = validateCssColor(threshold.color) ?? "var(--destructive)"
		return (
			<ReferenceLine
				key={`threshold-${index}`}
				y={threshold.value}
				stroke={stroke}
				strokeDasharray="4 4"
				strokeWidth={1.5}
				ifOverflow="extendDomain"
				label={
					threshold.label
						? {
								value: threshold.label,
								position: "insideTopRight",
								fontSize: 10,
								fill: stroke,
							}
						: undefined
				}
			/>
		)
	})
}
