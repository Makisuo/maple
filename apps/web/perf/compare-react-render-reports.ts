import { readFile } from "node:fs/promises"

interface ReactRenderMetrics {
	commits: number
	totalActualDurationMs: number
	actualDurationP95Ms: number
	maxActualDurationMs: number
}

interface ReactRenderReport {
	label: string
	initial: ReactRenderMetrics
	metricRefresh: ReactRenderMetrics
	topologyChange: ReactRenderMetrics
	viewportPan: ReactRenderMetrics
	viewportPanCommitsPerFrame: number
	viewportPanActualDurationPerFrameMs: number
}

const [beforePath, afterPath] = process.argv.slice(2)
if (!beforePath || !afterPath) {
	console.error("usage: bun perf/compare-react-render-reports.ts <before-report.json> <after-report.json>")
	process.exit(1)
}

const readReport = async (path: string): Promise<ReactRenderReport> =>
	JSON.parse(await readFile(path, "utf8")) as ReactRenderReport

const [before, after] = await Promise.all([readReport(beforePath), readReport(afterPath)])
const percent = (previous: number, next: number) =>
	previous === 0 ? "n/a" : `${(((next - previous) / previous) * 100).toFixed(1)}%`

console.log(`React render comparison: ${before.label} -> ${after.label}`)
const rows = (["initial", "metricRefresh", "topologyChange", "viewportPan"] as const).flatMap((scenario) => {
	const previous = before[scenario]
	const next = after[scenario]
	return [
		{
			scenario,
			metric: "commits",
			before: previous.commits,
			after: next.commits,
			delta: percent(previous.commits, next.commits),
		},
		{
			scenario,
			metric: "total actual ms",
			before: previous.totalActualDurationMs.toFixed(2),
			after: next.totalActualDurationMs.toFixed(2),
			delta: percent(previous.totalActualDurationMs, next.totalActualDurationMs),
		},
		{
			scenario,
			metric: "p95 actual ms",
			before: previous.actualDurationP95Ms.toFixed(2),
			after: next.actualDurationP95Ms.toFixed(2),
			delta: percent(previous.actualDurationP95Ms, next.actualDurationP95Ms),
		},
		{
			scenario,
			metric: "max actual ms",
			before: previous.maxActualDurationMs.toFixed(2),
			after: next.maxActualDurationMs.toFixed(2),
			delta: percent(previous.maxActualDurationMs, next.maxActualDurationMs),
		},
	]
})
rows.push(
	{
		scenario: "viewportPan",
		metric: "commits / frame",
		before: before.viewportPanCommitsPerFrame.toFixed(2),
		after: after.viewportPanCommitsPerFrame.toFixed(2),
		delta: percent(before.viewportPanCommitsPerFrame, after.viewportPanCommitsPerFrame),
	},
	{
		scenario: "viewportPan",
		metric: "actual ms / frame",
		before: before.viewportPanActualDurationPerFrameMs.toFixed(2),
		after: after.viewportPanActualDurationPerFrameMs.toFixed(2),
		delta: percent(before.viewportPanActualDurationPerFrameMs, after.viewportPanActualDurationPerFrameMs),
	},
)
console.table(rows)
