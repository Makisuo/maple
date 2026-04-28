import type { IconProps } from "./icon"

function PaletteIcon({ size = 24, className, ...props }: IconProps) {
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
			<path
				d="M1 10.7315C1 6.95059 2.8317 3.61452 5.68915 1.61287C6.7149 0.871522 8.3268 0.723252 9.05948 1.61287C10.012 2.87317 8.3268 4.65241 9.05948 5.6903C11.0377 8.13675 15.214 3.31798 20.1229 5.6903C23.6398 7.46954 23.1269 12.14 22.6873 13.8451C21.3685 18.5157 17.119 22 12.0635 22C5.98222 21.9259 1 16.9588 1 10.7315Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M6.5 15C6.77614 15 7 14.7761 7 14.5C7 14.2239 6.77614 14 6.5 14C6.22386 14 6 14.2239 6 14.5C6 14.7761 6.22386 15 6.5 15Z"
				fill="currentColor"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M5.5 10C5.77614 10 6 9.77614 6 9.5C6 9.22386 5.77614 9 5.5 9C5.22386 9 5 9.22386 5 9.5C5 9.77614 5.22386 10 5.5 10Z"
				fill="currentColor"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M10.5 18C10.7761 18 11 17.7761 11 17.5C11 17.2239 10.7761 17 10.5 17C10.2239 17 10 17.2239 10 17.5C10 17.7761 10.2239 18 10.5 18Z"
				fill="currentColor"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M17 14C18.1046 14 19 12.8807 19 11.5C19 10.1193 18.1046 9 17 9C15.8954 9 15 10.1193 15 11.5C15 12.8807 15.8954 14 17 14Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
		</svg>
	)
}
export { PaletteIcon }
