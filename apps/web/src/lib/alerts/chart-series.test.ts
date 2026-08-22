import { describe, expect, it } from "vitest"
import {
	AlertRulePreviewPoint,
	AlertRulePreviewResponse,
	AlertRulePreviewSeries,
	IsoDateTimeString,
} from "@maple/domain/http"

import {
	clipToDomain,
	GHOST_KEY,
	mergeGhost,
	projectPreview,
	resolveChartDomain,
	resolveSource,
	SINGLE_KEY,
	type ChartPoint,
} from "./chart-series"

const T0 = Date.parse("2026-08-01T00:00:00.000Z")
const MINUTE = 60_000
const iso = (ms: number) => IsoDateTimeString.make(new Date(ms).toISOString())
const domain = { min: T0, max: T0 + 60 * MINUTE }

interface PointInput {
	readonly offsetMinutes: number
	readonly value: number | null
	readonly sampleCount?: number
	readonly status?: AlertRulePreviewPoint["status"]
	readonly provisional?: boolean
}

const previewOf = (
	groups: ReadonlyArray<{ readonly groupKey: string; readonly points: ReadonlyArray<PointInput> }>,
	options?: { readonly truncatedToStart?: string | null; readonly bucketSeconds?: number },
) =>
	new AlertRulePreviewResponse({
		bucketSeconds: options?.bucketSeconds ?? 300,
		windowMinutes: 5,
		threshold: 0.05,
		thresholdUpper: null,
		comparator: "gt",
		truncatedToStart:
			options?.truncatedToStart != null ? IsoDateTimeString.make(options.truncatedToStart) : null,
		series: groups.map(
			(group) =>
				new AlertRulePreviewSeries({
					groupKey: group.groupKey,
					points: group.points.map(
						(point) =>
							new AlertRulePreviewPoint({
								bucket: iso(T0 + point.offsetMinutes * MINUTE),
								value: point.value,
								sampleCount: point.sampleCount ?? 100,
								status: point.status ?? (point.value == null ? "skipped" : "healthy"),
								...(point.provisional === true ? { provisional: true } : undefined),
							}),
					),
				}),
		),
		wouldFire: [],
	})

describe("resolveChartDomain", () => {
	// The server caps how many evaluation windows a preview replays. Framing the
	// plot on the range the user picked then crams the whole series against the
	// right edge of an empty grid, which reads as missing data, not as a clamp.
	it("frames on what was previewed when the preview owns the axis", () => {
		const truncated = new Date(T0 + 40 * MINUTE).toISOString()
		expect(resolveChartDomain(domain, truncated, { hasOverlays: false })).toEqual({
			domain: { min: T0 + 40 * MINUTE, max: domain.max },
			clampedToPreview: true,
		})
	})

	// The rail and the incident lane are capped by nothing and share this domain.
	it("keeps the requested range when overlays share the axis", () => {
		const truncated = new Date(T0 + 40 * MINUTE).toISOString()
		expect(resolveChartDomain(domain, truncated, { hasOverlays: true })).toEqual({
			domain,
			clampedToPreview: false,
		})
	})

	it("keeps the requested range for an untruncated or unparseable start", () => {
		expect(resolveChartDomain(domain, null, { hasOverlays: false }).clampedToPreview).toBe(false)
		expect(resolveChartDomain(domain, "not a date", { hasOverlays: false }).clampedToPreview).toBe(false)
	})

	// A clamp past the end of the window would leave an inverted axis.
	it("refuses a clamp that would not leave a range", () => {
		const past = new Date(domain.max + MINUTE).toISOString()
		expect(resolveChartDomain(domain, past, { hasOverlays: false })).toEqual({
			domain,
			clampedToPreview: false,
		})
	})
})

