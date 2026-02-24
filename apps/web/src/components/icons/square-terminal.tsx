import type { IconProps } from "./icon"

function SquareTerminalIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" {...props}>
      <path d="M21 3H3V21H21V3Z" stroke="currentColor" strokeWidth="2" strokeMiterlimit="10" strokeLinecap="square" />
      <path d="M7.5 15.5L10.5 12.5L7.5 9.5" stroke="currentColor" strokeWidth="2" strokeMiterlimit="10" strokeLinecap="square" />
      <path d="M13 16H17" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
    </svg>
  )
}
export { SquareTerminalIcon }
