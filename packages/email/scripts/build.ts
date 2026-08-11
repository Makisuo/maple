/// <reference types="@types/bun" />
/**
 * Compiles the Maizzle sources in `emails/` into the checked-in template
 * modules under `src/generated/`.
 *
 * Maizzle (PostHTML + Tailwind + juice) runs at BUILD time only: the runtime
 * renderers ship on Cloudflare Workers, where posthtml-expressions' use of
 * `new Function` is not allowed. So the compile step flattens every Tailwind
 * class into an inline style once, and the runtime just splices strings.
 *
 * Markers in the HTML sources (see emails/*.html):
 *
 *   <!--F:name--> … <!--/F:name-->   defines fragment `name` and removes the
 *                                    block from its container (fragments may
 *                                    nest; bodies are trimmed)
 *   <!--S:name-->                    a slot — becomes `[[#name]]` in the
 *                                    surrounding template
 *
 * Dynamic values are `[[token]]`. They survive the pipeline untouched (they are
 * valid CSS values inside `style="…"` and plain text everywhere else), so no
 * escaping dance is needed here — escaping happens at render time.
 *
 * Usage: bun run --cwd packages/email build [--check]
 */
import { render } from "@maizzle/framework"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Shared with the runtime renderers via the generated inline styles only. */
const MAPLE_COLORS = {
	bg: "#141210",
	surface: "#1e1b18",
	card: "#262320",
	elevated: "#2e2a26",
	border: "#3a342e",
	"border-subtle": "#302b26",
	fg: "#e8dfd3",
	"fg-muted": "#8a7f72",
	"fg-dim": "#5c554c",
	orange: "#e8872a",
	"orange-light": "#f0a050",
	"orange-dim": "#a05e1c",
	green: "#4aa865",
	"green-dim": "#2d6b3d",
	red: "#e85d4a",
	"red-dim": "#8b3530",
	blue: "#4a9eff",
	amber: "#e8a02a",
} as const

const FONT_MONO = ["'SFMono-Regular'", "'SF Mono'", "Menlo", "Consolas", "'Liberation Mono'", "monospace"]

interface Template {
	/** Source file under `emails/`. */
	readonly source: string
	/** Generated module under `src/generated/`. */
	readonly output: string
}

const TEMPLATES: ReadonlyArray<Template> = [
	{ source: "weekly-digest.html", output: "weekly-digest.ts" },
	{ source: "alert-notification.html", output: "alert-notification.ts" },
]

function maizzleConfig(html: string) {
	return {
		css: {
			tailwind: {
				content: [{ raw: html, extension: "html" }],
				theme: {
					extend: {
						colors: { maple: MAPLE_COLORS },
						fontFamily: { mono: FONT_MONO },
					},
				},
				corePlugins: { preflight: false },
			},
			// Flatten every class into a `style` attribute. What is left in the
			// <style> block afterwards is Tailwind output for utilities the
			// scanner guessed from prose (`table`, `block`, …) and matches no
			// element, so `stripStyleTags` drops the block wholesale below.
			inline: {},
			// Longhand→shorthand collapsing would rewrite the `border-bottom:
			// [[rowBorder]]` placeholders, so leave declarations as authored.
			shorthand: false,
		},
		attributes: {
			// Maizzle stamps `cellpadding/cellspacing/role` onto EVERY <table> by
			// default. That is wrong here: react-email only emitted them for its
			// Section/Container components (and the one explicit logo table), and
			// `cellspacing="0"` silently kills the browser's default 2px
			// border-spacing on the plain `w-full` layout tables — 4px of height
			// per table, ~37px of cumulative drift down the digest. The sources
			// author the presentational attributes on exactly the tables that had
			// them, so the transformer is disabled outright.
			//
			// `false` disables it, defaults included (`get(config,
			// 'attributes.add') !== false` in transformers/index.js); Maizzle's
			// published types only model the record form.
			add: false as unknown as Record<string, Record<string, string | number>>,
			// Classes have been inlined; keep the generated output lean.
			remove: [{ name: "class", value: /.*/ }],
		},
		// The sources are authored in their final shape: reformatting them would
		// change rendered whitespace, and readable output is the point of a
		// checked-in generated file. (Maizzle's other text transformers —
		// markdown, widow words, MSO — are opt-in per element and never fire.)
		prettify: false,
		minify: false,
		filters: false,
	}
}

