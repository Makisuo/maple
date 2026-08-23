import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M15 19H7",
	"M13 3L7 3",
	"M3 15L3 7",
	"M19 15L19 9",
	"M19 19L19 19.01",
	"M21 21L21 21.01",
	"M5 17L5 17.01",
	"M17 17L17 17.01",
	"M5 5L5 5.01",
	"M9 9.01V9",
	"M11 11.01V11",
	"M13 9.01V9",
	"M15 7.01V7",
	"M17 5.01V5",
]

function MagnifierCheckIcon({ size = 24, className, ...props }: IconProps) {
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
export { MagnifierCheckIcon }
