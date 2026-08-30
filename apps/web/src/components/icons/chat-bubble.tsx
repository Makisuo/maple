import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M8 11.01V11",
	"M12 11.01V11",
	"M16 11.01V11",
	"M4 4H20",
	"M2 6V16",
	"M22 6V16",
	"M4 18H20",
]

function ChatBubbleIcon({ size = 24, className, ...props }: IconProps) {
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
export { ChatBubbleIcon }
