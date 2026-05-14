const KEYWORDS = new Set([
	"SELECT", "FROM", "WHERE", "GROUP", "BY", "ORDER", "LIMIT", "JOIN", "ON",
	"AS", "AND", "OR", "NOT", "NULL", "CASE", "WHEN", "THEN", "ELSE", "END",
	"WITH", "HAVING", "UNION", "ALL", "DISTINCT", "INNER", "LEFT", "RIGHT",
	"FULL", "OUTER", "ARRAY", "TUPLE", "ASOF", "FINAL", "PREWHERE", "SAMPLE",
	"SETTINGS", "FORMAT", "INSERT", "INTO", "VALUES", "IF", "BETWEEN", "IN",
	"LIKE", "ILIKE", "IS", "INTERVAL", "DESC", "ASC", "OFFSET", "USING",
	"CROSS", "ANY", "SEMI", "ANTI", "TRUE", "FALSE",
])

const TOKEN_RE =
	/(\/\*[\s\S]*?\*\/|--[^\n]*)|('(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*")|(\$__[a-zA-Z_][a-zA-Z0-9_]*)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([a-zA-Z_][a-zA-Z0-9_]*)/g

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
}

export function highlightSql(code: string): string {
	let out = ""
	let last = 0
	TOKEN_RE.lastIndex = 0
	let m: RegExpExecArray | null
	while ((m = TOKEN_RE.exec(code)) !== null) {
		if (m.index > last) out += escapeHtml(code.slice(last, m.index))
		const [full, comment, str, macro, num, ident] = m
		if (comment) {
			out += `<span class="text-muted-foreground/70 italic">${escapeHtml(comment)}</span>`
		} else if (str) {
			out += `<span class="text-severity-info">${escapeHtml(str)}</span>`
		} else if (macro) {
			out += `<span class="text-primary font-medium">${escapeHtml(macro)}</span>`
		} else if (num) {
			out += `<span class="text-amber-400">${escapeHtml(num)}</span>`
		} else if (ident) {
			if (KEYWORDS.has(ident.toUpperCase())) {
				out += `<span class="text-fuchsia-400">${escapeHtml(ident)}</span>`
			} else if (code.charAt(m.index + ident.length) === "(") {
				out += `<span class="text-cyan-400">${escapeHtml(ident)}</span>`
			} else {
				out += escapeHtml(ident)
			}
		} else {
			out += escapeHtml(full)
		}
		last = m.index + full.length
	}
	if (last < code.length) out += escapeHtml(code.slice(last))
	return out
}
