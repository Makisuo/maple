import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M12 12V7",
	"M8 12H16",
	"M11 2H13",
	"M15 4V7H9V4",
	"M19 21L17 21",
	"M7 21L5 21",
	"M15 19L15 16L21 16L21 19",
	"M3 19L3 16L9 16L9 19",
	"M18 14H18.01",
	"M6 14H6.01",
]

function SitemapIcon({ size = 24, className, ...props }: IconProps) {
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
export { SitemapIcon }
