import type { IconProps } from "./icon"

// A two-star "sparkles" glyph — the conventional mark for AI / LLM features.
// Used to badge GenAI (`gen_ai.*`) client spans across the trace views.
const paths: ReadonlyArray<string> = [
	"M9.5 6.5 L11 11.5 L16 13 L11 14.5 L9.5 19.5 L8 14.5 L3 13 L8 11.5 Z",
	"M17.5 3 L18.3 5.2 L20.5 6 L18.3 6.8 L17.5 9 L16.7 6.8 L14.5 6 L16.7 5.2 Z",
]

function SparklesIcon({ size = 24, className, ...props }: IconProps) {
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
				<path
					key={i}
					d={d}
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			))}
		</svg>
	)
}
export { SparklesIcon }
