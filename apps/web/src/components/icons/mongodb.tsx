import type { IconProps } from "./icon"

// Source: simple-icons (MIT) — https://simpleicons.org/icons/mongodb
function MongodbIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="#47A248"
			aria-hidden="true"
			{...props}
		>
			<path d="M17.19 9.55c-1.26-5.58-4.25-7.41-4.57-8.11-.28-.394-.53-.954-.735-1.44-.036.49-.055.68-.523 1.18-.723.56-4.43 3.68-4.74 10.02-.282 5.91 4.27 9.43 4.88 9.88l.07.05A73.49 73.49 0 0111.91 24h.481c.114-1.03.284-2.05.51-3.07.41-.296.60-.463.85-.693a11.34 11.34 0 003.63-8.46c.01-.814-.103-1.66-.197-2.21zm-5.33 8.19s0-8.29.275-8.29c.213 0 .49 10.69.49 10.69-.381-.045-.765-1.76-.765-2.40z" />
		</svg>
	)
}

export { MongodbIcon }
