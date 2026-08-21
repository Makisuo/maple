import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M10 16V20",
	"M14 16V20",
	"M5.90909 20L5.90909 16H18.0909L18.0909 20",
	"M22 10L23 10L23 14L22 14",
	"M22 18L22 6C22 4.89543 21.1046 4 20 4L4 4C2.89543 4 2 4.89543 2 6L2 18C2 19.1046 2.89543 20 4 20L20 20C21.1046 20 22 19.1046 22 18Z",
	"M8 12C9.10457 12 10 11.1046 10 10C10 8.89543 9.10457 8 8 8C6.89543 8 6 8.89543 6 10C6 11.1046 6.89543 12 8 12Z",
	"M16 12C17.1046 12 18 11.1046 18 10C18 8.89543 17.1046 8 16 8C14.8954 8 14 8.89543 14 10C14 11.1046 14.8954 12 16 12Z",
	"M2 10L1 10L1 14L2 14",
]

function FaceRobotIcon({ size = 24, className, ...props }: IconProps) {
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
				<path key={i} d={d} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
			))}
		</svg>
	)
}
export { FaceRobotIcon }
