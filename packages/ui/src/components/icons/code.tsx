import type { IconProps } from "./icon"

function CodeIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" {...props}>
      <path d="M7.5 17.5L2 12L7.5 6.5" stroke="currentColor" strokeWidth="2" strokeMiterlimit="10" strokeLinecap="square" />
      <path d="M16.5 17.5L22 12L16.5 6.5" stroke="currentColor" strokeWidth="2" strokeMiterlimit="10" strokeLinecap="square" />
    </svg>
  )
}
export { CodeIcon }
