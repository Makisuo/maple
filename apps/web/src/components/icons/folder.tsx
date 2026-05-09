import type { IconProps } from "./icon"

function FolderIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M2 5V18C2 19.10 2.89 20 4 20H20C21.10 20 22 19.10 22 18V8C22 6.89 21.10 6 20 6H13L10 3H4C2.89 3 2 3.89 2 5Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
		</svg>
	)
}
export { FolderIcon }
