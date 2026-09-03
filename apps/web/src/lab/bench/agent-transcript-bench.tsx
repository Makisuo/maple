import { Profiler, useMemo, useState, type ProfilerOnRenderCallback } from "react"

import type { AiSessionGenAiValues, AiSessionSpan } from "@maple/domain/http"

import { SessionViews } from "@/components/agent-sessions/session-detail/session-views"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { buildSessionSummary } from "@/lib/agent-sessions/session-summary"
import { buildSessionTurns } from "@/lib/agent-sessions/session-turns"
import { agentSpan, llmSpan, toolSpan, userMessages } from "@/lib/agent-sessions/span-test-support"

/**
 * The transcript view over a session big enough to hurt: tens of turns, every
 * call carrying its prompt and reply, every tool call carrying a result that
 * runs to hundreds of kilobytes. The list virtualizes, so what this measures
 * is the cost of a ROW — what mounting one puts in the DOM, and what it costs
 * to mount it again after it scrolled out.
 *
 * `window.__transcriptBench` is the harness `perf/agent-transcript.perf.spec.ts`
 * drives: `runScroll()` sweeps the page scroller top to bottom one frame per
 * step and reports frame timing, long tasks and React commit work, alongside
 * how much DOM the mounted rows hold.
 */

interface TranscriptBenchMetrics {
	frames: number
	frameP95Ms: number
	droppedFrames: number
	longTasks: number
	totalBlockingMs: number
	reactCommits: number
	reactDurationMs: number
	reactMaxCommitMs: number
	/** Rows the virtualizer has mounted once the sweep ends. */
	mountedRows: number
	/** Elements under the list once the sweep ends — the DOM the rows cost. */
	listNodes: number
	/** The most elements any one mounted row holds. */
	maxRowNodes: number
}

interface TranscriptBenchHarness {
	ready: boolean
	/** How long the first commit that painted the list took. */
	mountCommitMs: number
	runScroll: (steps?: number) => Promise<TranscriptBenchMetrics>
	countDom: () => Pick<TranscriptBenchMetrics, "mountedRows" | "listNodes" | "maxRowNodes">
}

declare global {
	interface Window {
		__transcriptBench?: TranscriptBenchHarness
	}
}

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

const SECOND = 1000
const TURN_GAP_MS = 90 * SECOND
const VENDOR_ID = "claude_agent_sdk"

/** Deterministic, so two runs of the bench render the same bytes. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const WORDS =
	"retry backoff webhook idempotency charge invoice customer ledger dispatch queue partition replica latency p95 deploy rollback config jitter attempt handler schema migration index cursor".split(
		" ",
	)

function prose(random: () => number, words: number): string {
	const out: string[] = []
	for (let i = 0; i < words; i++) {
		const word = WORDS[Math.floor(random() * WORDS.length)]!
		out.push(i > 0 && i % 17 === 0 ? `${word}.` : word)
	}
	return out.join(" ")
}

const SYSTEM_INSTRUCTIONS = [
	"You are a careful coding agent working in a payments monorepo.",
	"",
	"## Rules",
	"",
	...Array.from({ length: 160 }, (_, i) => `${i + 1}. Rule ${i + 1}: ${prose(mulberry32(i), 14)}`),
].join("\n")

function markdownReply(random: () => number, paragraphs: number): string {
	const blocks: string[] = []
	for (let p = 0; p < paragraphs; p++) {
		blocks.push(prose(random, 40 + Math.floor(random() * 50)))
		if (p % 3 === 1) {
			blocks.push(
				["```ts", ...Array.from({ length: 12 }, (_, i) => `const step${i} = retry(${i}, { jitter: ${random().toFixed(3)} })`), "```"].join(
					"\n",
				),
			)
		}
		if (p % 4 === 2) {
			blocks.push(Array.from({ length: 5 }, (_, i) => `- **item ${i}** — ${prose(random, 9)}`).join("\n"))
		}
	}
	return blocks.join("\n\n")
}

/** A warehouse-shaped result: rows of one query, sized by `rows`. */
function jsonResult(random: () => number, rows: number): Record<string, unknown> {
	return {
		query_id: `q_${Math.floor(random() * 1e9).toString(16)}`,
		elapsed_ms: Math.round(random() * 4000),
		rows: Array.from({ length: rows }, (_, i) => ({
			t: new Date(Date.UTC(2026, 7, 25, 13, 50) + i * 60_000).toISOString(),
			service: `checkout-api-${i % 7}`,
			p95_ms: Number((80 + random() * 900).toFixed(2)),
			count: Math.floor(random() * 5000),
			error_rate: Number((random() * 0.05).toFixed(4)),
			region: random() > 0.5 ? "eu-central-1" : "us-east-1",
		})),
	}
}

