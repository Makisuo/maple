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
				d="M1 10.73C1 6.95 2.83 3.61 5.68 1.61C6.71 0.87 8.32 0.72 9.05 1.61C10.01 2.87 8.32 4.65 9.05 5.69C11.03 8.13 15.21 3.31 20.12 5.69C23.63 7.46 23.12 12.14 22.68 13.84C21.36 18.51 17.11 22 12.06 22C5.98 21.92 1 16.95 1 10.73Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M6.5 15C6.77 15 7 14.77 7 14.5C7 14.22 6.77 14 6.5 14C6.22 14 6 14.22 6 14.5C6 14.77 6.22 15 6.5 15Z"
				fill="currentColor"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M5.5 10C5.77 10 6 9.77 6 9.5C6 9.22 5.77 9 5.5 9C5.22 9 5 9.22 5 9.5C5 9.77 5.22 10 5.5 10Z"
				fill="currentColor"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M10.5 18C10.77 18 11 17.77 11 17.5C11 17.22 10.77 17 10.5 17C10.22 17 10 17.22 10 17.5C10 17.77 10.22 18 10.5 18Z"
				fill="currentColor"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M17 14C18.10 14 19 12.88 19 11.5C19 10.11 18.10 9 17 9C15.89 9 15 10.11 15 11.5C15 12.88 15.89 14 17 14Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
		</svg>
	)
}
export { PaletteIcon }
