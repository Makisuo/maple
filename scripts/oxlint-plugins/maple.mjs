/**
 * Local oxlint JS plugin for repo-specific rules oxlint has no precise built-in for.
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

const NO_REACT_USE_EFFECT_MESSAGE =
	"Do not call React.useEffect directly. Derive values during render, act in event handlers, use a data-fetching library, or use useMountEffect for mount-scoped external synchronization."

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

const importedName = (specifier) => {
	if (specifier.imported?.type === "Identifier") return specifier.imported.name
	return specifier.imported?.value
}

const memberName = (member) => {
	if (!member.computed && member.property.type === "Identifier") return member.property.name
	if (member.computed && member.property.type === "Literal") return member.property.value
	return undefined
}

const noReactUseEffect = {
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Disallow direct React useEffect imports and calls without flagging namespace imports.",
		},
		messages: { noReactUseEffect: NO_REACT_USE_EFFECT_MESSAGE },
	},
	create(context) {
		// This module is the single implementation behind the repo's sanctioned
		// mount-only escape hatch. Keep the exception with the rule so alternate
		// runners that do not honor root overrides (notably React Doctor) agree.
		const filename = context.filename?.replaceAll("\\", "/")
		if (
			filename === "src/hooks/use-mount-effect.ts" ||
			filename?.endsWith("/src/hooks/use-mount-effect.ts")
		) {
			return {}
		}
		const reactNamespaces = new Set()
		return {
			ImportDeclaration(node) {
				if (node.source.value !== "react" || node.importKind === "type") return
				for (const specifier of node.specifiers) {
					if (specifier.type === "ImportSpecifier") {
						if (specifier.importKind !== "type" && importedName(specifier) === "useEffect") {
							context.report({ node: specifier, messageId: "noReactUseEffect" })
						}
						continue
					}
					reactNamespaces.add(specifier.local.name)
				}
			},
			MemberExpression(node) {
				if (node.object.type !== "Identifier") return
				if (!reactNamespaces.has(node.object.name)) return
				if (memberName(node) !== "useEffect") return
				context.report({ node, messageId: "noReactUseEffect" })
			},
		}
	},
}

export default {
	meta: { name: "maple" },
	rules: {
		"no-react-use-effect": noReactUseEffect,
		"no-record-string-any": noRecordStringAny,
	},
}
