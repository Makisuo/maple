/**
 * Stub buckets for LiveLogsVolumeChart. 60 five-minute buckets ending now,
 * with severity-stacked counts. The shape tells a story: quiet baseline →
 * warn cluster around bucket 40 → small error blip at 50 → recover.
 */

export type LogBucket = {
	bucket: string;
	INFO: number;
	DEBUG: number;
	WARN: number;
	ERROR: number;
};

const NOW = Date.UTC(2026, 4, 3, 12, 0, 0); // 2026-05-03T12:00 UTC, deterministic
const BUCKET_MS = 5 * 60 * 1000;
const COUNT = 60;

function pseudoRandom(seed: number): number {
	const x = Math.sin(seed * 9301 + 49297) * 233280;
	return x - Math.floor(x);
}

export function generateBuckets(): LogBucket[] {
	const out: LogBucket[] = [];
	for (let i = 0; i < COUNT; i++) {
		const t = new Date(NOW - (COUNT - 1 - i) * BUCKET_MS);
		const noise = pseudoRandom(i + 1);

		const info = Math.round(140 + noise * 50 + (i > 38 && i < 46 ? 30 : 0));
		const debug = Math.round(45 + noise * 18);
		const warn = Math.round(
			6 + noise * 4 + (i >= 38 && i <= 46 ? Math.max(0, 70 - Math.abs(42 - i) * 14) : 0),
		);
		const error = Math.round(
			i >= 48 && i <= 52 ? Math.max(0, 22 - Math.abs(50 - i) * 6) + noise * 3 : noise * 2,
		);

		out.push({
			bucket: t.toISOString(),
			INFO: info,
			DEBUG: debug,
			WARN: warn,
			ERROR: error,
		});
	}
	return out;
}

export const stubBuckets = generateBuckets();

export function totalCount(buckets: LogBucket[]): number {
	return buckets.reduce((sum, b) => sum + b.INFO + b.DEBUG + b.WARN + b.ERROR, 0);
}

export function formatNumber(num: number): string {
	if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
	if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
	return num.toLocaleString();
}

export function formatBucketTick(value: string): string {
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return value;
	return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
