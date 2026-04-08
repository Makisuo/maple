import { View } from "react-native"

interface SparklineBarsProps {
  data: number[]
  color?: string
  height?: number
  barWidth?: number
  gap?: number
}

export function SparklineBars({
  data,
  color = "#d4873b",
  height = 20,
  barWidth = 4,
  gap = 2,
}: SparklineBarsProps) {
  const max = Math.max(...data, 1)

  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", height, gap }}>
      {data.map((value, i) => (
        <View
          key={i}
          style={{
            width: barWidth,
            height: Math.max((value / max) * height, 1),
            backgroundColor: color,
            borderRadius: 1,
          }}
        />
      ))}
    </View>
  )
}
