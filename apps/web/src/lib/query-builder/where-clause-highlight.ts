/**
 * Tokenizer for where-clause syntax highlighting. Mirrors the grammar in
 * `@maple/domain/where-clause`: `key operator value` clauses joined by a
 * case-insensitive `AND`, with single-/double-quoted or bare values and the
 * operators `= != > < >= <= contains !contains exists !exists`.
 */

export type WhereClauseTokenType =
	| "key"
	| "operator"
	| "keyword"
	| "string"
	| "value"
	| "number"
	| "boolean"
	| "plain"

export interface WhereClauseToken {
	text: string
	type: WhereClauseTokenType
}

/** CSS variables from the Sugar High palette in styles.css. */
export const WHERE_CLAUSE_TOKEN_COLOR: Record<WhereClauseTokenType, string> = {
	key: "var(--sh-property)",
	operator: "var(--sh-sign)",
	keyword: "var(--sh-keyword)",
	string: "var(--sh-string)",
	value: "var(--sh-string)",
	number: "var(--sh-entity)",
	boolean: "var(--sh-entity)",
	plain: "var(--sh-identifier)",
}

const TOKEN_RE =
	/("[^"]*"?|'[^']*'?)|(!=|>=|<=|[=<>])|(!?[A-Za-z_][A-Za-z0-9_.:/-]*)|(-?\d+(?:\.\d+)?)|(\s+)|(.)/gy

export function tokenizeWhereClause(expression: string): WhereClauseToken[] {
	const tokens: WhereClauseToken[] = []
	// Tracks the last non-whitespace token so bare (unquoted) words after an
	// operator highlight as values rather than keys.
	let lastSignificant: WhereClauseTokenType | null = null

	const push = (text: string, type: WhereClauseTokenType) => {
		const last = tokens[tokens.length - 1]
		if (last && last.type === type) {
			last.text += text
		} else {
			tokens.push({ text, type })
		}
		if (type !== "plain" || text.trim().length > 0) {
			lastSignificant = type
		}
	}

	TOKEN_RE.lastIndex = 0
	let match: RegExpExecArray | null = TOKEN_RE.exec(expression)
	while (match !== null) {
		const [text, quoted, symbolOperator, word, number, whitespace] = match
		if (quoted !== undefined) {
			push(text, "string")
		} else if (symbolOperator !== undefined) {
			push(text, "operator")
		} else if (word !== undefined) {
			if (/^and$/i.test(word)) {
				push(text, "keyword")
			} else if (/^!?(contains|exists)$/i.test(word)) {
				push(text, "operator")
			} else if (/^(true|false)$/i.test(word)) {
				push(text, "boolean")
			} else if (lastSignificant === "operator") {
				push(text, "value")
			} else {
				push(text, "key")
			}
		} else if (number !== undefined) {
			push(text, "number")
		} else if (whitespace !== undefined) {
			const last = tokens[tokens.length - 1]
			if (last && last.type === "plain") {
				last.text += text
			} else {
				tokens.push({ text, type: "plain" })
			}
		} else {
			push(text, "plain")
		}
		match = TOKEN_RE.exec(expression)
	}

	return tokens
}
