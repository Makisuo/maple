import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M19 21H5",
	"M19 3H5",
	"M3 19L3 5",
	"M21 19L21 5",
	"M5 12.01L5 12",
	"M9 17.01L9 17",
	"M13 11.01L13 11",
	"M15 9.01L15 9",
	"M11 15V13",
	"M7 15V14",
	"M17 7H19",
]

function SquareActivityChartIcon({ size = 24, className, ...props }: IconProps) {
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
export { SquareActivityChartIcon }
