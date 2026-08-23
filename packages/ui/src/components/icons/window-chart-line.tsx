import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M6 8H6.01",
	"M10 8H10.01",
	"M4 4H20",
	"M4 20H20",
	"M2 6V18",
	"M22 6V18",
	"M8 14H8.01",
	"M10 12H10.01",
	"M12 14H12.01",
	"M14 16H14.01",
	"M16 14H16.01",
	"M18 12H18.01",
	"M6 16H6.01",
]

function WindowChartLineIcon({ size = 24, className, ...props }: IconProps) {
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
export { WindowChartLineIcon }
