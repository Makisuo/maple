import type { IconProps } from "./icon"

function RocketIcon({ size = 24, className, ...props }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      width={size} height={size} className={className} fill="none" {...props}>
      <path d="m10.001,7h-3.038c-.608,0-1.183.277-1.563.752l-3.602,4.51,4.553,1.089" stroke="currentColor" strokeMiterlimit="10" strokeWidth="2" />
      <path d="m17,13.999v3.038c0,.608-.277,1.183-.752,1.563l-4.51,3.602-1.089-4.553" stroke="currentColor" strokeMiterlimit="10" strokeWidth="2" />
      <circle cx="15.5" cy="8.5" r=".5" fill="currentColor" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
      <path d="m4.402,16.95c-.31.153-.62.372-.918.67-1.161,1.161-1.484,4.38-1.484,4.38,0,0,3.22-.324,4.38-1.484.297-.297.516-.608.67-.918" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
      <path d="m10.649,17.649c5.762-1.583,10.564-6.504,11.351-15.649-9.145.786-14.067,5.588-15.649,11.351l4.299,4.299Z" stroke="currentColor" strokeLinecap="square" strokeMiterlimit="10" strokeWidth="2" />
    </svg>
  )
}
export { RocketIcon }
