import type { IconProps } from "./icon"

function NetworkNodesIcon({ size = 24, className, ...props }: IconProps) {
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
			<path d="M4.5 13.5L10.5 19.5" stroke="currentColor" strokeWidth="2" />
			<path d="M4.5 10.5L10.5 4.5" stroke="currentColor" strokeWidth="2" />
			<path d="M19.5 13.5L13.5 19.5" stroke="currentColor" strokeWidth="2" />
			<path d="M19.5 10.5L13.5 4.5" stroke="currentColor" strokeWidth="2" />
			<path
				d="M12 5C13.10 5 14 4.10 14 3C14 1.89 13.10 1 12 1C10.89 1 10 1.89 10 3C10 4.10 10.89 5 12 5Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M12 23C13.10 23 14 22.10 14 21C14 19.89 13.10 19 12 19C10.89 19 10 19.89 10 21C10 22.10 10.89 23 12 23Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M19 12C19 13.10 19.89 14 21 14C22.10 14 23 13.10 23 12C23 10.89 22.10 10 21 10C19.89 10 19 10.89 19 12Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M1 12C1 13.10 1.89 14 3 14C4.10 14 5 13.10 5 12C5 10.89 4.10 10 3 10C1.89 10 1 10.89 1 12Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M12 14C13.10 14 14 13.10 14 12C14 10.89 13.10 10 12 10C10.89 10 10 10.89 10 12C10 13.10 10.89 14 12 14Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
		</svg>
	)
}
export { NetworkNodesIcon }
