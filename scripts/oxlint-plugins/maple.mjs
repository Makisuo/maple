/**
 * Local oxlint JS plugin for repo-specific rules oxlint has no precise built-in for.
 *
 * Wired up in `.oxlintrc.json` via `jsPlugins`.
 *
 * `no-ordie-compiled-query` guards the seam this repo settled on for compiled
 * queries: `CH.compile` reports in the Effect channel, and the executor is the
 * one place that decides a compile failure is a defect. Killing it at the call
 * site instead is both noise and, where a request value reaches a param, a 500
 * where the route owed a 400.
 *
 * `no-try-catch` is the syntax half of the repo's Effect-errors convention: oxlint
 * has no `no-restricted-syntax`, so banning a statement kind takes a plugin rule.
 *
 * `no-effect-die` is the other half of that convention: the try/catch ban keeps
 * failures out of exceptions, and this keeps them out of defects. Every one of
 * the 26 production sites at the time it landed was a legitimate defect, so it
 * cleans nothing up — it exists so the next one has to argue for itself.
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

const NO_ORDIE_COMPILED_QUERY_MESSAGE =
	"Do not `Effect.orDie` a compile. Hand the unrun Effect to the warehouse — `warehouse.compiledQuery(tenant, CH.compile(q, params), …)` — and let `resolveCompiledQuery` make that call once, at the seam. If a request value can reach a param, constrain it at the HTTP boundary or `Effect.mapError` it into a failure the route returns."

const COMPILE_NAMES = new Set(["compile", "compileUnion", "compileCH", "compileCHUnsafe"])

/** Modules a bare `compile` can only have come from. */
const COMPILE_MODULES = /(clickhouse-builder|query-engine\/ch)$/

/**
 * A call to a compile entry point.
 *
 * `x.compile(…)` matches on the property name — that covers `CH.compile` and a
 * query definition's own `compile` field. A BARE `compile(…)` only matches when
 * it was imported from the builder: `compile` is also the parameter name every
 * `compiledQueryWithCapabilities` double gives its callback, and a double
 * standing in for the seam is the one place running it here is right. (A file
 * that both imports `compile` and shadows the name with a parameter would still
 * be flagged; no such file exists, and the plugin API has no scope analysis.)
 */
const isCompileCall = (node, importedCompiles) => {
	if (node?.type !== "CallExpression") return false
	const callee = node.callee
	if (callee.type === "Identifier") return importedCompiles.has(callee.name)
	if (callee.type !== "MemberExpression" || callee.computed) return false
	return callee.property.type === "Identifier" && COMPILE_NAMES.has(callee.property.name)
}

/** `Effect.orDie` as a value — the callee of `Effect.orDie(x)` and the argument of `.pipe(…)`. */
const isEffectOrDie = (node) =>
	node?.type === "MemberExpression" &&
	!node.computed &&
	node.object.type === "Identifier" &&
	node.object.name === "Effect" &&
	node.property.type === "Identifier" &&
	node.property.name === "orDie"

const noOrDieCompiledQuery = {
	meta: {
		type: "problem",
		docs: {
			description: "Disallow `Effect.orDie` around a ClickHouse-builder compile.",
		},
		messages: { noOrDieCompiledQuery: NO_ORDIE_COMPILED_QUERY_MESSAGE },
	},
	// Deliberately shape-matched rather than type-aware: it fires on the literal
	// `Effect.orDie(CH.compile(…))` and `CH.compile(…).pipe(Effect.orDie)`, which
	// is the form that reappeared 82 times. A wrapper returning a compile Effect
	// under some other name is out of reach here and stays a review question.
	create(context) {
		const importedCompiles = new Set()
		return {
			ImportDeclaration(node) {
				if (!COMPILE_MODULES.test(node.source.value)) return
				for (const specifier of node.specifiers) {
					if (specifier.type !== "ImportSpecifier") continue
					if (COMPILE_NAMES.has(importedName(specifier))) importedCompiles.add(specifier.local.name)
				}
			},
			CallExpression(node) {
				if (isEffectOrDie(node.callee) && isCompileCall(node.arguments[0], importedCompiles)) {
					context.report({ node, messageId: "noOrDieCompiledQuery" })
					return
				}
				if (
					node.callee.type === "MemberExpression" &&
					!node.callee.computed &&
					node.callee.property.type === "Identifier" &&
					node.callee.property.name === "pipe" &&
					isCompileCall(node.callee.object, importedCompiles) &&
					node.arguments.some(isEffectOrDie)
				) {
					context.report({ node, messageId: "noOrDieCompiledQuery" })
				}
			},
		}
	},
}

const NO_TRY_CATCH_MESSAGE =
	"Do not use `try`/`catch`. A thrown exception is invisible to the type system, so it escapes the typed error channel, and one `catch` block flattens every failure into a single branch. Use the Effect primitive: `Effect.try`/`Effect.tryPromise` for a throwing call, `Schema.fromJsonString` for JSON, `Schema.decodeUnknown{Effect,Option,Sync}` for decoding, `Effect.catch`/`catchTag`/`catchDefect` to handle a failure, and `Effect.ensuring`/`Effect.addFinalizer` for a `finally`."

const noTryCatch = {
	meta: {
		type: "problem",
		docs: {
			description: "Disallow `try`/`catch`/`finally` in favour of Effect's typed error channel.",
		},
		messages: { noTryCatch: NO_TRY_CATCH_MESSAGE },
	},
	create(context) {
		return {
			TryStatement(node) {
				context.report({ node, messageId: "noTryCatch" })
			},
		}
	},
}

const NO_EFFECT_DIE_MESSAGE =
	"Do not `Effect.die`. Killing a typed failure discards the distinction the tagged-error convention exists to preserve, and the caller loses the branch it could have handled. Keep it in the error channel — `Effect.mapError` into a failure the contract declares, or narrow the producer's channel so the impossible case is not in it. If the value genuinely is a defect (a boot-time config error, a platform binding the deploy omitted, a broken internal invariant), say so with `// oxlint-disable-next-line maple/no-effect-die` and a reason, and raise a namespaced `Schema.TaggedError` rather than a bare `Error`."

/**
 * `Effect.die` in any position.
 *
 * Reported on the member expression rather than the call, so the value form
 * (`Effect.catch(Effect.die)`) is caught alongside `Effect.die(x)` — a call's
 * callee IS that member expression, so each occurrence is still reported once.
 *
 * A bare `die(…)` from `import { die } from "effect/Effect"` is out of scope:
 * the plugin API has no scope analysis, and `die` is also the name test
 * harnesses give their own not-implemented stub.
 */
const noEffectDie = {
	meta: {
		type: "problem",
		docs: {
			description: "Disallow `Effect.die`, which converts a typed failure into a defect.",
		},
		messages: { noEffectDie: NO_EFFECT_DIE_MESSAGE },
	},
	create(context) {
		return {
			MemberExpression(node) {
				if (node.computed) return
				if (node.object.type !== "Identifier" || node.object.name !== "Effect") return
				if (node.property.type !== "Identifier" || node.property.name !== "die") return
				context.report({ node, messageId: "noEffectDie" })
			},
		}
	},
}

export default {
	meta: { name: "maple" },
	rules: {
		"no-effect-die": noEffectDie,
		"no-ordie-compiled-query": noOrDieCompiledQuery,
		"no-react-use-effect": noReactUseEffect,
		"no-record-string-any": noRecordStringAny,
		"no-try-catch": noTryCatch,
	},
}
