import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M18.01 21L18 21",
	"M6.01 21L6 21",
	"M20.01 19L20 19",
	"M16.01 19L16 19",
	"M8.01 19L8 19",
	"M4.01 19L4 19",
	"M14 13L14 15L12 15",
	"M20.01 12L20 12",
	"M4.01 12L4 12",
	"M10 13V11H12",
	"M22 9L22 17",
	"M8.01 9L8 9",
	"M2 9L2 17",
	"M20.01 7L20 7",
	"M6.01 7L6 7",
	"M18.01 5L18 5",
	"M12.01 5L12 5",
	"M4.01 5L4 5",
	"M8 3L16 3",
]

function GaugeIcon({ size = 24, className, ...props }: IconProps) {
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
export { GaugeIcon }
