import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M19 3H5",
	"M19 21H5",
	"M3 19V5",
	"M21 19V5",
	"M14.01 12H14",
	"M16.01 8H16",
	"M8.01 16H8",
	"M10.01 12H10",
	"M12 8V10",
	"M12 14V16",
]

function SquareSparkleIcon({ size = 24, className, ...props }: IconProps) {
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
export { SquareSparkleIcon }
