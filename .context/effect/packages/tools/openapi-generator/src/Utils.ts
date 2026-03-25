import * as String from "effect/String"
import * as UndefinedOr from "effect/UndefinedOr"

export const camelize = (self: string): string => {
  let str = ""
  let hadSymbol = false
  for (let i = 0; i < self.length; i++) {
    const charCode = self.charCodeAt(i)
    if (
      (charCode >= 65 && charCode <= 90) ||
      (charCode >= 97 && charCode <= 122)
    ) {
      str += hadSymbol ? self[i].toUpperCase() : self[i]
      hadSymbol = false
    } else if (charCode >= 48 && charCode <= 57) {
      if (str.length > 0) {
        str += self[i]
        hadSymbol = true
      }
    } else if (str.length > 0) {
      hadSymbol = true
    }
  }
  return str
}

export const identifier = (operationId: string) => String.capitalize(camelize(operationId))

export const nonEmptyString = (a: unknown): string | undefined => {
  if (typeof a === "string") {
    const trimmed = String.trim(a)
    if (String.isNonEmpty(trimmed)) {
      return trimmed
    }
  }
}

export const toComment = UndefinedOr.match({
  onUndefined: () => "",
  onDefined: (description: string) =>
    `/**
* ${description.replace(/\*\//g, " * /").split("\n").join("\n* ")}
*/\n`
})

export const spreadElementsInto = <A>(source: Array<A>, destination: Array<A>): void => {
  for (let i = 0; i < source.length; i++) {
    destination.push(source[i])
  }
}
