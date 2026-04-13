/**
 * Converts an Effect Schema to TypeScript type definitions.
 *
 * This module recursively discovers all named types (like S.Class with identifiers)
 * and generates interface definitions for each.
 *
 * @module
 */

import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import * as AST from "effect/SchemaAST";

/**
 * The result of generating TypeScript type definitions.
 */
export interface TypeDefinitionResult {
  /**
   * The type expressions for each input schema.
   * Each expression is either an identifier (for named types) or an inline type.
   */
  readonly exprs: string[];

  /**
   * All type definitions as a single string.
   * Contains all recursively discovered named types, separated by newlines.
   * Types are deduplicated - if multiple schemas reference the same type,
   * it will only appear once.
   */
  readonly types: string;
}

/**
 * Generates TypeScript type definitions from one or more schemas.
 *
 * All schemas share a single type environment, so types referenced by
 * multiple schemas are only generated once (deduplication).
 */
export const schemaToType = <Schemas extends Schema.Schema<any>[]>(
  ...schemas: Schemas
): TypeDefinitionResult => {
  const typesMap: Record<string, string> = {};
  const processing = new Set<string>();

  const exprs = schemas.map((schema) =>
    go(schema.ast, { types: typesMap, processing }, "handle-identifier"),
  );

  const types = Object.values(typesMap).join("\n\n");

  return {
    exprs,
    types,
  };
};

interface GoOptions {
  readonly types: Record<string, string>;
  readonly processing: Set<string>;
}

/**
 * Converts an AST node to a TypeScript type reference or inline type.
 * Returns the identifier/type expression and collects named types.
 */
export const fromAST = (
  ast: AST.AST,
  options?: { types?: string[] },
): string => {
  const typesMap: Record<string, string> = {};
  const processing = new Set<string>();
  const result = go(ast, { types: typesMap, processing }, "handle-identifier");

  if (options?.types) {
    for (const def of Object.values(typesMap)) {
      options.types.push(def);
    }
  }

  return result;
};

function getDescription(ast: AST.AST): string | undefined {
  const desc = AST.resolveDescription(ast);
  if (desc === undefined) return undefined;

  if (AST.isString(ast) && desc === "a string") return undefined;
  if (AST.isNumber(ast) && desc === "a number") return undefined;
  if (AST.isBoolean(ast) && desc === "a boolean") return undefined;
  if (AST.isBigInt(ast) && desc === "a bigint") return undefined;
  if (AST.isSymbol(ast) && desc === "a symbol") return undefined;
  if (
    AST.isObjectKeyword(ast) &&
    desc === "an object in the TypeScript meaning, i.e. the `object` type"
  )
    return undefined;

  return desc;
}

/**
 * Gets the identifier for a named type.
 *
 * Returns an identifier for:
 * - S.Class types (Declarations with typeParameters and encoding)
 * - Any schema with an explicit identifier annotation
 * - Suspended types with identifiers
 *
 * Does NOT return identifier for simple transformations like NumberFromString.
 */
function getIdentifier(ast: AST.AST): string | undefined {
  if (AST.isDeclaration(ast)) {
    return AST.resolveIdentifier(ast);
  }

  if (AST.isSuspend(ast)) {
    const id = AST.resolveIdentifier(ast);
    if (id !== undefined) return id;
    const resolved = ast.thunk();
    return getIdentifier(resolved);
  }

  // For schemas with encoding chains (transforms like NumberFromString),
  // don't treat as named types - just use the decoded type
  if (ast.encoding) {
    return undefined;
  }

  return AST.resolveIdentifier(ast);
}

function formatComment(
  description: string | undefined,
  indent: string,
): string {
  if (!description) return "";
  const lines = description.split("\n");
  if (lines.length === 1) {
    return `${indent}/** ${description} */\n`;
  }
  return `${indent}/**\n${lines.map((line) => `${indent} * ${line}`).join("\n")}\n${indent} */\n`;
}

