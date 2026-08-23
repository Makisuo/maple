import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M20 6L20 6.01",
	"M18 4L18 4.01",
	"M5.99 4L6 4",
	"M22 8L22 13",
	"M16 2L8 2",
	"M4 6V2",
	"M19 19L19 19",
	"M2.01 12L2 12",
	"M5 19L5 19",
	"M12 22L12 22",
]

function ArrowDottedRotateIcon({ size = 24, className, ...props }: IconProps) {
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
export { ArrowDottedRotateIcon }
