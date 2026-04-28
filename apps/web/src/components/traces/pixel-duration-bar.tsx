const TOTAL_BLOCKS = 27

interface PixelDurationBarProps {
	leftPercent: number
	widthPercent: number
	color: string
}

export function PixelDurationBar({ leftPercent, widthPercent, color }: PixelDurationBarProps) {
	const spanStart = leftPercent
	const spanEnd = leftPercent + widthPercent

	return (
		<div className="flex items-center gap-0.5 w-48">
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