interface Extracted {
	readonly page: string
	readonly fragments: ReadonlyMap<string, string>
}

const OPEN_FRAGMENT = /<!--F:([A-Za-z0-9_]+)-->/

function extractFragments(html: string, into: Map<string, string>): string {
	let result = html
	for (;;) {
		const open = OPEN_FRAGMENT.exec(result)
		if (!open) break
		const name = open[1]
		if (name === undefined) throw new Error("unreachable: fragment marker without a name")
		const close = `<!--/F:${name}-->`
		const end = result.indexOf(close, open.index)
		if (end < 0) throw new Error(`Unclosed fragment marker <!--F:${name}-->`)

		const body = extractFragments(result.slice(open.index + open[0].length, end), into).trim()
		const existing = into.get(name)
		if (existing !== undefined && existing !== body) {
			throw new Error(`Fragment "${name}" is defined twice with different markup`)
		}
		into.set(name, body)

		result = result.slice(0, open.index) + result.slice(end + close.length)
	}
	return result
}

/**
 * Everything is inlined by this point, so any surviving `<style>` rule matched
 * no element. Assert that before dropping the block, so a real regression in
 * inlining fails the build instead of silently shipping an unstyled email.
 */
function stripStyleTags(html: string): string {
	return html.replace(/[ \t]*<style>([\s\S]*?)<\/style>\n?/g, (_match, css: string) => {
		const inlinable = /(^|\})\s*\.[^{}]*\{/.test(css.replace(/\s+/g, " "))
		if (inlinable && /\.(m|p[xy]?|px|py|text|bg|border|rounded|font|leading|tracking)-/.test(css)) {
			throw new Error(`Uninlined Tailwind utilities left in <style>:\n${css.trim()}`)
		}
		return ""
	})
}

/** Slot markers become `[[#name]]`; blank lines left behind by markers go away. */
function finalize(html: string): string {
	return html
		.replace(/<!--S:([A-Za-z0-9_]+)-->/g, "[[#$1]]")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{2,}/g, "\n")
		.trim()
}

/** Fragments inherit the page's nesting indent; drop it so joins read cleanly. */
function dedent(html: string): string {
	const lines = html.split("\n")
	const rest = lines.slice(1).filter((line) => line.trim().length > 0)
	if (rest.length === 0) return html
	const indent = Math.min(...rest.map((line) => /^\t*/.exec(line)?.[0].length ?? 0))
	if (indent === 0) return html
	return [lines[0], ...lines.slice(1).map((line) => line.slice(indent))].join("\n")
}

function extract(html: string): Extracted {
	const fragments = new Map<string, string>()
	const page = finalize(extractFragments(stripStyleTags(html), fragments))
	return {
		page,
		fragments: new Map([...fragments].map(([name, body]) => [name, dedent(finalize(body))])),
	}
}

function asTemplateLiteral(value: string): string {
	return `\`${value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``
}

function emitModule(source: string, { page, fragments }: Extracted): string {
	const names = [...fragments.keys()].sort()
	const entries = names.map((name) => `\t${name}: ${asTemplateLiteral(fragments.get(name) ?? "")},`)
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
	const sourcePath = join(PACKAGE_ROOT, "emails", template.source)
	const html = await Bun.file(sourcePath).text()
	const { html: rendered } = await render(html, maizzleConfig(html))
	const contents = emitModule(template.source, extract(rendered))
	return { path: join(PACKAGE_ROOT, "src", "generated", template.output), contents }
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
