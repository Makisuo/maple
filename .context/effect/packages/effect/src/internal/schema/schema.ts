import * as Pipeable from "../../Pipeable.ts"
import type * as Schema from "../../Schema.ts"
import * as AST from "../../SchemaAST.ts"
import * as Parser from "../../SchemaParser.ts"

/** @internal */
export const TypeId = "~effect/Schema/Schema"

const SchemaProto = {
  [TypeId]: TypeId,
  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  },
  annotate(this: Schema.Top, annotations: Schema.Annotations.Annotations) {
    return this.rebuild(AST.annotate(this.ast, annotations))
  },
  annotateKey(this: Schema.Top, annotations: Schema.Annotations.Key<unknown>) {
    return this.rebuild(AST.annotateKey(this.ast, annotations))
  },
  check(this: Schema.Top, ...checks: readonly [AST.Check<unknown>, ...Array<AST.Check<unknown>>]) {
    return this.rebuild(AST.appendChecks(this.ast, checks))
  }
}

/** @internal */
export function make<S extends Schema.Top>(ast: S["ast"], options?: object): S {
  const self = Object.create(SchemaProto)
  if (options) {
    Object.assign(self, options)
  }
  self.ast = ast
  self.rebuild = (ast: AST.AST) => make(ast, options)
  self.makeUnsafe = Parser.makeUnsafe(self)
  self.makeOption = Parser.makeOption(self)
  return self
}
