import type { IconProps } from "./icon"

// The bezel is drawn as sixteen dots and four arcs rather than a circle — the
// dashes read as compass gradations, and they keep the ring visually lighter
// than the needle it surrounds.
const paths: ReadonlyArray<string> = [
	"M8 2L16 2",
	"M6 4L6 4.01",
	"M18.01 4L18 4",
	"M4 6L4 6.01",
	"M10 10L10 10.01",
	"M14 14L14 14.01",
	"M20.01 6L20 6",
	"M2 8L2 16",
	"M22 8L22 16",
	"M4.01001 18L4.00001 18",
	"M20.01 18L20 18",
	"M6.01001 20L6.00001 20",
	"M18.01 20L18 20",
	"M8 22L16 22",
	"M8 12V16H12",
	"M16 12L16 8L12 8",
]

function CompassIcon({ size = 24, className, ...props }: IconProps) {
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
export { CompassIcon }
