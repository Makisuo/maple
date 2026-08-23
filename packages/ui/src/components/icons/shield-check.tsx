import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M6 3H18",
	"M8.01 20L8 20",
	"M6.01 18L6 18",
	"M16.01 20L16 20",
	"M18.01 18L18 18",
	"M4 16V5",
	"M20 16V5",
	"M10 22H14",
	"M10 14.01V14",
	"M12 12.01V12",
	"M14 10.01V10",
	"M16 8.01V8",
	"M8 12.01V12",
]

function ShieldCheckIcon({ size = 24, className, ...props }: IconProps) {
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
export { ShieldCheckIcon }
