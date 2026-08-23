import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M20 6L20 6.01",
	"M18 4L18 4.01",
	"M22 8L22 16",
	"M16 2L12 2",
	"M12 22H16",
	"M18.01 20L18 20",
	"M20.01 18L20 18",
	"M12 12L12 8",
	"M16.01 16L16 16",
	"M14.01 14L14 14",
	"M2.01 12L2 12",
	"M5 5L5 5",
	"M5 19L5 19",
]

function CircleDottedClockIcon({ size = 24, className, ...props }: IconProps) {
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
export { CircleDottedClockIcon }