function escapePropertyName(name: PropertyKey): string {
  if (typeof name === "symbol") {
    return `[${String(name)}]`;
  }
  const str = String(name);
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(str)) {
    return str;
  }
  return JSON.stringify(str);
}

/**
 * Gets the type body for a named type (S.Class, etc).
 * Navigates through Declarations to find the actual structure.
 */
function getTypeBody(ast: AST.AST, options: GoOptions): string {
  if (AST.isSuspend(ast)) {
    return getTypeBody(ast.thunk(), options);
  }

  if (AST.isDeclaration(ast)) {
    if (ast.typeParameters.length > 0) {
      return go(ast.typeParameters[0], options, "ignore-identifier");
    }
    return "unknown";
  }

  return go(ast, options, "ignore-identifier");
}

function go(
  ast: AST.AST,
  options: GoOptions,
  identifierHandling: "handle-identifier" | "ignore-identifier",
): string {
  // Handle identifier references first
  if (identifierHandling === "handle-identifier") {
    const id = getIdentifier(ast);
    if (id !== undefined) {
      if (options.processing.has(id)) {
        return id;
      }

      if (!(id in options.types)) {
        options.processing.add(id);

        const typeBody = getTypeBody(ast, options);

        if (typeBody.startsWith("{")) {
          options.types[id] = `interface ${id} ${typeBody}`;
        } else {
          options.types[id] = `type ${id} = ${typeBody};`;
        }

        options.processing.delete(id);
      }
      return id;
    }
  }

  // For Declarations without identifier (or when ignoring), get the body from typeParameters
  if (AST.isDeclaration(ast) && identifierHandling === "ignore-identifier") {
    if (ast.typeParameters.length > 0) {
      return go(ast.typeParameters[0], options, identifierHandling);
    }
    return "unknown";
  }

  // Handle encoding chains (transformations): use the decoded type
  if (ast.encoding) {
    return go(AST.toType(ast), options, identifierHandling);
  }

  switch (ast._tag) {
    case "Declaration": {
      if (ast.typeParameters.length > 0) {
        const id = getIdentifier(ast);
        if (id) {
          const params = ast.typeParameters
            .map((p) => go(p, options, "handle-identifier"))
            .join(", ");
          return `${id}<${params}>`;
        }
      }
      return "unknown";
    }

    case "Literal": {
      const literal = ast.literal;
      if (Predicate.isString(literal)) {
        return JSON.stringify(literal);
      }
      if (Predicate.isNumber(literal)) {
        return String(literal);
      }
      if (Predicate.isBoolean(literal)) {
        return String(literal);
      }
      if (Predicate.isBigInt(literal)) {
        return `${String(literal)}n`;
      }
      return "unknown";
    }

    case "Null":
      return "null";

    case "UniqueSymbol":
      return `typeof ${String(ast.symbol)}`;

    case "Undefined":
      return "undefined";

    case "Void":
      return "void";

    case "Never":
      return "never";

    case "Unknown":
      return "unknown";

    case "Any":
      return "any";

    case "String":
      return "string";

    case "Number":
      return "number";

    case "Boolean":
      return "boolean";

    case "BigInt":
      return "bigint";

    case "Symbol":
      return "symbol";

    case "ObjectKeyword":
      return "object";

    case "Enum": {
      const values = ast.enums.map(([_, value]) =>
        typeof value === "string" ? JSON.stringify(value) : String(value),
      );
      return values.join(" | ");
    }

    case "TemplateLiteral": {
      return formatTemplateLiteral(ast, options);
    }

    case "Arrays": {
      return formatArrays(ast, options);
    }

    case "Objects": {
      return formatObjects(ast, options);
    }

    case "Union": {
      const members = ast.types.map((t) => go(t, options, "handle-identifier"));
      const unique = [...new Set(members)];
      if (unique.length === 1) {
        return unique[0];
      }
      return unique.join(" | ");
    }

    case "Suspend": {
      const id = getIdentifier(ast);
      if (id !== undefined) {
        if (options.processing.has(id)) {
          return id;
        }
        if (!(id in options.types)) {
          options.processing.add(id);
          const typeBody = getTypeBody(ast, options);
          if (typeBody.startsWith("{")) {
            options.types[id] = `interface ${id} ${typeBody}`;
          } else {
            options.types[id] = `type ${id} = ${typeBody};`;
          }
          options.processing.delete(id);
        }
        return id;
      }
      const resolved = ast.thunk();
      return go(resolved, options, identifierHandling);
    }
  }
}

