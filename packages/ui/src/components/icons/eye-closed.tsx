import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M12.01 19L12 19",
	"M18.01 18L18 18",
	"M6.01 18L6 18",
	"M16 16L8 16",
	"M22.01 14L22 14",
	"M18.01 14L18 14",
	"M6.01 14L6 14",
	"M2.01 14L2 14",
	"M20.01 12L20 12",
	"M4.01 12L4 12",
	"M22 8V10",
	"M2 8V10",
]

function EyeClosedIcon({ size = 24, className, ...props }: IconProps) {
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
export { EyeClosedIcon }
