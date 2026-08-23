import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M12.01 22L12 22",
	"M16 20L14 20",
	"M10 20L8 20",
	"M20 18L18 18",
	"M12.01 18L12 18",
	"M6 18L4 18",
	"M22.01 16L22 16",
	"M16 16L14 16",
	"M10 16L8 16",
	"M2.01 16L2 16",
	"M20 14L18 14",
	"M12.01 14L12 14",
	"M6 14L4 14",
	"M22.01 12L22 12",
	"M16 12L14 12",
	"M10 12L8 12",
	"M2.01 12L2 12",
	"M20 10L18 10",
	"M6 10L4 10",
	"M22.01 8L22 8",
	"M2.01 8L2 8",
	"M20 6L18 6",
	"M6 6L4 6",
	"M16 4L14 4",
	"M10 4L8 4",
	"M12.01 2L12 2",
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
