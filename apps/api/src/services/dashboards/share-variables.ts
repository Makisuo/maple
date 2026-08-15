/**
 * Validating the one input a share link's holder genuinely controls.
 *
 * A viewer may change dashboard variable values — that is the point of a live
 * share rather than a snapshot. But those values are interpolated into stored
 * query params, and `interpolateWhereClause` in
 * `@maple/query-engine/dashboard-variables` substitutes them **raw**: only the
 * `sql` key gets escaping, because in the authenticated app the person setting
 * a variable is the same person who could edit the where-clause anyway.
 *
 * On a share link that assumption is gone. The holder is not the author, so an
 * unchecked value lets them rewrite the clause grammar and widen a filter the
 * author pinned — a board published as "service = frontend" turned into every
 * service in the org. Org isolation still holds regardless (`validateTenantScope`
 * is independent and unaffected), so this is a within-org confidentiality
 * boundary, not a cross-tenant one. It still matters: the whole proposition of
 * a scoped share is that the scope holds.
 *
 * Two defences, deliberately layered:
 *
 *   1. Enumerated variables must name a value the stored definition allows.
 *      Exhaustive, and the strong one.
 *   2. Free-text variables get a conservative charset AND a clause-count
 *      assertion. The charset is a guess about a grammar this module does not
 *      own; the clause count is a direct check on the thing that must not
 *      change. Either alone would be weaker than both.
 */
import { splitWhereClause } from "@maple/domain/where-clause"
import { ALL_VALUE, type ResolvedVariable, type VariableValues } from "@maple/query-engine"
import { ShareVariableInvalidError } from "@maple/domain/http"
import { Effect } from "effect"

/**
 * Characters a free-text variable value may contain.
 *
 * Deliberately narrow: service names, environments, hostnames, HTTP paths and
 * status codes all fit, and nothing here can open a quote, start a comment, or
 * introduce a boolean operator. A value that needs more than this is a sign the
 * dashboard wants an enumerated variable, not a wider allowlist.
 *
 * **No space.** Every other excluded character is obvious, but the space is the
 * one that matters most: with it, `a AND b` is a perfectly ordinary-looking
 * value that turns one predicate into two. Filter tokens do not contain spaces,
 * so excluding it costs nothing real and closes the whole class.
 */
const TEXTBOX_ALLOWED = /^[A-Za-z0-9._:/@\-]{0,128}$/

export interface ShareVariableDefinition {
	readonly name: string
	readonly type: "query" | "custom" | "textbox"
	readonly includeAll?: boolean
	readonly defaultValue?: string
	readonly options?: ReadonlyArray<{ readonly value: string }>
}

const invalid = (variableName: string) =>
	Effect.fail(
		new ShareVariableInvalidError({
			message: "That value isn't allowed for this dashboard variable.",
			variableName,
		}),
	)

/**
 * A submitted value cannot change how many clauses a where-clause has.
 *
 * The direct expression of the property that matters. A value containing
 * ` AND `, or one that closes a quote and opens a new predicate, changes the
 * clause count; a legitimate service name never does. Checked against the
 * *template* rather than a fixed number, so a board whose clause already
 * contains a quoted space is not falsely rejected.
 */
export const preservesClauseStructure = (template: string, value: string): boolean => {
	const before = splitWhereClause(template).length
	const after = splitWhereClause(template.replaceAll(/\$\{?[A-Za-z][A-Za-z0-9_]*\}?/g, value)).length
	return before === after
}

/**
 * Resolve the values a viewer submitted against the board's own definitions.
 *
 * Returns the `VariableValues` the interpolator consumes, built from the stored
 * definitions rather than from the submission — the submission only chooses
 * *which* allowed value, never introduces a variable of its own.
 */
export const resolveShareVariables = Effect.fn("resolveShareVariables")(function* (
	definitions: ReadonlyArray<ShareVariableDefinition>,
	submitted: Readonly<Record<string, string>>,
	/** Option lists for `query` variables, resolved by the caller. */
	queryOptions: Readonly<Record<string, ReadonlyArray<string>>> = {},
	/**
	 * Every where-clause on the board that a variable could land in.
	 *
	 * The charset above already makes structural injection impossible, so this is
	 * the second layer: a direct assertion on the property that must hold, rather
	 * than a guess about which characters could break a grammar this module does
	 * not own. If the charset is ever loosened, this is what still catches it.
	 */
	whereClauseTemplates: ReadonlyArray<string> = [],
) {
	const resolved: Record<string, ResolvedVariable> = {}

	for (const definition of definitions) {
		const value = submitted[definition.name] ?? definition.defaultValue
		if (value === undefined) continue

		const options =
			definition.type === "custom"
				? (definition.options ?? []).map((option) => option.value)
				: definition.type === "query"
					? [...(queryOptions[definition.name] ?? [])]
					: []

		if (value === ALL_VALUE) {
			// "All" is only selectable when the board offers it. Otherwise it is a
			// hand-crafted way to drop the filter entirely, which is exactly the
			// widening this module exists to prevent.
			if (definition.includeAll !== true) return yield* invalid(definition.name)
			resolved[definition.name] = { value, isAll: true, options }
			continue
		}

		switch (definition.type) {
			case "custom":
			case "query": {
				if (!options.includes(value)) return yield* invalid(definition.name)
				break
			}
			case "textbox": {
				if (!TEXTBOX_ALLOWED.test(value)) return yield* invalid(definition.name)
				const rewritesAClause = whereClauseTemplates.some(
					(template) => !preservesClauseStructure(template, value),
				)
				if (rewritesAClause) return yield* invalid(definition.name)
				break
			}
		}

		resolved[definition.name] = { value, isAll: false, options }
	}

	// Names the board does not declare are dropped rather than rejected: a
	// hand-edited or stale URL carrying `?var-removed=x` should render the
	// dashboard, not a 400.
	return resolved satisfies VariableValues
})

export const __testables = { TEXTBOX_ALLOWED }
