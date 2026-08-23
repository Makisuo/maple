import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M5 20H19",
	"M10 4L14 4",
	"M20 12H21",
	"M3 12H4",
	"M16 6L16 6.01",
	"M21 19L21 19.01",
	"M3 19L3 19.01",
	"M8 6L8 6.01",
	"M6 8V10",
	"M18 8V10",
	"M23 14V17",
	"M1 14V17",
]

function CloudIcon({ size = 24, className, ...props }: IconProps) {
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
export { CloudIcon }
