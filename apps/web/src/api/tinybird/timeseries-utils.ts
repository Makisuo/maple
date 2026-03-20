const TARGET_POINTS = 30;
const AUTO_BUCKET_LADDER = [300, 900, 1800, 3600, 14400, 86400] as const;
const TINYBIRD_DATETIME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/;

function toEpochMs(value: string): number {
  return new Date(value.replace(" ", "T") + "Z").getTime();
}

function floorToBucketMs(epochMs: number, bucketSeconds: number): number {
  const bucketMs = bucketSeconds * 1000;
  return Math.floor(epochMs / bucketMs) * bucketMs;
}

export function toIsoBucket(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const raw = String(value).trim();
  const tinybirdDateTimeMatch = raw.match(TINYBIRD_DATETIME_RE);
  const normalized = tinybirdDateTimeMatch
    ? `${tinybirdDateTimeMatch[1]}T${tinybirdDateTimeMatch[2]}${tinybirdDateTimeMatch[3] ?? ""}Z`
    : raw;

  const parsed = new Date(normalized).getTime();
  if (Number.isNaN(parsed)) {
    return raw;
  }

  return new Date(parsed).toISOString();
}

export function computeBucketSeconds(startTime?: string, endTime?: string, targetPoints = TARGET_POINTS): number {
  if (!startTime || !endTime) return 300;

  const startMs = toEpochMs(startTime);
  const endMs = toEpochMs(endTime);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return 300;
  }

  const rangeSeconds = Math.max((endMs - startMs) / 1000, 1);
  const raw = Math.ceil(rangeSeconds / targetPoints);
  return AUTO_BUCKET_LADDER.reduce((best, candidate) => {
    return Math.abs(candidate - raw) < Math.abs(best - raw) ? candidate : best;
  }, AUTO_BUCKET_LADDER[0]);
}

export function buildBucketTimeline(
  startTime: string | undefined,
  endTime: string | undefined,
  bucketSeconds: number,
): string[] {
  if (!startTime || !endTime) {
    return [];
  }

  const startMs = toEpochMs(startTime);
  const endMs = toEpochMs(endTime);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
    return [];
  }

  const bucketMs = bucketSeconds * 1000;
  const firstBucketMs = floorToBucketMs(startMs, bucketSeconds);
  const lastBucketMs = floorToBucketMs(endMs, bucketSeconds);
  const buckets: string[] = [];

  for (let cursor = firstBucketMs; cursor <= lastBucketMs; cursor += bucketMs) {
    buckets.push(new Date(cursor).toISOString());
  }

  return buckets;
}
