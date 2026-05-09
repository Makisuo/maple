import type { IconProps } from "./icon"

// Source: lobe-icons (MIT) — https://github.com/lobehub/lobe-icons
// (simple-icons does not ship AWS service icons; this matches the official
// AWS Lambda mark — square frame with a stylized Λ.)
function AwsLambdaIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="#FF9900"
			fillRule="evenodd"
			aria-hidden="true"
			{...props}
		>
			<path d="M2 2h20v20H2V2zm1.76 18.23h16.45V3.76H3.76v16.47zm3.51-14.91l3.47 6.17-3.87 7.15h2.49l2.58-4.88 2.74 4.88h2.54L9.82 5.32l-2.53.002z" />
		</svg>
	)
}

export { AwsLambdaIcon }
