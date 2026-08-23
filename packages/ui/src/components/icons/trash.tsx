import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M17 22L7 22",
	"M19 10V20",
	"M5 10V20",
	"M21 6H3",
	"M16 4H16.01",
	"M8.00001 4H8.01001",
	"M14 2H10",
]

function TrashIcon({ size = 24, className, ...props }: IconProps) {
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
export { TrashIcon }