function textResult(random: () => number, lines: number): string {
	return Array.from({ length: lines }, (_, i) => `${String(i + 1).padStart(4, " ")}  ${prose(random, 10)}`).join("\n")
}

function usage(inputTokens: number, outputTokens: number): AiSessionGenAiValues {
	return {
		usageInputTokens: inputTokens,
		usageOutputTokens: outputTokens,
		usageCost: inputTokens * 0.000003 + outputTokens * 0.000015,
	}
}

/**
 * `turns` turns, each: one agent span, three model calls (the last one the
 * closing reply, the others each dispatching a tool), and two tool spans whose
 * results run from ten kilobytes to a few hundred.
 */
export function buildLargeSessionFixture(turns: number, seed = 1): readonly AiSessionSpan[] {
	const random = mulberry32(seed)
	const spans: AiSessionSpan[] = []
	const tools = ["run_sql", "read_file", "search_traces", "grep_repo"]

	for (let turn = 0; turn < turns; turn++) {
		const traceId = `trace-big-${turn}`
		const agentId = `big-${turn}-agent`
		const t = turn * TURN_GAP_MS
		spans.push(
			agentSpan({
				spanId: agentId,
				traceId,
				startMs: t,
				durationMs: 60 * SECOND,
				agentName: "coding-agent",
				vendorId: VENDOR_ID,
			}),
		)
		const prompt = `${prose(random, 30 + Math.floor(random() * 600))}\n\n\`\`\`\n${textResult(random, 8)}\n\`\`\``
		for (let call = 0; call < 3; call++) {
			const closing = call === 2
			const tool = closing ? undefined : tools[(turn + call) % tools.length]!
			const callId = `big-${turn}-${call}`
			spans.push(
				llmSpan({
					spanId: `big-${turn}-l${call}`,
					parentSpanId: agentId,
					traceId,
					startMs: t + call * 20 * SECOND,
					durationMs: 4 * SECOND,
					spanName: "chat claude-opus-5",
					model: "claude-opus-5",
					ttftSeconds: 0.6,
					vendorId: VENDOR_ID,
					genAi: {
						...usage(20_000 + turn * 3_000 + call * 4_000, 800 + call * 400),
						systemInstructions: SYSTEM_INSTRUCTIONS,
						inputMessages: call === 0 ? userMessages(prompt) : undefined,
						outputMessages: [
							{
								role: "assistant",
								parts: [
									...(call % 2 === 0
										? [{ type: "reasoning", content: prose(random, 200 + Math.floor(random() * 200)) }]
										: []),
									{ type: "text", content: markdownReply(random, closing ? 6 + Math.floor(random() * 6) : 1) },
									...(tool === undefined
										? []
										: [
												{
													type: "tool_call",
													id: callId,
													name: tool,
													arguments: {
														sql: `SELECT * FROM traces WHERE turn = ${turn} AND call = ${call}`,
														filters: Array.from({ length: 12 }, (_, i) => ({ key: `attr.${i}`, value: prose(random, 3) })),
													},
												},
											]),
								],
							},
						],
						responseFinishReasons: [closing ? "stop" : "tool_use"],
					},
				}),
			)
			if (tool !== undefined) {
				const textual = (turn * 3 + call) % 6 === 0
				spans.push(
					toolSpan({
						spanId: `big-${turn}-t${call}`,
						parentSpanId: agentId,
						traceId,
						startMs: t + call * 20 * SECOND + 5 * SECOND,
						durationMs: 2 * SECOND,
						serviceName: "warehouse-mcp",
						toolName: tool,
						vendorId: VENDOR_ID,
						genAi: {
							toolCallId: callId,
							toolCallArguments: {
								sql: `SELECT * FROM traces WHERE turn = ${turn} AND call = ${call}`,
								filters: Array.from({ length: 12 }, (_, i) => ({ key: `attr.${i}`, value: prose(random, 3) })),
							},
							toolCallResult: textual
								? textResult(random, 300 + Math.floor(random() * 300))
								: jsonResult(random, 80 + Math.floor(random() * 1_200)),
						},
					}),
				)
			}
		}
	}
	return spans
}

/* -------------------------------------------------------------------------- */
/* Bench                                                                      */
/* -------------------------------------------------------------------------- */

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))] ?? 0
}

/** The virtualizer's row wrappers — by slot, not `data-index`, which the tab
 *  panel around the list carries too. */
const LIST_SELECTOR = '[data-transcript-bench] [data-slot="transcript-row"]'

function countDom(): Pick<TranscriptBenchMetrics, "mountedRows" | "listNodes" | "maxRowNodes"> {
	const rows = Array.from(document.querySelectorAll(LIST_SELECTOR))
	let listNodes = 0
	let maxRowNodes = 0
	for (const row of rows) {
		const nodes = row.querySelectorAll("*").length
		listNodes += nodes
		maxRowNodes = Math.max(maxRowNodes, nodes)
	}
	return { mountedRows: rows.length, listNodes, maxRowNodes }
}

