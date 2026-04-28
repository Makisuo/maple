import { Data } from "effect"

// ---------------------------------------------------------------------------
// ClickHouse string escaping
// ---------------------------------------------------------------------------

export function escapeClickHouseString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

// ---------------------------------------------------------------------------
// SQL Fragment AST
// ---------------------------------------------------------------------------

export type SqlFragment = Data.TaggedEnum<{
	/** Raw SQL string — no escaping. For ClickHouse-specific syntax. */
	Raw: { readonly sql: string }
	/** Auto-escaped string parameter: produces 'escaped_value' */
	Str: { readonly value: string }
	/** Integer parameter: produces the number as string, rounded */
	Int: { readonly value: number }
	/** Column or table identifier (unquoted — ClickHouse style) */
	Ident: { readonly name: string }
	/** A list of fragments joined by a separator (empty strings from When(false) are filtered) */
	Join: { readonly separator: string; readonly fragments: ReadonlyArray<SqlFragment> }
	/** An aliased expression: <expr> AS <alias> */
	As: { readonly expr: SqlFragment; readonly alias: string }
	/** A conditional fragment — included only when the condition is true */
	When: { readonly condition: boolean; readonly fragment: SqlFragment }
}>

const Frag = Data.taggedEnum<SqlFragment>()

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const raw = (sql: string): SqlFragment => Frag.Raw({ sql })
export const str = (value: string): SqlFragment => Frag.Str({ value })
export const int = (value: number): SqlFragment => Frag.Int({ value })
export const ident = (name: string): SqlFragment => Frag.Ident({ name })
export const join = (separator: string, ...fragments: ReadonlyArray<SqlFragment>): SqlFragment =>
	Frag.Join({ separator, fragments })
export const as_ = (expr: SqlFragment, alias: string): SqlFragment => Frag.As({ expr, alias })
export const when = (condition: boolean, fragment: SqlFragment): SqlFragment =>
	Frag.When({ condition, fragment })

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export const compile: (fragment: SqlFragment) => string = Frag.$match({
	Raw: ({ sql }) => sql,
	Str: ({ value }) => `'${escapeClickHouseString(value)}'`,
	Int: ({ value }) => String(Math.round(value)),
	Ident: ({ name }) => name,
	Join: ({ separator, fragments }) => fragments.map(compile).filter(Boolean).join(separator),
	As: ({ expr, alias }) => `${compile(expr)} AS ${alias}`,
	When: ({ condition, fragment }) => (condition ? compile(fragment) : ""),
})
