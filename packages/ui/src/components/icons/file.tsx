import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M8 18H16",
	"M8 14L11 14",
	"M12 4V10H8",
	"M4 20L4 10",
	"M20 20L20 4",
	"M12 2L18 2",
	"M6 22L18 22",
	"M6 8H6.01",
	"M8 6H8.01",
	"M10 4H10.01",
]

function FileIcon({ size = 24, className, ...props }: IconProps) {
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
export { FileIcon }
