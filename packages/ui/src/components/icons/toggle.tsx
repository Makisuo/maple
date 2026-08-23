import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M18 18L16 18",
	"M6 18L10 18",
	"M20 16.01L20 16",
	"M12 16.01L12 16",
	"M4 16.01L4 16",
	"M22 14L22 10",
	"M14 10L14 14",
	"M2 10L2 14",
	"M20 8.01L20 8",
	"M12 8.01L12 8",
	"M4 8.01L4 8",
	"M18 6L16 6",
	"M6 6L10 6",
]

function ToggleIcon({ size = 24, className, ...props }: IconProps) {
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
export { ToggleIcon }
