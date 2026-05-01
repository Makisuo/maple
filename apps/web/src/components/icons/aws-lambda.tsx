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
			fill="currentColor"
			fillRule="evenodd"
			aria-hidden="true"
			{...props}
		>
			<path d="M2 2h20v20H2V2zm1.768 18.237h16.459V3.761H3.768v16.476zm3.515-14.91l3.479 6.176-3.871 7.154h2.493l2.58-4.883 2.747 4.883h2.54L9.82 5.324l-2.538.002z" />
		</svg>
	)
}

export { AwsLambdaIcon }
