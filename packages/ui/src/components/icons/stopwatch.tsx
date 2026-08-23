import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M12 2V6",
	"M9 2H15",
	"M20 18L20 10",
	"M4 18L4 10",
	"M18 8H18.01",
	"M18 20H18.01",
	"M6 8H6.01",
	"M12 14H12.01",
	"M20 4H20.01",
	"M22 6H22.01",
	"M10 12H10.01",
	"M6 20H6.01",
	"M16 6L8 6",
	"M16 22L8 22",
]

function StopwatchIcon({ size = 24, className, ...props }: IconProps) {
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
export { StopwatchIcon }
