import type { IconProps } from "./icon"

// Nucleo Pixel-style tablet: wider portrait slab than MobileIcon, home-button dot.
const paths: ReadonlyArray<string> = ["M6 3H18", "M6 21H18", "M4 19V5", "M20 19V5", "M12 17H12.01"]

function TabletIcon({ size = 24, className, ...props }: IconProps) {
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
export { TabletIcon }
