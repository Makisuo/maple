import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M12 2L12 2.01",
	"M12 14L12 14.01",
	"M20 8L20 8.01",
	"M4 8L4 8.01",
	"M15 4L14 4",
	"M10 4L9 4",
	"M10 12L9 12",
	"M15 12L14 12",
	"M18 10L17 10",
	"M7 6L6 6",
	"M7 10L6 10",
	"M18 6L17 6",
	"M2 10V19",
	"M22 10V19",
	"M20 21L4 21",
]

function EnvelopeOpenIcon({ size = 24, className, ...props }: IconProps) {
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
export { EnvelopeOpenIcon }
