/**
 * Local oxlint JS plugin for repo-specific rules oxlint has no built-in for.
 *
 * Wired up in `.oxlintrc.json` via `jsPlugins`.
 *
 * `no-record-string-any` exists as its own rule (rather than leaning on
 * `typescript/no-explicit-any`, which flags the inner `any` anyway) so the worst
 * offender — an open key set whose values are also unchecked — can sit at `error`
 * while the broader `any` backlog is still being worked down.
 *
 * @see https://oxc.rs/docs/guide/usage/linter/js-plugins.html
 */

const MESSAGE =
	"Do not use `Record<string, any>` — an open key set whose values are unchecked too. If you genuinely cannot name the shape, `Record<string, unknown>` at least forces you to narrow before use; better still, model it (an interface, a Schema.Struct) or use a typed `ReadonlyRecord`/`Map`."

/** `{ [key: string]: any }` written as an index signature — same shape, same problem. */
const isStringToAnyIndexSignature = (node) =>
	node.members?.length === 1 &&
	node.members[0].type === "TSIndexSignature" &&
	node.members[0].parameters?.length === 1 &&
	node.members[0].parameters[0].typeAnnotation?.typeAnnotation?.type === "TSStringKeyword" &&
	node.members[0].typeAnnotation?.typeAnnotation?.type === "TSAnyKeyword"

const noRecordStringAny = {
	meta: {
		type: "problem",
		docs: {
			description: "Disallow `Record<string, any>` and its index-signature equivalent.",
		},
		messages: { noRecordStringAny: MESSAGE },
	},
	create(context) {
		// `<Output extends Record<string, any>>` is the builder-DSL idiom for "any object
		// shape" — `unknown` does not work in a constraint position. Parents are visited
		// before their children, so recording the constraint node here is enough.
		const constraints = new Set()
		const report = (node) => {
			if (constraints.has(node)) return
			context.report({ node, messageId: "noRecordStringAny" })
		}
		return {
			TSTypeParameter(node) {
				if (node.constraint) constraints.add(node.constraint)
			},
			TSTypeReference(node) {
				if (node.typeName?.type !== "Identifier" || node.typeName.name !== "Record") return
				const params = node.typeArguments?.params
				if (params?.length !== 2) return
				if (params[0].type !== "TSStringKeyword" || params[1].type !== "TSAnyKeyword") return
				report(node)
			},
			TSTypeLiteral(node) {
				if (!isStringToAnyIndexSignature(node)) return
				report(node)
			},
		}
	},
}

export default {
	meta: { name: "maple" },
	rules: {
		"no-record-string-any": noRecordStringAny,
	},
}
