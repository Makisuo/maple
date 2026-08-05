import type { IconProps } from "./icon"

// Two arrows passing in opposite directions — "this differs from that". Used on
// the journeys list where the served model isn't the model that was requested.
const paths: ReadonlyArray<string> = ["M3 8H21", "M17 4L21 8L17 12", "M21 16H3", "M7 12L3 16L7 20"]

function ArrowsSwapIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="none"
			aria-hidden="true"
			{...props}
		>
			{paths.map((d, i) => (
				<path
					key={i}
					d={d}
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			))}
		</svg>
	)
}
export { ArrowsSwapIcon }