export function AgentTranscriptBench({ turns }: { turns: number }) {
	const spans = useMemo(() => buildLargeSessionFixture(turns), [turns])
	const sessionTurns = useMemo(() => buildSessionTurns(spans), [spans])
	const summary = useMemo(() => buildSessionSummary({ spans, turns: sessionTurns }), [spans, sessionTurns])
	const [selectedSpanId, setSelectedSpanId] = useState<string | undefined>(undefined)

	const recorder = useMemo(() => {
		let commits = 0
		let duration = 0
		let maxCommit = 0
		let firstCommit: number | undefined
		const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
			commits++
			duration += actualDuration
			maxCommit = Math.max(maxCommit, actualDuration)
			firstCommit ??= actualDuration
		}
		return {
			onRender,
			reset: () => {
				commits = 0
				duration = 0
				maxCommit = 0
			},
			snapshot: () => ({ commits, duration, maxCommit }),
			firstCommit: () => firstCommit ?? 0,
		}
	}, [])

	useMountEffect(() => {
		const harness: TranscriptBenchHarness = {
			ready: false,
			mountCommitMs: 0,
			countDom,
			runScroll: async (steps = 160) => {
				const scroller = document.querySelector<HTMLElement>('[data-transcript-bench] [data-slot="page-scroll-area"]')
				if (!scroller) throw new Error("Transcript benchmark scroller not found")
				recorder.reset()
				const frames: number[] = []
				const longTasks: PerformanceEntry[] = []
				let previous = performance.now()
				let frameHandle = 0
				let running = true
				let observer: PerformanceObserver | undefined
				try {
					observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries()))
					observer.observe({ entryTypes: ["longtask"] })
				} catch {
					// Firefox/WebKit do not expose Long Tasks; frame and React metrics remain valid.
				}
				const sample = (now: number) => {
					frames.push(now - previous)
					previous = now
					if (running) frameHandle = requestAnimationFrame(sample)
				}
				frameHandle = requestAnimationFrame(sample)
				for (let step = 0; step <= steps; step++) {
					// Re-read every step: measured rows grow the list as the sweep goes.
					const maxScroll = scroller.scrollHeight - scroller.clientHeight
					scroller.scrollTop = maxScroll * (step / steps)
					await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
				}
				await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
				running = false
				cancelAnimationFrame(frameHandle)
				observer?.disconnect()
				const react = recorder.snapshot()
				return {
					frames: frames.length,
					frameP95Ms: percentile(frames, 95),
					droppedFrames: frames.filter((duration) => duration > (1000 / 60) * 1.5).length,
					longTasks: longTasks.length,
					totalBlockingMs: longTasks.reduce((sum, entry) => sum + Math.max(0, entry.duration - 50), 0),
					reactCommits: react.commits,
					reactDurationMs: react.duration,
					reactMaxCommitMs: react.maxCommit,
					...countDom(),
				}
			},
		}
		window.__transcriptBench = harness
		const poll = () => {
			if (document.querySelector(LIST_SELECTOR) !== null) {
				harness.mountCommitMs = recorder.firstCommit()
				harness.ready = true
				return
			}
			requestAnimationFrame(poll)
		}
		requestAnimationFrame(poll)
		return () => {
			if (window.__transcriptBench === harness) delete window.__transcriptBench
		}
	})

	return (
		<div data-transcript-bench className="flex h-screen flex-col bg-background text-foreground">
			<div className="flex shrink-0 items-center gap-3 border-border border-b px-4 py-2 text-xs">
				<span className="font-semibold">Transcript bench</span>
				<span className="text-muted-foreground">
					{turns} turns · {summary.spanCount} spans ·{" "}
					{(JSON.stringify(spans).length / 1_048_576).toFixed(1)} MB of spans
				</span>
			</div>
			{/* The same scroller slot the page gives the list, so the virtualizer
			    takes the production path rather than its bare-render fallback. */}
			<div data-slot="page-scroll-area" className="flex min-h-0 flex-1 flex-col overflow-auto px-4">
				<div className="flex min-h-64 shrink-0 grow flex-col">
					<Profiler id="agent-transcript-bench" onRender={recorder.onRender}>
						<SessionViews
							view="transcript"
							onViewChange={() => {}}
							turns={sessionTurns}
							summary={summary}
							paging={undefined}
							totals={undefined}
							selectedSpanId={selectedSpanId}
							onSelectSpan={setSelectedSpanId}
						/>
					</Profiler>
				</div>
			</div>
		</div>
	)
}
