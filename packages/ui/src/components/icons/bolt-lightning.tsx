import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = [
	"M17 17L17 16",
	"M15 20L15 19",
	"M19 14L19 13",
	"M21 11L21 9L14 9L14 7",
	"M6 7L6 9",
	"M4 11V14H11V22H13",
	"M8 5V2H16V5",
]

function BoltLightningIcon({ size = 24, className, ...props }: IconProps) {
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
export { BoltLightningIcon }