describe("projectPreview", () => {
	// Points plot at the window CLOSE — the moment the evaluator observes it —
	// which is what lines them up with check timestamps and the axis edge.
	it("plots each bucket at its window close", () => {
		const projection = projectPreview(
			previewOf([{ groupKey: "all", points: [{ offsetMinutes: 0, value: 0.02 }] }]),
			domain.max,
		)
		expect(projection.rows).toEqual([{ t: T0 + 5 * MINUTE, [SINGLE_KEY]: 0.02 }])
		expect(projection.isMultiSeries).toBe(false)
	})

	// The in-progress window is shorter than a full step, so closing it a full
	// step out would overshoot the axis.
	it("closes the provisional window at the domain edge", () => {
		const projection = projectPreview(
			previewOf([
				{
					groupKey: "all",
					points: [{ offsetMinutes: 57, value: 0.04, provisional: true }],
				},
			]),
			domain.max,
		)
		expect(projection.rows[0]!.t).toBe(domain.max)
		expect(projection.meta.get(domain.max)?.provisional).toBe(true)
	})

	// An entirely valueless preview charts nothing useful; the caller falls
	// through to checks or to the placeholder instead of drawing an empty grid.
	it("reports no points when every window came back empty", () => {
		const projection = projectPreview(
			previewOf([
				{
					groupKey: "all",
					points: [
						{ offsetMinutes: 0, value: null, sampleCount: 0 },
						{ offsetMinutes: 5, value: null, sampleCount: 0 },
					],
				},
			]),
			domain.max,
		)
		expect(projection.hasPoints).toBe(false)
		expect(projection.rows).toEqual([])
	})

	it("merges consecutive empty windows into one hatched band", () => {
		const projection = projectPreview(
			previewOf([
				{
					groupKey: "all",
					points: [
						{ offsetMinutes: 0, value: 0.02 },
						{ offsetMinutes: 5, value: null, sampleCount: 0 },
						{ offsetMinutes: 10, value: null, sampleCount: 0 },
						{ offsetMinutes: 15, value: 0.03 },
					],
				},
			]),
			domain.max,
		)
		expect(projection.noDataBands).toEqual([{ x1: T0 + 5 * MINUTE, x2: T0 + 15 * MINUTE }])
	})

	// A bucket is only "no data" when EVERY group came back empty — one group
	// reporting is data, however many others are quiet.
	it("does not hatch a bucket where one group reported", () => {
		const projection = projectPreview(
			previewOf([
				{ groupKey: "checkout", points: [{ offsetMinutes: 0, value: 0.02 }] },
				{ groupKey: "search", points: [{ offsetMinutes: 0, value: null, sampleCount: 0 }] },
			]),
			domain.max,
		)
		expect(projection.noDataBands).toEqual([])
		expect(projection.isMultiSeries).toBe(true)
		expect(projection.seriesKeys).toEqual(["checkout", "search"])
	})

	// The tooltip shows one status per instant, so the worst across groups wins:
	// a bucket where anything breached must not read as healthy.
	it("keeps the worst status and the summed samples across groups", () => {
		const projection = projectPreview(
			previewOf([
				{
					groupKey: "checkout",
					points: [{ offsetMinutes: 0, value: 0.09, status: "breached", sampleCount: 30 }],
				},
				{
					groupKey: "search",
					points: [{ offsetMinutes: 0, value: 0.01, status: "healthy", sampleCount: 70 }],
				},
			]),
			domain.max,
		)
		expect(projection.meta.get(T0 + 5 * MINUTE)).toEqual({
			sampleCount: 100,
			status: "breached",
			provisional: false,
		})
	})
})

describe("resolveSource", () => {
	it("draws the requested source when it has points", () => {
		expect(resolveSource("checks", { preview: true, checks: true })).toEqual({
			source: "checks",
			fellBack: false,
			bothAvailable: true,
		})
	})

	// The chart used to make this swap silently, changing what it meant with no
	// indication at all.
	it("falls back to the other source and says it did", () => {
		expect(resolveSource("checks", { preview: true, checks: false })).toEqual({
			source: "preview",
			fellBack: true,
			bothAvailable: false,
		})
	})

	it("resolves to nothing when neither source has points", () => {
		expect(resolveSource("preview", { preview: false, checks: false })).toEqual({
			source: "none",
			fellBack: false,
			bothAvailable: false,
		})
	})
})

describe("mergeGhost", () => {
	const primary: ChartPoint[] = [
		{ t: T0, [SINGLE_KEY]: 1 },
		{ t: T0 + 5 * MINUTE, [SINGLE_KEY]: 2 },
	]

	it("folds the other source onto the primary's own instants", () => {
		const merged = mergeGhost(
			primary,
			[
				{ t: T0 + 30_000, [SINGLE_KEY]: 1.5 },
				{ t: T0 + 5 * MINUTE + 30_000, [SINGLE_KEY]: 4 },
			],
			MINUTE,
		)
		expect(merged.rows[0]![GHOST_KEY]).toBe(1.5)
		expect(merged.rows[1]![GHOST_KEY]).toBe(4)
		// The widest gap at a shared instant is what the "sources differ" pill shows.
		expect(merged.divergence).toBe(2)
	})

	// Beyond a bucket's spacing the two are not describing the same window, and
	// pairing them would invent a disagreement.
	it("leaves rows alone when the nearest ghost point is too far", () => {
		const merged = mergeGhost(primary, [{ t: T0 + 45 * MINUTE, [SINGLE_KEY]: 9 }], MINUTE)
		expect(merged.rows.every((row) => row[GHOST_KEY] === undefined)).toBe(true)
		expect(merged.divergence).toBeNull()
	})
})

describe("clipToDomain", () => {
	it("clips overhanging bands and drops the ones outside", () => {
		expect(
			clipToDomain(
				[
					{ x1: T0 - 10 * MINUTE, x2: T0 + 10 * MINUTE },
					{ x1: domain.max + MINUTE, x2: domain.max + 5 * MINUTE },
					{ x1: Number.NaN, x2: T0 },
				],
				domain,
			),
		).toEqual([{ x1: T0, x2: T0 + 10 * MINUTE }])
	})

	it("carries the band's own fields through", () => {
		expect(clipToDomain([{ x1: T0, x2: T0 + MINUTE, open: true }], domain)).toEqual([
			{ x1: T0, x2: T0 + MINUTE, open: true },
		])
	})
})
