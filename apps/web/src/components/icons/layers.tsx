import type { IconProps } from "./icon"

// Nucleo Pixel Essential — "layers" (set 8, 24 grid), ported to currentColor.
// Ordered top to bottom; every segment sits on an even pixel so the stack stays
// crisp at 16 and 18px.
const paths: ReadonlyArray<string> = [
	"M13 3L11 3",
	"M9 5L8 5",
	"M16 5L15 5",
	"M6 7L5 7",
	"M19 7L18 7",
	"M3 9L2 9",
	"M22 9L21 9",
	"M6 11L5 11",
	"M19 11L18 11",
	"M9 13L8 13",
	"M16 13L15 13",
	"M3 15L2 15",
	"M13 15L11 15",
	"M22 15L21 15",
	"M6 17L5 17",
	"M19 17L18 17",
	"M9 19L8 19",
	"M16 19L15 19",
	"M13 21L11 21",
]

function LayersIcon({ size = 24, className, ...props }: IconProps) {
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
export { LayersIcon }
