import type { IconProps } from "./icon"

// Source: simple-icons (MIT) — https://simpleicons.org/icons/redis
function RedisIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="#FF4438"
			aria-hidden="true"
			{...props}
		>
			<path d="M22.71 13.14c-1.66 2.09-3.45 4.48-7.03 4.48-3.20 0-4.39-2.82-4.48-5.12.70 1.48 2.07 2.68 4.21 2.63 4.11-.133 6.94-3.85 6.94-7.23 0-4.05-3.02-6.97-8.26-6.97-3.75 0-8.4 1.42-11.45 3.68C2.59 6.93 3.88 9.95 4.35 9.62c2.64-1.90 4.74-3.13 6.78-3.74C8.12 9.24.886 17.05 0 18.42c.1 1.26 1.66 4.64 2.42 4.64.232 0 .431-.133.66-.365a100.49 100.49 0 0 0 5.54-6.76c.222 3.10 1.74 6.89 6.01 6.89 3.81 0 7.60-2.75 9.33-8.96.2-.764-.73-1.36-1.26-.73zm-4.34-5.01c0 1.95-1.92 2.92-3.68 2.92-.941 0-1.66-.247-2.23-.568 1.05-1.59 2.09-3.22 3.21-4.97 1.97.334 2.71 1.43 2.71 2.61z" />
		</svg>
	)
}

export { RedisIcon }
