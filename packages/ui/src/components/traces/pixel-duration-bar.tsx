import * as React from "react"

import { cn } from "../../lib/utils"

const TOTAL_BLOCKS = 27

interface PixelDurationBarProps {
	leftPercent: number
	widthPercent: number
	color: string
	className?: string
}

function PixelDurationBarImpl({ leftPercent, widthPercent, color, className }: PixelDurationBarProps) {
	const spanStart = leftPercent
	const spanEnd = leftPercent + widthPercent

	// Fixed-size blocks, so this bar can't shrink to fit — callers hide it when the row is narrow.
	return (
		<div className={cn("flex items-center gap-0.5 w-48", className)}>
			{Array.from({ length: TOTAL_BLOCKS }, (_, i) => {
				const blockStart = (i / TOTAL_BLOCKS) * 100
				const blockEnd = ((i + 1) / TOTAL_BLOCKS) * 100
				const isActive = blockEnd > spanStart && blockStart < spanEnd

				return (
					<div
						key={i}
						className={`w-[5px] h-2.5 rounded-[1px] shrink-0 ${isActive ? color : "bg-muted"}`}
					/>
				)
			})}
		</div>
	)
}

export const PixelDurationBar = React.memo(PixelDurationBarImpl)
