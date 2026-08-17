import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (current.type === "ParenthesizedExpression" || current.type === "TSNonNullExpression") {
    current = current.expression;
  }
  return current;
}

function isJsonParseCall(expression: ESTree.Expression): boolean {
  const current = unwrapExpression(expression);
  return (
    current.type === "CallExpression" &&
    current.callee.type === "MemberExpression" &&
    !current.callee.computed &&
    current.callee.object.type === "Identifier" &&
    current.callee.object.name === "JSON" &&
    current.callee.property.type === "Identifier" &&
    current.callee.property.name === "parse"
  );
}

function isUnknownType(type: ESTree.TSType): boolean {
  let current = type;
  while (current.type === "TSParenthesizedType") current = current.typeAnnotation;
  return current.type === "TSUnknownKeyword";
}

function isHighRiskAssertion(node: TypeAssertion): boolean {
  const expression = unwrapExpression(node.expression);
  return (
    expression.type === "TSAsExpression" ||
    expression.type === "TSTypeAssertion" ||
    (isJsonParseCall(expression) && !isUnknownType(node.typeAnnotation))
  );
}

function hasSafetyComment(sourceCode: SourceCode, node: TypeAssertion): boolean {
  let current: ESTree.Node = node;
  while (true) {
    if (
      sourceCode
        .getCommentsBefore(current)
        .some((comment) => comment.end <= node.start && /\bSAFETY\s*:/u.test(comment.value))
    ) {
      return true;
    }
    if (commentOwnerKinds.has(current.type)) {
      return (
        current.parent.type === "ExportNamedDeclaration" &&
        sourceCode
          .getCommentsBefore(current.parent)
          .some((comment) => comment.end <= node.start && /\bSAFETY\s*:/u.test(comment.value))
      );
    }
    if (current.parent.type === "Program") return false;
    current = current.parent;
  }
}

function hasFileSafetyComment(sourceCode: SourceCode): boolean {
  return sourceCode
    .getAllComments()
    .some((comment) => /\bSAFETY-FILE\s*:/u.test(comment.value));
}

/** Require every non-const type assertion to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a nearby SAFETY comment for every TypeScript type assertion except const assertions.",
    },
    messages: {
      missingSafetyComment:
        "This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.",
    },
    schema: [
      {
        type: "object",
        properties: {
          check: { enum: ["all", "unsafe"] },
          allowFileSafetyComment: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ check: "all", allowFileSafetyComment: false }],
  },
  createOnce(context) {
    const checkAssertion = (node: TypeAssertion) => {
      const option = context.options?.[0];
      const unsafeOnly =
        typeof option === "object" &&
        option !== null &&
        !Array.isArray(option) &&
        option.check === "unsafe";
      const allowFileSafetyComment =
        typeof option === "object" &&
        option !== null &&
        !Array.isArray(option) &&
        option.allowFileSafetyComment === true;
      if (
        isConstAssertion(node) ||
        (unsafeOnly && !isHighRiskAssertion(node)) ||
        (allowFileSafetyComment && hasFileSafetyComment(context.sourceCode)) ||
        hasSafetyComment(context.sourceCode, node)
      ) {
        return;
      }
      context.report({ node, messageId: "missingSafetyComment" });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
