import type { IconProps } from "./icon"

const paths: ReadonlyArray<string> = ["M4 4H20V20H4Z", "M4 13L13 4", "M9 20L20 9"]

/**
 * A hatched square — the mark for content that was never recorded. Used
 * wherever a message body, a system prompt or a tool's arguments are absent by
 * design (a provider privacy mode), which is a first-class state rather than a
 * failure, so it reads as a deliberate redaction rather than as an error.
 */
function SquareRedactedIcon({ size = 24, className, ...props }: IconProps) {
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
export { SquareRedactedIcon }
