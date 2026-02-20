/**
 * Chart color Tailwind classes for depth-based coloring in visualizations.
 * Maps to Tailwind classes: bg-chart-1 through bg-chart-5
 */
export const CHART_BG_CLASSES = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
] as const

/**
 * Get a chart background color class based on depth level.
 * Cycles through chart-1 to chart-5 based on depth % 5.
 */
export function getDepthColorClass(depth: number): string {
  return CHART_BG_CLASSES[depth % CHART_BG_CLASSES.length]
}

/**
 * Get a consistent color class for a service name.
 * Uses a simple hash to assign colors deterministically.
 */
export function getServiceColorClass(serviceName: string): string {
  let hash = 0
  for (let i = 0; i < serviceName.length; i++) {
    hash = serviceName.charCodeAt(i) + ((hash << 5) - hash)
  }
  const index = Math.abs(hash) % CHART_BG_CLASSES.length
  return CHART_BG_CLASSES[index]
}

/**
 * Simple hash function for strings
 */
function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  return Math.abs(hash)
}

/**
 * Base hues for services - warm to cool spectrum
 * Using OKLCH for perceptually uniform colors
 */
const SERVICE_HUES = [
  210, // Blue
  160, // Teal
  280, // Purple
  340, // Pink
  30,  // Orange
  100, // Green
  50,  // Yellow
  190, // Cyan
]

/**
 * Extract class name from span name pattern "Class.FunctionName" or "Class::FunctionName"
 */
export function extractClassName(spanName: string): string | null {
  // Match patterns like "Class.Method", "Namespace.Class.Method", "Class::Method"
  const dotMatch = spanName.match(/^(.+?)\.[\w]+$/)
  if (dotMatch) {
    return dotMatch[1]
  }
  const colonMatch = spanName.match(/^(.+?)::[\w]+$/)
  if (colonMatch) {
    return colonMatch[1]
  }
  return null
}

/**
 * Get a color style for a span based on its service and class name.
 * - Each service gets a distinct base hue
 * - Each class within a service gets a lightness/saturation variation
 * - Returns inline style object with background color and appropriate text color
 */
export function getSpanColorStyle(
  spanName: string,
  serviceName: string,
  services: string[]
): React.CSSProperties {
  // Get service index for base hue
  const serviceIndex = services.indexOf(serviceName)
  const baseHue = SERVICE_HUES[serviceIndex % SERVICE_HUES.length]
  
  // Extract class name for variation within service
  const className = extractClassName(spanName)
  
  // Calculate lightness and chroma variations based on class
  let lightness = 0.55
  let chroma = 0.15
  
  if (className) {
    const classHash = hashString(className)
    // Vary lightness between 0.45 and 0.65
    lightness = 0.45 + (classHash % 20) / 100
    // Vary chroma between 0.12 and 0.18
    chroma = 0.12 + (classHash % 6) / 100
  }
  
  const bgColor = `oklch(${lightness} ${chroma} ${baseHue})`
  
  // Determine text color based on lightness
  const textColor = lightness > 0.55 ? 'oklch(0.2 0 0)' : 'oklch(0.98 0 0)'
  
  return {
    backgroundColor: bgColor,
    color: textColor,
  }
}

/**
 * Get a legend color for a service
 */
export function getServiceLegendColor(serviceName: string, services: string[]): string {
  const serviceIndex = services.indexOf(serviceName)
  const baseHue = SERVICE_HUES[serviceIndex % SERVICE_HUES.length]
  return `oklch(0.55 0.15 ${baseHue})`
}

/**
 * Get a border accent color for a service (slightly darker/more saturated than background)
 */
export function getServiceBorderColor(serviceName: string, services: string[]): string {
  const serviceIndex = services.indexOf(serviceName)
  const baseHue = SERVICE_HUES[serviceIndex % SERVICE_HUES.length]
  return `oklch(0.45 0.18 ${baseHue})`
}

/**
 * Calculate self-time for a span (duration minus overlapping children time)
 */
export function calculateSelfTime(
  span: { startTime: string; durationMs: number },
  children: Array<{ startTime: string; durationMs: number }>
): number {
  if (children.length === 0) return span.durationMs

  const spanStartMs = new Date(span.startTime).getTime()
  const spanEndMs = spanStartMs + span.durationMs

  // Calculate total time covered by children (accounting for overlaps)
  const childIntervals = children.map(child => {
    const childStartMs = new Date(child.startTime).getTime()
    const childEndMs = childStartMs + child.durationMs
    // Clamp to parent span boundaries
    return {
      start: Math.max(childStartMs, spanStartMs),
      end: Math.min(childEndMs, spanEndMs)
    }
  }).filter(i => i.end > i.start)

  if (childIntervals.length === 0) return span.durationMs

  // Merge overlapping intervals
  childIntervals.sort((a, b) => a.start - b.start)
  const merged: Array<{ start: number; end: number }> = []

  for (const interval of childIntervals) {
    if (merged.length === 0 || merged[merged.length - 1].end < interval.start) {
      merged.push({ ...interval })
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, interval.end)
    }
  }

  const childrenTime = merged.reduce((sum, i) => sum + (i.end - i.start), 0)
  return Math.max(0, span.durationMs - childrenTime)
}
