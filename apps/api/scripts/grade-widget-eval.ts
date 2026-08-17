#!/usr/bin/env bun
/**
 * Grades agent-authored widget JSON against the real write path.
 *
 * Not a product script — an experiment harness for comparing what an agent
 * produces when reading the old hand-written docs versus the generated schema
 * doc. It runs exactly what `add_dashboard_widget` runs, in order:
 *
 *   1. decode through `DashboardWidgetSchema` (v3)
 *   2. `validateWidgetRenderability` — fatal blocks the write, warnings do not
 *
 * plus the task's own expectation (did they pick the panel type and unit the
 * request called for), which is the part no validator can check.
 *
 *   bun run --cwd apps/api scripts/grade-widget-eval.ts <submission.json>
 */
import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { DashboardWidgetSchema, WIDGET_TYPES, type PanelType } from "@maple/domain/http"
import { validateWidgetRenderability } from "@/mcp/lib/validate-widget-renderability"
import { TASKS } from "./widget-eval-tasks"

const decodeWidget = Schema.decodeUnknownSync(DashboardWidgetSchema)

interface Submission {
	readonly taskId: string
	readonly widget: unknown
}

interface Grade {
	readonly taskId: string
	readonly decodes: boolean
	readonly decodeError?: string
	readonly fatal: ReadonlyArray<string>
	readonly warnings: ReadonlyArray<string>
	readonly expectationFailures: ReadonlyArray<string>
}

const panelTypeOf = (widget: { visualization: string; display: { chartId?: string } }): PanelType => {
	if (widget.visualization !== "chart") return widget.visualization as PanelType
	const chartId = widget.display.chartId ?? ""
	if (chartId.includes("bar")) return "bar"
	if (chartId.includes("area")) return "area"
	return "line"
}

const grade = (submission: Submission): Grade => {
	const task = TASKS.find((candidate) => candidate.id === submission.taskId)
	if (!task) throw new Error(`unknown task: ${submission.taskId}`)

	let decoded: ReturnType<typeof decodeWidget>
	try {
		decoded = decodeWidget(submission.widget)
	} catch (error) {
		return {
			taskId: submission.taskId,
			decodes: false,
			decodeError: String(error).split("\n").slice(0, 3).join(" "),
			fatal: [],
			warnings: [],
			expectationFailures: ["not evaluated — the widget does not decode"],
		}
	}

	const panelType = panelTypeOf(decoded)
	const issues = validateWidgetRenderability({ widget: decoded, panelType })

	const expectationFailures: string[] = []
	if (task.expectPanelType && panelType !== task.expectPanelType) {
		expectationFailures.push(
			`panel type: wanted ${task.expectPanelType}, got ${panelType} (${WIDGET_TYPES[panelType].label})`,
		)
	}
	if (task.expectUnit !== undefined && decoded.display.unit !== task.expectUnit) {
		expectationFailures.push(
			`unit: wanted "${task.expectUnit}", got ${JSON.stringify(decoded.display.unit)}`,
		)
	}

	return {
		taskId: submission.taskId,
		decodes: true,
		fatal: issues.fatal,
		warnings: issues.warnings,
		expectationFailures,
	}
}

const submissions: ReadonlyArray<Submission> = JSON.parse(readFileSync(process.argv[2]!, "utf8"))
const grades = submissions.map(grade)

const clean = grades.filter((g) => g.decodes && g.fatal.length === 0 && g.expectationFailures.length === 0)

for (const g of grades) {
	const verdict = !g.decodes
		? "DECODE FAIL"
		: g.fatal.length > 0
			? "REJECTED"
			: g.expectationFailures.length > 0
				? "WRONG"
				: g.warnings.length > 0
					? "ok (warned)"
					: "CLEAN"
	console.log(`\n[${verdict}] ${g.taskId}`)
	if (g.decodeError) console.log(`  decode: ${g.decodeError}`)
	for (const f of g.fatal) console.log(`  fatal: ${f}`)
	for (const f of g.expectationFailures) console.log(`  wrong: ${f}`)
	for (const w of g.warnings) console.log(`  warn:  ${w}`)
}

console.log(
	`\n=== ${clean.length}/${grades.length} clean · ${grades.filter((g) => !g.decodes).length} decode failures · ${grades.filter((g) => g.decodes && g.fatal.length > 0).length} rejected · ${grades.filter((g) => g.decodes && g.fatal.length === 0 && g.expectationFailures.length > 0).length} wrong-but-saved`,
)
