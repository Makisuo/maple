/// <reference types="@types/bun" />
/**
 * Compiles the Maizzle sources into the checked-in template modules under
 * `src/generated/`.
 *
 * Maizzle v6 renders Vue SFCs through a Vite SSR server, then runs the email
 * transformer pipeline (Tailwind → juice → …). None of that can run on
 * Cloudflare Workers, so it happens here, once, at build time: every Tailwind
 * class is flattened into an inline `style` and the result is emitted as plain
 * strings. At runtime `src/template.ts` only splices those strings.
 *
 * Two kinds of unit come out of a compile:
 *
 *   PAGE      — a root template from `emails/`, with `[[token]]` values and
 *               `[[#slot]]` holes.
 *   FRAGMENTS — one entry per component listed in a template's `fragments`
 *               map, each rendered standalone. A fragment is just a component
 *               file; its props default to their own `[[token]]` placeholders,
 *               so rendering it with no props yields the compiled shape the
 *               runtime fills in.
 *
 * Usage: bun run --cwd packages/email build [--check]
 */
import { render } from "@maizzle/framework"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

interface Template {
	/** Root SFC under `emails/`. */
	readonly source: string
	/** Generated module under `src/generated/`. */
	readonly output: string
	/**
	 * Fragment name → component name. The key is what the runtime looks up in
	 * `FRAGMENTS`; the value is the auto-imported component under `components/`.
	 */
	readonly fragments: Readonly<Record<string, string>>
}

const TEMPLATES: ReadonlyArray<Template> = [
	{
		source: "weekly-digest.vue",
		output: "weekly-digest.ts",
		fragments: {
			affectedServices: "MapleAffectedServices",
			breakdownRow: "MapleBreakdownRow",
			breakdownTable: "MapleBreakdownTable",
			barErr: "MapleBarErr",
			barOk: "MapleBarOk",
			biggestMover: "MapleBiggestMover",
			deltaPill: "MapleDeltaPill",
			envGroupHeader: "MapleEnvGroupHeader",
			errorRow: "MapleErrorRow",
			errorsSection: "MapleErrors",
			ingestionCell: "MapleIngestionCell",
			ingestionDelta: "MapleIngestionDelta",
			newBadge: "MapleNewBadge",
			scopeChip: "MapleScopeChip",
			scopeLine: "MapleScopeLine",
			serviceRequestsDelta: "MapleServiceDelta",
			serviceRow: "MapleServiceRow",
			servicesSection: "MapleServices",
			sparkBar: "MapleSparkBar",
			sparkLabel: "MapleSparkLabel",
			sparklineSection: "MapleSparkline",
			statusBanner: "MapleStatusBanner",
			summaryCard: "MapleSummaryCard",
		},
	},
	{
		source: "alert-notification.vue",
		output: "alert-notification.ts",
		fragments: { detailRow: "MapleDetailRow" },
	},
]

/**
 * Adjacencies that must compile with no whitespace between them — Vue turns any
 * newline between siblings into a rendered space, and a space here would show
 * up as a gap in the email. Cheap insurance against a stray line break in a
 * component template.
 */
const TIGHT_JOINS: ReadonlyArray<string> = [
	"</span>[[message]]", // NEW badge → error message
	"</span>[[name]]", // status dot → service name
	"[[index]].", // rank number → period
	"[[count]]×", // occurrence count → multiplication sign
	"[[#barOk]][[#barErr]]", // stacked sparkline segments
]

function maizzleConfig() {
	return {
		css: {
			// Flatten every class into a `style` attribute and drop the <style>
			// block; email clients (and our runtime) only deal with inline CSS.
			inline: { removeStyleTags: true },
			// Longhand→shorthand collapsing would rewrite the
			// `border-bottom: [[rowBorder]]` placeholders.
			shorthand: false,
		},
		html: {
			// Reformatting breaks inline runs apart — js-beautify happily puts
			// `<span>NEW</span>` and the message that follows it on separate
			// lines, which renders as an extra space. The sources are authored
			// in their final shape instead.
			format: false,
			minify: false,
			attributes: {
				// Classes have been inlined; keep the output lean.
				remove: [{ name: "class", value: /.*/ }],
			},
		},
		useTransformers: {
			// Maizzle stamps `cellpadding/cellspacing/role` onto EVERY <table>
			// by default. react-email only emitted them for its Section and
			// Container components (and the logo table), and `cellspacing="0"`
			// silently kills the browser's default 2px border-spacing on the
			// plain layout tables — 4px of height each, ~37px of cumulative
			// drift down the digest. The components author these attributes on
			// exactly the tables that had them.
			addAttributes: false,
		},
	}
}

