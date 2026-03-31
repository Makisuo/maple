export interface ReleaseMarker {
  bucket: string
  commitSha: string
  label: string
}

export function detectReleaseMarkers(
  timeline: Array<{ bucket: string; commitSha: string; count: number }>,
): ReleaseMarker[] {
  if (timeline.length === 0) return []

  const sorted = [...timeline].sort((a, b) => a.bucket.localeCompare(b.bucket))

  // Find the dominant SHA (highest total count) — this is the "established" release
  const countBySha = new Map<string, number>()
  for (const point of sorted) {
    countBySha.set(point.commitSha, (countBySha.get(point.commitSha) ?? 0) + point.count)
  }

  let dominantSha = ""
  let maxCount = 0
  for (const [sha, count] of countBySha) {
    if (count > maxCount) {
      dominantSha = sha
      maxCount = count
    }
  }

  // Only 1 SHA in the entire range — no releases to mark
  if (countBySha.size <= 1) return []

  // Mark the first appearance of every non-dominant SHA,
  // but only if it appears after the first bucket (otherwise the
  // release predates the visible time range)
  const firstBucket = sorted[0].bucket
  const seen = new Set<string>()
  const markers: ReleaseMarker[] = []

  for (const point of sorted) {
    if (!seen.has(point.commitSha)) {
      seen.add(point.commitSha)
      if (point.commitSha !== dominantSha && point.bucket !== firstBucket) {
        markers.push({
          bucket: point.bucket,
          commitSha: point.commitSha,
          label: point.commitSha.slice(0, 7),
        })
      }
    }
  }

  return markers
}
