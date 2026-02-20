import type { IconProps } from "./icon"

function ArrowDownIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" {...props}>
      <path d="M12 3V21V20.5" stroke="currentColor" strokeWidth="2" strokeMiterlimit="10" strokeLinecap="square" />
      <path d="M19 14L12 21L5 14" stroke="currentColor" strokeWidth="2" strokeMiterlimit="10" strokeLinecap="square" />
    </svg>
  )
}
export { ArrowDownIcon }
