import { Schema, SchemaGetter } from "effect"
import { splitTerminalClauses } from "./terminal-clauses"

// A ClickHouse statement as a value rather than a string.
//
// `SETTINGS` and `FORMAT` are statement terminators, so every stage that wants
// to add, replace, or nest one has to know where the body ends. Passing the
// parsed shape means that boundary is found once, at the edge, instead of being
// re-derived by each stage from text — which is how a driver ends up disagreeing
// with the executor about which clauses the statement already carries.

/**
 * The parsed form of a single ClickHouse statement.
 *
 * `body` never includes a terminal clause or a trailing `;`, so it is the only
 * part that is safe to nest inside another query — and the only part stable
 * enough to fingerprint, since the terminal clauses vary with the backend and
 * the cost profile rather than with the query.
 */
// `Schema.optional`, not `optionalKey`: an absent terminal clause is a real
// `undefined` in the parsed shape, and the codec encodes to SQL text rather than
// to JSON, so key presence never reaches a wire format.
export class ClickHouseStatement extends Schema.Class<ClickHouseStatement>(
	"@maple-dev/clickhouse-builder/ClickHouseStatement",
)({
	body: Schema.String,
	settings: Schema.optional(Schema.String),
	format: Schema.optional(Schema.String),
}) {
	/** The statement as SQL, terminal clauses in the order ClickHouse expects. */
	get text(): string {
		return renderStatement(this)
	}
}

export interface ClickHouseStatementFields {
	readonly body: string
	readonly settings?: string | undefined
	readonly format?: string | undefined
}

/**
 * Render a statement back to SQL. `SETTINGS` precedes `FORMAT` — some ClickHouse
 * gateways reject the inverse order with a syntax error — and clauses are
 * newline-separated so a body ending in a `--` comment cannot swallow them.
 */
export const renderStatement = (statement: ClickHouseStatementFields): string =>
	[statement.body, statement.settings, statement.format]
		.filter((part): part is string => part !== undefined && part !== "")
		.join("\n")

/** Parse SQL text into a statement. Total — any string has a body. */
export const parseStatement = (sql: string): ClickHouseStatement =>
	new ClickHouseStatement(splitTerminalClauses(sql))

/**
 * `SETTINGS`/`FORMAT` as a codec, for the boundaries that carry a statement as
 * text (persisted documents, wire payloads) but want the parsed shape in hand.
 * Decoding cannot fail; the round trip normalizes clause order and separators.
 */
export const ClickHouseStatementFromString = Schema.String.pipe(
	Schema.decodeTo(ClickHouseStatement, {
		decode: SchemaGetter.transform(splitTerminalClauses),
		encode: SchemaGetter.transform(renderStatement),
	}),
)

/** Replace the settings clause (or drop it with `undefined`). */
export const withSettings = (
	statement: ClickHouseStatement,
	settings: string | undefined,
): ClickHouseStatement =>
	new ClickHouseStatement({ body: statement.body, settings, format: statement.format })

/** Replace the format clause (or drop it with `undefined`). */
export const withFormat = (statement: ClickHouseStatement, format: string | undefined): ClickHouseStatement =>
	new ClickHouseStatement({ body: statement.body, settings: statement.settings, format })
