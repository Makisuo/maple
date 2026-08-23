import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M17 7V7.01",
	"M13 7V7.01",
	"M13 11V11.01",
	"M17 11V11.01",
	"M15 13V17",
	"M15 1V5",
	"M11.01 8.99L9.01 8.99",
	"M21.01 8.99L19.01 8.99",
	"M9.01 17L9 17",
	"M3.01 6L3 6",
	"M5.01 17L5 17",
	"M7 13L7 15",
	"M7 19L7 21",
]

function SparkleIcon({ size = 24, className, ...props }: IconProps) {
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
export { SparkleIcon }
