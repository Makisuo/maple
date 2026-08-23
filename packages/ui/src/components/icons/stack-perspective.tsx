import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M14 22H12",
	"M10 20H8",
	"M6 18H4",
	"M20 17L20 17",
	"M16 13L16 20",
	"M14 11H12",
	"M10 9H8",
	"M2 9L2 16",
	"M22 8L22 15",
	"M6 7H4",
	"M20 6H18",
	"M16 4H14",
	"M8 4L8 5",
	"M12 2H10",
]

function StackPerspectiveIcon({ size = 24, className, ...props }: IconProps) {
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
export { StackPerspectiveIcon }
