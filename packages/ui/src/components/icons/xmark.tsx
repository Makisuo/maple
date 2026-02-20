import type { IconProps } from "./icon"

function XmarkIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" {...props}>
      <line x1="19" y1="19" x2="5" y2="5" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
      <line x1="19" y1="5" x2="5" y2="19" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
    </svg>
  )
}
export { XmarkIcon }
