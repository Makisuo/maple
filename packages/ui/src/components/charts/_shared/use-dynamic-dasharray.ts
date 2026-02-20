import { useCallback, useState } from "react"

interface DynamicDasharrayResult {
  strokeDasharray: string
  onRender: (props: {
    points?: Array<{ x: number; y: number }>
    data?: Array<Record<string, unknown>>
    forecastKey?: string
  }) => null
}

export function useDynamicDasharray(forecastKey = "forecast"): DynamicDasharrayResult {
  const [dasharray, setDasharray] = useState("1 0")

  const onRender = useCallback(
    ({
      points,
      data,
    }: {
      points?: Array<{ x: number; y: number }>
      data?: Array<Record<string, unknown>>
      forecastKey?: string
    }) => {
      if (!points || !data || points.length < 2) return null

      const forecastStartIndex = data.findIndex((d) => d[forecastKey])
      if (forecastStartIndex === -1) {
        setDasharray("1 0")
        return null
      }

      let solidLength = 0
      for (let i = 0; i < forecastStartIndex && i < points.length - 1; i++) {
        const dx = points[i + 1].x - points[i].x
        const dy = points[i + 1].y - points[i].y
        solidLength += Math.sqrt(dx * dx + dy * dy)
      }

      let dashedLength = 0
      for (let i = forecastStartIndex; i < points.length - 1; i++) {
        const dx = points[i + 1].x - points[i].x
        const dy = points[i + 1].y - points[i].y
        dashedLength += Math.sqrt(dx * dx + dy * dy)
      }

      setDasharray(`${solidLength} 0 ${dashedLength > 0 ? `4 4` : ""}`)
      return null
    },
    [forecastKey]
  )

  return { strokeDasharray: dasharray, onRender }
}
