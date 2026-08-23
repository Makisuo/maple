import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M12 2V5",
	"M12 22V19",
	"M22.01 12L19.01 12",
	"M2.01 12L5.01 12",
	"M8 2L16 2",
	"M6 4L6 4.01",
	"M18.01 4L18 4",
	"M4 6L4 6.01",
	"M20.01 6L20 6",
	"M2 8L2 16",
	"M22 8L22 16",
	"M4.01 18L4 18",
	"M20.01 18L20 18",
	"M6.01 20L6 20",
	"M18.01 20L18 20",
	"M8 22L16 22",
]

function CrosshairsIcon({ size = 24, className, ...props }: IconProps) {
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
export { CrosshairsIcon }
