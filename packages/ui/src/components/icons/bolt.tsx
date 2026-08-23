import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M15 19L15 20",
	"M11 17V22H13",
	"M17 16L17 17",
	"M9 15L3 15L3 13",
	"M19 13L19 14",
	"M5 10L5 11",
	"M15 9L21 9V11",
	"M7 7L7 8",
	"M9 4L9 5",
	"M13 7V2H11",
]

function BoltIcon({ size = 24, className, ...props }: IconProps) {
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
				<path key={i} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			))}
		</svg>
	)
}
export { BoltIcon }
