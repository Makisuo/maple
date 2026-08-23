import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M12 10V16",
	"M10 2H14",
	"M10 10H14",
	"M16 4L16 8",
	"M8 4L8 8",
	"M22 17.01L22 17",
	"M2 17.01L2 17",
	"M4 19.01L4 19",
	"M4 15.01L4 15",
	"M20 15.01L20 15",
	"M20 19.01L20 19",
	"M6 21H18",
	"M6 14H8",
	"M16 14H18",
]

function LocationIcon({ size = 24, className, ...props }: IconProps) {
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
export { LocationIcon }
