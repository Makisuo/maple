// The one list of languages Maple documents. The sidebar, the docs index, the
// instrumentation overview and the `sdk` frontmatter enum all read from here,
// so adding a language is: a guide with `sdk: "<id>"`, a logo component wired
// into `LanguageLogo.astro`, and one entry below.
//
// Pure data — no Astro imports — so client islands can read it too.

export const LANGUAGE_IDS = [
	"effect",
	"node",
	"nextjs",
	"python",
	"go",
	"rust",
	"java",
	"kotlin",
	"csharp",
	"laravel",
] as const

export type LanguageId = (typeof LANGUAGE_IDS)[number]

export interface Language {
	id: LanguageId
	name: string
	/** Doc slug (without `/docs/`) of the language's entry page. */
	slug: string
	/** One line under the name on cards: the frameworks or runtimes the guide covers. */
	hint: string
}

export const LANGUAGES: readonly Language[] = [
	{
		id: "effect",
		name: "Effect",
		slug: "sdks/effect",
		hint: "Official SDK · Node, Bun, Deno, browsers, Workers",
	},
	{ id: "node", name: "Node.js", slug: "guides/instrumentation-nodejs", hint: "Express, Fastify, Hono" },
	{
		id: "nextjs",
		name: "Next.js",
		slug: "guides/instrumentation-nextjs",
		hint: "App Router, Pages Router, Edge",
	},
	{ id: "python", name: "Python", slug: "guides/instrumentation-python", hint: "FastAPI, Django" },
	{ id: "go", name: "Go", slug: "guides/instrumentation-go", hint: "net/http, gRPC, database/sql" },
	{ id: "rust", name: "Rust", slug: "guides/instrumentation-rust", hint: "tracing, Axum, reqwest" },
	{ id: "java", name: "Java", slug: "guides/instrumentation-java", hint: "Java agent, Spring Boot" },
	{ id: "kotlin", name: "Kotlin", slug: "guides/instrumentation-kotlin", hint: "Ktor, Spring Boot" },
	{ id: "csharp", name: "C# / .NET", slug: "guides/instrumentation-csharp", hint: "ASP.NET Core" },
	{
		id: "laravel",
		name: "Laravel",
		slug: "guides/instrumentation-laravel",
		hint: "PHP · Eloquent, queues",
	},
]

export const languageById = (id: LanguageId): Language => {
	const found = LANGUAGES.find((l) => l.id === id)
	if (!found) throw new Error(`Unknown language id: ${id}`)
	return found
}
