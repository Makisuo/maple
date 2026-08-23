import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M10 22L14 22",
	"M16.01 20L16 20",
	"M5.01 18L5 18",
	"M19.01 6L19 6",
	"M18.01 18L18 18",
	"M20.01 16L20 16",
	"M22 10L22 14",
	"M2 10L2 14",
	"M7 12L7 16",
	"M17 8L17 12",
	"M4 8L4 8.01",
	"M6 6L6 6.01",
	"M8 4L8 4.01",
	"M11 6L11 6.01",
	"M13 18L13 17.99",
	"M13 8L13 8.01",
	"M11 16L11 15.99",
	"M10 2L14 2",
	"M9 8V10H11",
	"M15 16L15 14L13 14",
]

function CryptographyIcon({ size = 24, className, ...props }: IconProps) {
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
export { CryptographyIcon }
