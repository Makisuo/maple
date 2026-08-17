import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const FORBIDDEN_SYMBOL_NAME = "shape";

function containsForbiddenSymbolName(name: string): boolean {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}

/** Property and protocol keys describe serialized contracts rather than owned symbols. */
function isPropertyKeyOrExternalMember(node: ESTree.Node & { name: string }): boolean {
  const parent = node.parent as ESTree.Node & Record<string, unknown>;
  if (
    parent.type === "MemberExpression" &&
    parent.property === node &&
    parent.computed === false
  ) {
    return true;
  }
  if (parent.type === "TSQualifiedName" && parent.right === node) {
    return true;
  }
  if (
    [
      "MethodDefinition",
      "PropertyDefinition",
      "TSMethodSignature",
      "TSPropertySignature",
    ].includes(parent.type) &&
    parent.key === node &&
    parent.computed !== true
  ) {
    return true;
  }
  if (
    parent.type === "Property" &&
    parent.key === node &&
    parent.computed === false &&
    parent.shorthand === false
  ) {
    return true;
  }
  if (parent.type === "ImportSpecifier" && parent.imported === node && parent.local !== node) {
    return true;
  }
  if (parent.type === "ExportSpecifier" && parent.exported === node && parent.local !== node) {
    return true;
  }
  return (
    (parent.type === "JSXAttribute" && parent.name === node) ||
    (parent.type === "JSXMemberExpression" && parent.property === node)
  );
}

/** Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.',
    },
    messages: {
      forbiddenSymbolName:
        'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
    },
  },
  createOnce(context) {
    const reportForbiddenSymbolName = (node: ESTree.Node & { name: string }) => {
      if (!containsForbiddenSymbolName(node.name) || isPropertyKeyOrExternalMember(node)) return;
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name },
      });
    };

    return {
      Identifier: reportForbiddenSymbolName,
      PrivateIdentifier: reportForbiddenSymbolName,
      JSXIdentifier: reportForbiddenSymbolName,
    };
  },
});