/** `render()` prepends a doctype; fragments are markup, not documents. */
function stripDoctype(html: string): string {
	return html.replace(/^<!DOCTYPE[^>]*>\n?/i, "")
}

async function renderPage(source: string): Promise<string> {
	const { html } = await render(join(PACKAGE_ROOT, "emails", source), maizzleConfig())
	return html.trim()
}

async function renderFragment(component: string): Promise<string> {
	// The component is auto-imported from components/; MapleTailwind supplies
	// the stylesheet the inliner consumes, and is removed with it.
	const { html } = await render(`<template><MapleTailwind /><${component} /></template>`, maizzleConfig())
	return stripDoctype(html).trim()
}

/**
 * Every unitless `line-height` must be a ratio that is exact in binary, or the
 * used line box drifts off the pixel grid. lightningcss truncates Tailwind's
 * 20/14 to `1.42857`, which computes 19.99998px on a 14px font — Chrome rounds
 * that box down and the text sits a pixel high. The ratios the templates
 * actually want (1, 1.25, 1.375) all fit in three decimals; anything longer is
 * a truncated fraction that should have been pinned to px in MapleTailwind.vue.
 */
function assertExactLineHeights(label: string, html: string): void {
	for (const match of html.matchAll(/line-height:\s*([\d.]+)\s*[;"]/g)) {
		const value = match[1]
		if (value === undefined || value.includes("px")) continue
		const decimals = value.split(".")[1]?.length ?? 0
		if (decimals > 3) {
			throw new Error(
				`${label}: line-height "${value}" is a truncated ratio — pin it to px in MapleTailwind.vue`,
			)
		}
	}
}

function assertTightJoins(label: string, html: string): void {
	for (const join of TIGHT_JOINS) {
		if (!html.includes(join)) continue
		const loosened = join.replace(/(\]\]|>)(\[\[|[.×])/, "$1 $2")
		if (html.includes(loosened)) {
			throw new Error(`${label}: whitespace crept into the tight join "${join}"`)
		}
	}
}

function asTemplateLiteral(value: string): string {
	return `\`${value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``
}

function emitModule(source: string, page: string, fragments: ReadonlyMap<string, string>): string {
	const entries = [...fragments.keys()]
		.sort()
		.map((name) => `\t${name}: ${asTemplateLiteral(fragments.get(name) ?? "")},`)
	return `// GENERATED FILE — DO NOT EDIT.
//
// Compiled from packages/email/emails/${source} by Maizzle.
// Regenerate with: bun run --cwd packages/email build

/** The full page, with \`[[token]]\` values and \`[[#slot]]\` fragment holes. */
export const PAGE = ${asTemplateLiteral(page)}

/** Repeated, optional and nested regions spliced into the page's slots. */
export const FRAGMENTS = {
${entries.join("\n")}
} as const

export type FragmentName = keyof typeof FRAGMENTS
`
}

async function buildTemplate(template: Template): Promise<{ path: string; contents: string }> {
	const page = await renderPage(template.source)
	assertTightJoins(template.source, page)
	assertExactLineHeights(template.source, page)

	const fragments = new Map<string, string>()
	// Distinct components only — a component may back more than one fragment.
	const compiled = new Map<string, string>()
	for (const component of new Set(Object.values(template.fragments))) {
		compiled.set(component, await renderFragment(component))
	}
	for (const [name, component] of Object.entries(template.fragments)) {
		const html = compiled.get(component) ?? ""
		assertTightJoins(`${template.source}#${name}`, html)
		assertExactLineHeights(`${template.source}#${name}`, html)
		fragments.set(name, html)
	}

	return {
		path: join(PACKAGE_ROOT, "src", "generated", template.output),
		contents: emitModule(template.source, page, fragments),
	}
}

const check = process.argv.includes("--check")
let drifted = false

for (const template of TEMPLATES) {
	const { path, contents } = await buildTemplate(template)
	if (check) {
		const current = await Bun.file(path)
			.text()
			.catch(() => "")
		if (current !== contents) {
			drifted = true
			console.error(`✗ ${path} is out of date — run: bun run --cwd packages/email build`)
		} else {
			console.log(`✓ ${path}`)
		}
		continue
	}
	await Bun.write(path, contents)
	console.log(`✓ ${path} (${contents.length} chars)`)
}

if (drifted) process.exit(1)
