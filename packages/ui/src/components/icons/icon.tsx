import type { SVGProps, ComponentType } from "react"

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number | string
}

export type IconComponent = ComponentType<IconProps>
