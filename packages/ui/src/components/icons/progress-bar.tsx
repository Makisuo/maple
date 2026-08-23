import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M4 20H20",
	"M11 16L6 16",
	"M22 14L22 18",
	"M2 14L2 18",
	"M4 12H20",
	"M12 8L12 8.01",
	"M14 6L14 6.01",
	"M10 6L10 6.01",
	"M16 4L16 4.01",
	"M8 4L8 4.01",
	"M18 2L6 2",
]

function ProgressBarIcon({ size = 24, className, ...props }: IconProps) {
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
export { ProgressBarIcon }
