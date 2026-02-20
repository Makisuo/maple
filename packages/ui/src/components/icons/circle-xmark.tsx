import type { IconProps } from "./icon"

function CircleXmarkIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" {...props}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
      <line x1="15.5" y1="8.5" x2="8.5" y2="15.5" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
      <line x1="15.5" y1="15.5" x2="8.5" y2="8.5" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
    </svg>
  )
}
export { CircleXmarkIcon }
