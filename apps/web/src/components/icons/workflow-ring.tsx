import type { IconProps } from "./icon"
import type { WorkflowState } from "@maple/domain/http"

export const WORKFLOW_LABEL: Record<WorkflowState, string> = {
	triage: "Triage",
	regressed: "Regressed",
	todo: "Todo",
	in_progress: "In progress",
	in_review: "In review",
	done: "Done",
	cancelled: "Cancelled",
	wontfix: "Won't fix",
} satisfies Record<WorkflowState, string>

const WORKFLOW_COLOR: Record<WorkflowState, string> = {
	triage: "oklch(0.72 0.17 55)",
	regressed: "oklch(0.58 0.20 25)",
	todo: "oklch(0.60 0.02 286)",
	in_progress: "oklch(0.75 0.15 85)",
	in_review: "oklch(0.65 0.16 290)",
	done: "oklch(0.60 0.14 250)",
	cancelled: "oklch(0.55 0.01 286)",
	wontfix: "oklch(0.55 0.01 286)",
} satisfies Record<WorkflowState, string>

interface WorkflowRingIconProps extends IconProps {
	state: WorkflowState
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
	const start = polarToCartesian(cx, cy, r, endAngle)
	const end = polarToCartesian(cx, cy, r, startAngle)
	const largeArc = endAngle - startAngle <= 180 ? 0 : 1
	return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y} Z`
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
	const rad = ((angleDeg - 90) * Math.PI) / 180
	return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function WorkflowRingIcon({ state, size = 14, className, ...props }: WorkflowRingIconProps) {
	const color = WORKFLOW_COLOR[state]
	const label = WORKFLOW_LABEL[state]

	const common = {
		xmlns: "http://www.w3.org/2000/svg",
		viewBox: "0 0 24 24",
		width: size,
		height: size,
		className,
		fill: "none",
		role: "img" as const,
		"aria-label": label,
		...props,
	}

	if (state === "triage") {
		return (
			<svg {...common}>
				<circle cx="12" cy="12" r="9" stroke={color} strokeWidth="2" strokeDasharray="3 3" />
				<circle cx="12" cy="12" r="3" fill={color} />
			</svg>
		)
	}

	if (state === "todo") {
		return (
			<svg {...common}>
				<circle cx="12" cy="12" r="9" stroke={color} strokeWidth="2" />
			</svg>
		)
	}

	if (state === "in_progress") {
		return (
			<svg {...common}>
				<circle cx="12" cy="12" r="9" stroke={color} strokeWidth="2" />
				<path d={describeArc(12, 12, 7, 0, 140)} fill={color} />
			</svg>
		)
	}

	if (state === "in_review") {
		return (
			<svg {...common}>
				<circle cx="12" cy="12" r="9" stroke={color} strokeWidth="2" />
				<path d={describeArc(12, 12, 7, 0, 280)} fill={color} />
			</svg>
		)
	}

	if (state === "done") {
		return (
			<svg {...common}>
				<circle cx="12" cy="12" r="10" fill={color} />
				<path
					d="M8 12 L11 15 L16 9"
					stroke="white"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		)
	}

	if (state === "cancelled") {
		return (
			<svg {...common}>
				<circle cx="12" cy="12" r="10" fill={color} />
				<path d="M9 9 L15 15 M15 9 L9 15" stroke="white" strokeWidth="2" strokeLinecap="round" />
			</svg>
		)
	}

	// wontfix
	return (
		<svg {...common}>
			<circle cx="12" cy="12" r="10" fill={color} />
			<path d="M8 12 L16 12" stroke="white" strokeWidth="2" strokeLinecap="round" />
		</svg>
	)
}

export { WorkflowRingIcon, WORKFLOW_COLOR }
