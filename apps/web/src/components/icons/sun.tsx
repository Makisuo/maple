import type { IconProps } from "./icon"

function SunIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path d="M12 1V2" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M12 22V23" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M23 12L22 12" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M2 12L1 12" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path
				d="M19.7782 4.2218L19.0711 4.92891"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				d="M4.92893 19.071L4.22183 19.7782"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				d="M19.7782 19.7782L19.0711 19.0711"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				d="M4.92893 4.92896L4.22183 4.22185"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
		</svg>
	)
}
export { SunIcon }
