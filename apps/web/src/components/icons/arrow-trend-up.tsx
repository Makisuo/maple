import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M16 5H22V11",
	"M2 20H22",
	"M2.01001 13L2.00001 13",
	"M4.01001 11L4.00001 11",
	"M6.01001 9L6.00001 9",
	"M8.01001 7L8.00001 7",
	"M10.01 9L10 9",
	"M12.01 11L12 11",
	"M14.01 13L14 13",
	"M16.01 11L16 11",
	"M18.01 9L18 9",
	"M20.01 7L20 7",
]

function ArrowTrendUpIcon({ size = 24, className, ...props }: IconProps) {
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

export { ArrowTrendUpIcon }
