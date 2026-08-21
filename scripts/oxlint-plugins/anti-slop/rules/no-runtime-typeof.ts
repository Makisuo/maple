import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

type Parameter = ESTree.ParamPattern;

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	);
}

function isInsideTypeGuard(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) {
			return current.returnType?.typeAnnotation.type === "TSTypePredicate";
		}
		current = current.parent;
	}
	return false;
}

function parameterAnnotation(parameter: Parameter): ESTree.TSTypeAnnotation | null | undefined {
	if (parameter.type === "TSParameterProperty") return parameterAnnotation(parameter.parameter);
	if (parameter.type === "RestElement") {
		return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
	}
	if (parameter.type === "AssignmentPattern") {
		return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
	}
	return parameter.typeAnnotation;
}

function isInsideUnknownBoundary(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) {
			return current.params.some((parameter) =>
				containsUnknownOrAny(parameterAnnotation(parameter)?.typeAnnotation),
			);
		}
		current = current.parent;
	}
	return false;
}

function resolveVariable(
	sourceCode: SourceCode,
	identifier: ESTree.IdentifierReference,
): Variable | null {
	let scope: Scope | null = sourceCode.getScope(identifier);
	while (scope !== null) {
		const variable = scope.set.get(identifier.name);
		if (variable !== undefined) return variable;
		scope = scope.upper;
	}
	return null;
}

function containsUnknownOrAny(type: ESTree.TSType | null | undefined): boolean {
	if (type === null || type === undefined) return false;
	if (type.type === "TSUnknownKeyword" || type.type === "TSAnyKeyword") return true;
	switch (type.type) {
		case "TSArrayType":
		case "TSOptionalType":
		case "TSParenthesizedType":
		case "TSRestType":
		case "TSTypeOperator":
			return containsUnknownOrAny(type.typeAnnotation);
		case "TSConditionalType":
			return (
				containsUnknownOrAny(type.checkType) ||
				containsUnknownOrAny(type.extendsType) ||
				containsUnknownOrAny(type.trueType) ||
				containsUnknownOrAny(type.falseType)
			);
		case "TSIntersectionType":
		case "TSUnionType":
			return type.types.some(containsUnknownOrAny);
		case "TSTupleType":
			return type.elementTypes.some(containsUnknownOrAny);
		case "TSTypeReference":
			return type.typeArguments?.params.some(containsUnknownOrAny) ?? false;
		default:
			return false;
	}
}

function annotatedWithUnknown(variable: Variable): boolean {
	return variable.identifiers.some((identifier) => {
		const annotation = identifier.typeAnnotation?.typeAnnotation;
		return annotation !== undefined && containsUnknownOrAny(annotation);
	});
}

function rootIdentifier(expression: ESTree.Expression): ESTree.IdentifierReference | null {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSNonNullExpression" ||
		current.type === "ChainExpression"
	) {
		current = current.expression;
	}
	if (current.type === "TSAsExpression" || current.type === "TSTypeAssertion") {
		return rootIdentifier(current.expression);
	}
	if (current.type === "MemberExpression") {
		return current.object.type === "Super" ? null : rootIdentifier(current.object);
	}
	return current.type === "Identifier" ? current : null;
}

function containsUnknownAssertion(expression: ESTree.Expression): boolean {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSNonNullExpression" ||
		current.type === "ChainExpression"
	) {
		current = current.expression;
	}
	if (current.type === "TSAsExpression" || current.type === "TSTypeAssertion") {
		return containsUnknownOrAny(current.typeAnnotation) || containsUnknownAssertion(current.expression);
	}
	return (
		current.type === "MemberExpression" &&
		current.object.type !== "Super" &&
		containsUnknownAssertion(current.object)
	);
}

function operatesOnUnknown(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSNonNullExpression" ||
		current.type === "ChainExpression"
	) {
		current = current.expression;
	}
	if (containsUnknownAssertion(current)) return true;
	const identifier = rootIdentifier(current);
	if (identifier === null) return false;
	const variable = resolveVariable(sourceCode, identifier);
	return variable !== null && annotatedWithUnknown(variable);
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
		},
		messages: {
			runtimeTypeof:
				"A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
		},
			schema: [
			{
				type: "object",
				properties: {
					allowInTypeGuards: { type: "boolean" },
					allowInBoundaryFunctions: { type: "boolean" },
					checkUnknownOnly: { type: "boolean" },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [
			{
				allowInTypeGuards: false,
				allowInBoundaryFunctions: false,
				checkUnknownOnly: false,
			},
		],
	},
	createOnce(context) {
		return {
			UnaryExpression(node) {
				const option = context.options?.[0];
				const allowInTypeGuards =
					typeof option === "object" &&
					option !== null &&
					!Array.isArray(option) &&
					option.allowInTypeGuards === true;
				const checkUnknownOnly =
					typeof option === "object" &&
					option !== null &&
					!Array.isArray(option) &&
					option.checkUnknownOnly === true;
				const allowInBoundaryFunctions =
					typeof option === "object" &&
					option !== null &&
					!Array.isArray(option) &&
					option.allowInBoundaryFunctions === true;
				if (
					node.operator === "typeof" &&
					(!allowInTypeGuards || !isInsideTypeGuard(node)) &&
					(!allowInBoundaryFunctions || !isInsideUnknownBoundary(node)) &&
					(!checkUnknownOnly || operatesOnUnknown(context.sourceCode, node.argument))
				) {
					context.report({ node, messageId: "runtimeTypeof" });
				}
			},
		};
	},
});
