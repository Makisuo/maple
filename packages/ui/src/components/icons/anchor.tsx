import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M8 22H16",
	"M18 20H18.01",
	"M6 20H6.01",
	"M22 16H22.01",
	"M2 16H2.01",
	"M20 14V18",
	"M12 12V22",
	"M4 14V18",
	"M9 12H15",
	"M13 8L11 8",
	"M15 6L15 4",
	"M9 6L9 4",
	"M13 2L11 2",
]

function AnchorIcon({ size = 24, className, ...props }: IconProps) {
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
export { AnchorIcon }
