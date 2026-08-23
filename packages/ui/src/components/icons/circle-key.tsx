import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M8 2L16 2",
	"M6 4L6 4.01",
	"M18.01 4L18 4",
	"M20.01 6L20 6",
	"M22 8L22 16",
	"M20.01 18L20 18",
	"M6.01 20L6 20",
	"M18.01 20L18 20",
	"M8 22L16 22",
	"M13 14V11H8V13",
	"M4 9H6",
	"M4 15H6",
	"M2 11L2 13",
]

function CircleKeyIcon({ size = 24, className, ...props }: IconProps) {
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
export { CircleKeyIcon }
