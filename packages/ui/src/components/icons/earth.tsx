import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M18 11L22 11",
	"M16 17L16 18",
	"M10 16.01L10 16",
	"M14 15.01L14 15",
	"M16 13.01L16 13",
	"M12 8.01L12 8",
	"M10 10.01L10 10",
	"M8 6L10 6",
	"M8 12L7 12",
	"M5 14L2 14",
	"M18 4L17.99 4",
	"M20 6L19.99 6",
	"M18 20.01L18 20",
	"M20 18.01L20 18",
	"M6 20.01L6 20",
	"M4 18.01L4 18",
	"M4 6.01L4 6",
	"M6 4.01L6 4",
	"M16 22L8 22",
	"M16 2L8 2",
	"M22 8L22 16",
	"M2 8L2 16",
]

function EarthIcon({ size = 24, className, ...props }: IconProps) {
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
export { EarthIcon }