function formatTemplateLiteral(
  ast: AST.TemplateLiteral,
  options: GoOptions,
): string {
  let result = "`";
  for (const part of ast.parts) {
    if (AST.isLiteral(part) && typeof part.literal === "string") {
      result += part.literal;
    } else {
      const spanType = formatTemplateLiteralSpan(part, options);
      result += "${" + spanType + "}";
    }
  }
  result += "`";
  return result;
}

function formatTemplateLiteralSpan(type: AST.AST, options: GoOptions): string {
  switch (type._tag) {
    case "String":
      return "string";
    case "Number":
      return "number";
    case "Literal":
      return typeof type.literal === "string"
        ? JSON.stringify(type.literal)
        : String(type.literal);
    case "TemplateLiteral":
      return formatTemplateLiteral(type, options);
    case "Union":
      return type.types
        .map((t) => formatTemplateLiteralSpan(t, options))
        .join(" | ");
    default:
      return go(type, options, "handle-identifier");
  }
}

function formatArrays(ast: AST.Arrays, options: GoOptions): string {
  const elements: string[] = [];

  for (const element of ast.elements) {
    const isOpt = AST.isOptional(element);
    let typeStr: string;
    if (isOpt && AST.isUnion(element)) {
      const nonUndefined = element.types.filter((t) => !AST.isUndefined(t));
      if (nonUndefined.length === 1) {
        typeStr = go(nonUndefined[0], options, "handle-identifier");
      } else if (nonUndefined.length > 1) {
        typeStr = nonUndefined
          .map((t) => go(t, options, "handle-identifier"))
          .join(" | ");
      } else {
        typeStr = go(element, options, "handle-identifier");
      }
    } else {
      typeStr = go(element, options, "handle-identifier");
    }
    const description = getDescription(element);
    const comment = description ? `/* ${description} */ ` : "";
    if (isOpt) {
      elements.push(`${comment}${typeStr}?`);
    } else {
      elements.push(`${comment}${typeStr}`);
    }
  }

  if (ast.rest.length > 0) {
    const restType = go(ast.rest[0], options, "handle-identifier");
    if (ast.elements.length === 0 && ast.rest.length === 1) {
      if (!ast.isMutable) {
        return `readonly ${restType}[]`;
      }
      return `${restType}[]`;
    }
    elements.push(`...${restType}[]`);
  }

  const prefix = !ast.isMutable ? "readonly " : "";
  return `${prefix}[${elements.join(", ")}]`;
}

function formatObjects(ast: AST.Objects, options: GoOptions): string {
  if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0) {
    return "{}";
  }

  const lines: string[] = [];

  for (const ps of ast.propertySignatures) {
    if (typeof ps.name !== "string" && typeof ps.name !== "number") {
      continue;
    }

    const propName = escapePropertyName(ps.name);
    const typeStr = go(ps.type, options, "handle-identifier");
    const description = getDescription(ps.type);
    const comment = formatComment(description, "  ");
    const isMutable = ps.type.context?.isMutable ?? false;
    const readonly = isMutable ? "" : "readonly ";
    const optional = AST.isOptional(ps.type) ? "?" : "";

    lines.push(`${comment}  ${readonly}${propName}${optional}: ${typeStr};`);
  }

  for (const is of ast.indexSignatures) {
    const paramType = go(is.parameter, options, "handle-identifier");
    const valueType = go(is.type, options, "handle-identifier");
    const readonly = "readonly ";
    lines.push(`  ${readonly}[key: ${paramType}]: ${valueType};`);
  }

  if (lines.length === 0) {
    return "{}";
  }

  return `{\n${lines.join("\n")}\n}`;
}
