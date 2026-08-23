import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M3 21L21 21",
	"M3 17L6 17",
	"M18 17L21 17",
	"M8 18L16 18",
	"M23.01 19L23 19",
	"M1.01 19L1 19",
	"M3 5L3 13",
	"M21 5L21 13",
	"M19 3L5 3",
]

function LaptopIcon({ size = 24, className, ...props }: IconProps) {
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
export { LaptopIcon }
