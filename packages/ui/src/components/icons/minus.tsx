import type { IconProps } from "./icon"

function MinusIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" {...props}>
      <line x1="21" y1="12" x2="3" y2="12" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
    </svg>
  )
}
export { MinusIcon }
