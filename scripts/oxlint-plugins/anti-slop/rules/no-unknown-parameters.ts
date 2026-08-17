import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

type Parameter = ESTree.ParamPattern;
type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

function parameterAnnotation(parameter: Parameter): ESTree.TSTypeAnnotation | null | undefined {
  if (parameter.type === "TSParameterProperty") {
    return parameterAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
}

function parameterName(parameter: Parameter, sourceText: string): string {
  if (parameter.type === "TSParameterProperty") {
    return parameterName(parameter.parameter, sourceText);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameterName(parameter.left, sourceText);
  }
  if (parameter.type === "RestElement") {
    return parameterName(parameter.argument, sourceText);
  }
  return parameter.type === "Identifier"
    ? parameter.name
    : sourceText.replace(/\s*:\s*unknown\s*$/u, "");
}

function hasRuntimeBody(node: ParameterOwner): node is ESTree.ArrowFunctionExpression | ESTree.Function {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression"
  );
}

function isBoundaryParameter(node: ParameterOwner): boolean {
  // In Maple, a runtime function that explicitly accepts `unknown` owns that
  // boundary. TypeScript prevents the implementation from using the value
  // without narrowing it; signature-only contracts still need a domain type.
  return hasRuntimeBody(node);
}

function hasBoundaryComment(sourceCode: SourceCode, node: ESTree.Node): boolean {
  if (
    sourceCode
      .getAllComments()
      .some((comment) => /\bBOUNDARY\s*:/u.test(comment.value))
  ) {
    return true;
  }
  let current = node;
  while (current.type !== "Program") {
    if (
      sourceCode
        .getCommentsBefore(current)
        .some((comment) => comment.end <= node.start && /\bBOUNDARY\s*:/u.test(comment.value))
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/** Disallow unknown inputs except explicitly named error-cause enrichment. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except `cause`; decode unknown input at its I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowInBoundaryFunctions: { type: "boolean" },
          allowWithBoundaryComment: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      { allowInBoundaryFunctions: false, allowWithBoundaryComment: false },
    ],
  },
  createOnce(context) {
    const checkParameters = (node: ParameterOwner) => {
      const option = context.options?.[0];
      const allowInBoundaryFunctions =
        typeof option === "object" &&
        option !== null &&
        !Array.isArray(option) &&
        option.allowInBoundaryFunctions === true;
      const allowWithBoundaryComment =
        typeof option === "object" &&
        option !== null &&
        !Array.isArray(option) &&
        option.allowWithBoundaryComment === true;
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation?.typeAnnotation.type !== "TSUnknownKeyword") continue;
        const name = parameterName(parameter, context.sourceCode.getText(parameter));
        if (name === "cause") continue;
        if (
          allowWithBoundaryComment &&
          hasBoundaryComment(context.sourceCode, node)
        ) {
          continue;
        }
        if (
          allowInBoundaryFunctions &&
          isBoundaryParameter(node)
        ) {
          continue;
        }
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
        });
      }
    };

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
