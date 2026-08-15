import type { IconProps } from "./icon"

export type PriorityLevel = 0 | 1 | 2 | 3 | 4

export const PRIORITY_LABEL: Record<PriorityLevel, string> = {
	0: "No priority",
	1: "Urgent",
	2: "High",
	3: "Medium",
	4: "Low",
} satisfies Record<PriorityLevel, string>

interface PriorityBarsIconProps extends IconProps {
	level: PriorityLevel
}

function PriorityBarsIcon({ level, size = 16, className, ...props }: PriorityBarsIconProps) {
	const label = PRIORITY_LABEL[level]

	if (level === 0) {
		return (
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				width={size}
				height={size}
				className={className}
				fill="none"
				role="img"
				aria-label={label}
				{...props}
			>
				<circle cx="4" cy="12" r="2" fill="currentColor" opacity="0.55" />
				<circle cx="12" cy="12" r="2" fill="currentColor" opacity="0.55" />
				<circle cx="20" cy="12" r="2" fill="currentColor" opacity="0.55" />
			</svg>
		)
	}

	if (level === 1) {
		return (
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				width={size}
				height={size}
				className={className}
				fill="none"
				role="img"
				aria-label={label}
				{...props}
			>
				<rect x="2" y="2" width="20" height="20" rx="5" fill="oklch(0.70 0.18 55)" />
				<rect x="11" y="6" width="2" height="8" rx="1" fill="white" />
				<rect x="11" y="16" width="2" height="2" rx="1" fill="white" />
			</svg>
		)
	}

	const filled = level === 2 ? 3 : level === 3 ? 2 : 1
	const bars = [
		{ x: 3, h: 7 },
		{ x: 10, h: 12 },
		{ x: 17, h: 17 },
	]

	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="none"
			role="img"
			aria-label={label}
			{...props}
		>
			{bars.map((bar, i) => (
				<rect
					key={i}
					x={bar.x}
					y={20 - bar.h}
					width="4"
					height={bar.h}
					rx="1"
					fill="currentColor"
					opacity={i < filled ? 1 : 0.2}
				/>
			))}
		</svg>
	)
}

export { PriorityBarsIcon }
