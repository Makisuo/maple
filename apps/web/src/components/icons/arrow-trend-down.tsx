import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M2 20H22",
	"M16 13H22V7",
	"M2.01001 5L2.00001 5",
	"M4.01001 7L4.00001 7",
	"M6.01001 9L6.00001 9",
	"M8.01001 11L8.00001 11",
	"M10.01 9L10 9",
	"M12.01 7L12 7",
	"M14.01 5L14 5",
	"M16.01 7L16 7",
	"M18.01 9L18 9",
	"M20.01 11L20 11",
]

function ArrowTrendDownIcon({ size = 24, className, ...props }: IconProps) {
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

export { ArrowTrendDownIcon }
