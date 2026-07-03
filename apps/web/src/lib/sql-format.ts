/**
 * Conservative, dependency-free SQL pretty-printer tuned for the ClickHouse
 * dialect Maple writes (Grafana-style `$__macros`, `Map['key']` access, the
 * double-call `quantile(0.95)(x)` form). It reflows a single statement so the
 * major clauses, SELECT columns, and WHERE conditions land on their own lines —
 * nothing more. It never rewrites the query's meaning: string literals,
 * comments, macros, and bracketed access are treated as atomic, and any failure
 * falls back to the original text.
 *
 * Pairs with `tokenizeSql` (sql-highlight.ts): format first, then highlight the
 * formatted string.
 */

const INDENT = "  "

/** Keywords that start a top-level clause and force a line break before them. */
const CLAUSE_BREAK = new Set([
	"SELECT",
	"FROM",
	"WHERE",
	"PREWHERE",
	"GROUP",
	"ORDER",
	"HAVING",
	"LIMIT",
	"UNION",
	"SETTINGS",
	"JOIN",
	"INNER",
	"LEFT",
	"RIGHT",
	"FULL",
	"CROSS",
])

/** Join modifiers that chain into one `LEFT OUTER JOIN`-style line, not a break each. */
const JOIN_CHAIN = new Set(["INNER", "LEFT", "RIGHT", "FULL", "CROSS", "OUTER", "JOIN"])

/**
 * Reserved words — used to tell `count(` (function, no space) from `IN (`
 * (keyword, keep the space). Superset of CLAUSE_BREAK plus operators/modifiers.
 */
const KEYWORDS = new Set([
	...CLAUSE_BREAK,
	"BY",
	"ON",
	"AS",
	"AND",
	"OR",
	"NOT",
	"NULL",
	"IN",
	"IS",
	"LIKE",
	"ILIKE",
	"BETWEEN",
	"INTERVAL",
	"CASE",
	"WHEN",
	"THEN",
	"ELSE",
	"END",
	"DISTINCT",
	"ALL",
	"ANY",
	"ASC",
	"DESC",
	"USING",
	"WITH",
	"OUTER",
	"ARRAY",
	"TUPLE",
	"ASOF",
	"FINAL",
	"SAMPLE",
	"FORMAT",
	"VALUES",
	"OFFSET",
	"SEMI",
	"ANTI",
	"TRUE",
	"FALSE",
])

type TokType = "comment" | "string" | "macro" | "op" | "num" | "word" | "punct" | "other"

interface Tok {
	type: TokType
	value: string
	/** Uppercased value for word/op/punct comparisons; "" for the rest. */
	up: string
}

const LEX =
	/(\/\*[\s\S]*?\*\/|--[^\n]*)|('(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*")|(\$__[A-Za-z_][A-Za-z0-9_]*)|([<>=!]=|<>|->|::|\|\|)|(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([(),[\].;])|([^\s])/g

function lex(sql: string): Tok[] {
	const toks: Tok[] = []
	LEX.lastIndex = 0
	let m: RegExpExecArray | null
	while ((m = LEX.exec(sql)) !== null) {
		const [, comment, str, macro, op, num, word, ws, punct, other] = m
		if (ws !== undefined) continue
		if (comment !== undefined) toks.push({ type: "comment", value: comment, up: "" })
		else if (str !== undefined) toks.push({ type: "string", value: str, up: "" })
		else if (macro !== undefined) toks.push({ type: "macro", value: macro, up: "" })
		else if (op !== undefined) toks.push({ type: "op", value: op, up: op })
		else if (num !== undefined) toks.push({ type: "num", value: num, up: "" })
		else if (word !== undefined) toks.push({ type: "word", value: word, up: word.toUpperCase() })
		else if (punct !== undefined) toks.push({ type: "punct", value: punct, up: punct })
		else if (other !== undefined) toks.push({ type: "other", value: other, up: other })
	}
	return toks
}

/** A name that takes a call/index with no space before its `(` or `[`. */
function isCallable(t: Tok | undefined): boolean {
	if (!t) return false
	if (t.type === "macro") return true
	if (t.type === "word") return !KEYWORDS.has(t.up)
	return false
}

function clauseFor(up: string): string {
	switch (up) {
		case "SELECT":
			return "select"
		case "WHERE":
		case "PREWHERE":
			return "where"
		case "HAVING":
			return "having"
		case "FROM":
			return "from"
		case "GROUP":
			return "group"
		case "ORDER":
			return "order"
		case "INNER":
		case "LEFT":
		case "RIGHT":
		case "FULL":
		case "CROSS":
		case "JOIN":
			return "join"
		case "UNION":
			return "union"
		case "LIMIT":
			return "limit"
		case "SETTINGS":
			return "settings"
		default:
			return "other"
	}
}

/** Inline spacing between two adjacent tokens (no line break involved). */
function spacer(prev: Tok, cur: Tok): string {
	const cv = cur.value
	const pv = prev.value
	if (cv === "," || cv === ";" || cv === ")" || cv === "]" || cv === ".") return ""
	if (pv === "(" || pv === "[" || pv === ".") return ""
	if (cur.type === "op" && cur.value === "::") return ""
	if (prev.type === "op" && prev.value === "::") return ""
	if ((cv === "(" || cv === "[") && (isCallable(prev) || pv === ")" || pv === "]")) return ""
	return " "
}

export function formatSql(sql: string): string {
	try {
		const input = sql.trim()
		if (!input) return input
		const toks = lex(input)
		if (toks.length === 0) return input

		let out = ""
		let depth = 0 // () nesting
		let bracket = 0 // [] nesting
		let clause = ""
		let prev: Tok | undefined

		for (const t of toks) {
			const top = depth === 0 && bracket === 0

			const isClauseBreak =
				t.type === "word" &&
				top &&
				CLAUSE_BREAK.has(t.up) &&
				!(JOIN_CHAIN.has(t.up) && prev?.type === "word" && JOIN_CHAIN.has(prev.up))

			const isAndOrBreak =
				t.type === "word" &&
				top &&
				(t.up === "AND" || t.up === "OR") &&
				(clause === "where" || clause === "having" || clause === "on")

			const afterSelectComma =
				prev?.type === "punct" && prev.value === "," && clause === "select" && top

			const firstSelectItem =
				clause === "select" &&
				prev?.type === "word" &&
				(prev.up === "SELECT" || prev.up === "DISTINCT") &&
				!(t.type === "word" && t.up === "DISTINCT")

			let sep: string
			if (!prev) sep = ""
			else if (prev.type === "comment" && prev.value.startsWith("--")) sep = "\n"
			else if (isClauseBreak) sep = "\n"
			else if (isAndOrBreak || afterSelectComma || firstSelectItem) sep = `\n${INDENT}`
			else sep = spacer(prev, t)

			out += sep + t.value

			if (t.type === "word" && top) {
				if (isClauseBreak) clause = clauseFor(t.up)
				else if (t.up === "ON") clause = "on"
			}

			if (t.type === "punct") {
				if (t.value === "(") depth++
				else if (t.value === ")") depth = Math.max(0, depth - 1)
				else if (t.value === "[") bracket++
				else if (t.value === "]") bracket = Math.max(0, bracket - 1)
			}

			prev = t
		}

		const result = out.trim()
		return result.length > 0 ? result : input
	} catch {
		return sql.trim()
	}
}
