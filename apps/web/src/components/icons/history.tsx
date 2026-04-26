import type { IconProps } from "./icon"

function HistoryIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" aria-hidden="true" {...props}>
      <path d="M12 7V12L16 16" stroke="currentColor" strokeWidth="2" strokeMiterlimit="10" strokeLinecap="square" />
      <path d="M3.5 3.5V7.5H7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
      <path d="M2.5 12C2.5 17.2467 6.75329 21.5 12 21.5C17.2467 21.5 21.5 17.2467 21.5 12C21.5 6.75329 17.2467 2.5 12 2.5C8.38142 2.5 5.23538 4.52314 3.63131 7.5L3.73595 7.311" stroke="currentColor" strokeWidth="2" strokeMiterlimit="10" strokeLinecap="square" />
    </svg>
  )
}
export { HistoryIcon }
