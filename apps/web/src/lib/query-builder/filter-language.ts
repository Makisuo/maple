import type {
  QueryBuilderFilterNode,
  QueryBuilderFilterOperator,
  QueryBuilderScalarValue,
} from "@maple/domain"

type TokenKind =
  | "identifier"
  | "string"
  | "number"
  | "boolean"
  | "lparen"
  | "rparen"
  | "comma"
  | "operator"
  | "and"
  | "or"
  | "eof"

interface Token {
  kind: TokenKind
  value: string
  index: number
}

export class QueryBuilderParseError extends Error {
  readonly index: number

  constructor(message: string, index: number) {
    super(message)
    this.name = "QueryBuilderParseError"
    this.index = index
  }
}

const OPERATOR_LOOKAHEAD = [
  "NOT EXISTS",
  "NOT CONTAINS",
  "NOT IN",
  "EXISTS",
  "CONTAINS",
  "IN",
  ">=",
  "<=",
  "!=",
  "=",
  ">",
  "<",
] as const

function isWhitespace(char: string | undefined): boolean {
  return !!char && /\s/.test(char)
}

function isIdentifierChar(char: string | undefined): boolean {
  return !!char && /[a-zA-Z0-9_.:-]/.test(char)
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let index = 0

  while (index < input.length) {
    const char = input[index]

    if (isWhitespace(char)) {
      index += 1
      continue
    }

    if (char === "(") {
      tokens.push({ kind: "lparen", value: char, index })
      index += 1
      continue
    }

    if (char === ")") {
      tokens.push({ kind: "rparen", value: char, index })
      index += 1
      continue
    }

    if (char === ",") {
      tokens.push({ kind: "comma", value: char, index })
      index += 1
      continue
    }

    if (char === "'" || char === "\"") {
      const quote = char
      const start = index
      index += 1
      let value = ""

      while (index < input.length) {
        const next = input[index]
        if (next === quote && input[index - 1] !== "\\") {
          index += 1
          tokens.push({ kind: "string", value, index: start })
          value = ""
          break
        }
        value += next
        index += 1
      }

      if (value.length > 0 || input[index - 1] !== quote) {
        throw new QueryBuilderParseError("Unterminated string literal", start)
      }
      continue
    }

    const remainingUpper = input.slice(index).toUpperCase()
    const operator = OPERATOR_LOOKAHEAD.find((candidate) => {
      if (!remainingUpper.startsWith(candidate)) return false
      const after = input[index + candidate.length]
      if (/[A-Z]/i.test(candidate[candidate.length - 1] ?? "") && isIdentifierChar(after)) {
        return false
      }
      return true
    })

    if (operator) {
      tokens.push({ kind: "operator", value: operator, index })
      index += operator.length
      continue
    }

    if (isIdentifierChar(char)) {
      const start = index
      let value = ""
      while (index < input.length && isIdentifierChar(input[index])) {
        value += input[index]
        index += 1
      }

      const upper = value.toUpperCase()
      if (upper === "AND") {
        tokens.push({ kind: "and", value: upper, index: start })
        continue
      }
      if (upper === "OR") {
        tokens.push({ kind: "or", value: upper, index: start })
        continue
      }
      if (upper === "TRUE" || upper === "FALSE") {
        tokens.push({ kind: "boolean", value: upper.toLowerCase(), index: start })
        continue
      }
      if (/^-?\d+(\.\d+)?$/.test(value)) {
        tokens.push({ kind: "number", value, index: start })
        continue
      }
      tokens.push({ kind: "identifier", value, index: start })
      continue
    }

    throw new QueryBuilderParseError(`Unexpected token: ${char}`, index)
  }

  tokens.push({ kind: "eof", value: "", index: input.length })
  return tokens
}

class Parser {
  private readonly tokens: Token[]
  private index = 0

  constructor(input: string) {
    this.tokens = tokenize(input)
  }

  parse(): QueryBuilderFilterNode {
    const node = this.parseOr()
    this.expect("eof")
    return node
  }

  private current(): Token {
    return this.tokens[this.index]!
  }

  private consume(): Token {
    const token = this.current()
    this.index += 1
    return token
  }

  private expect(kind: TokenKind): Token {
    const token = this.current()
    if (token.kind !== kind) {
      throw new QueryBuilderParseError(
        `Expected ${kind} but found ${token.kind}`,
        token.index,
      )
    }
    return this.consume()
  }

  private parseOr(): QueryBuilderFilterNode {
    let left = this.parseAnd()
    while (this.current().kind === "or") {
      this.consume()
      const right = this.parseAnd()
      left = foldGroup("OR", left, right)
    }
    return left
  }

  private parseAnd(): QueryBuilderFilterNode {
    let left = this.parsePrimary()
    while (this.current().kind === "and") {
      this.consume()
      const right = this.parsePrimary()
      left = foldGroup("AND", left, right)
    }
    return left
  }

  private parsePrimary(): QueryBuilderFilterNode {
    const token = this.current()
    if (token.kind === "lparen") {
      this.consume()
      const node = this.parseOr()
      this.expect("rparen")
      return node
    }
    return this.parsePredicate()
  }

  private parsePredicate(): QueryBuilderFilterNode {
    const fieldToken = this.expect("identifier")
    const operatorToken = this.expect("operator")
    const field = fieldToken.value.trim().toLowerCase()
    const operator = operatorToken.value.toUpperCase()

    if (operator === "EXISTS" || operator === "NOT EXISTS") {
      return {
        kind: "exists",
        field,
        negated: operator === "NOT EXISTS" ? true : undefined,
      }
    }

    if (operator === "IN" || operator === "NOT IN") {
      this.expect("lparen")
      const values: QueryBuilderScalarValue[] = []
      while (this.current().kind !== "rparen") {
        values.push(this.parseScalar())
        if (this.current().kind === "comma") {
          this.consume()
          continue
        }
        if (this.current().kind !== "rparen") {
          throw new QueryBuilderParseError(
            "Expected ',' or ')' in value list",
            this.current().index,
          )
        }
      }
      this.expect("rparen")
      return {
        kind: "comparison",
        field,
        operator: operator as QueryBuilderFilterOperator,
        value: values,
      }
    }

    return {
      kind: "comparison",
      field,
      operator: operator as QueryBuilderFilterOperator,
      value: this.parseScalar(),
    }
  }

  private parseScalar(): QueryBuilderScalarValue {
    const token = this.current()
    if (token.kind === "string") {
      this.consume()
      return token.value
    }
    if (token.kind === "number") {
      this.consume()
      return Number(token.value)
    }
    if (token.kind === "boolean") {
      this.consume()
      return token.value === "true"
    }
    if (token.kind === "identifier") {
      this.consume()
      return token.value
    }

    throw new QueryBuilderParseError(
      `Expected a value but found ${token.kind}`,
      token.index,
    )
  }
}

function foldGroup(
  operator: "AND" | "OR",
  left: QueryBuilderFilterNode,
  right: QueryBuilderFilterNode,
): QueryBuilderFilterNode {
  if (left.kind === "group" && left.operator === operator) {
    return {
      ...left,
      clauses: [...left.clauses, right],
    }
  }

  return {
    kind: "group",
    operator,
    clauses: [left, right],
  }
}

export function parseFilterExpression(input: string): QueryBuilderFilterNode | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  return new Parser(trimmed).parse()
}
