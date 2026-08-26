// An explicit list, not `export *`: the star also published `makeColumnRef` and
// `aliased`, which exist for query compilation and are not a consumer's tools.
export {
	type Comparable,
	type ColumnRef,
	type Condition,
	type Expr,
	type MapValueOf,
	dynamicColumn,
	inExprList,
	inList,
	lit,
	makeCond,
	makeExpr,
	makeUntypedExpr,
	not,
	notInList,
	outerRef,
	rawCond,
	rawExpr,
	// The value-to-fragment conversion every custom function argument goes
	// through — needed by anyone hand-rolling one.
	toFragment,
	untypedExpr,
	when,
	whenTrue,
} from "./ch/expr"
export * from "./ch/functions"
// The factories behind `./ch/functions`, so a consumer can declare a function
// this package does not model and have it carry a result type like a built-in.
export {
	arrayOfArg,
	compileFnCall,
	compileFnCallCond,
	compileTypedFnCall,
	defineCondFn,
	defineFn,
	defineUntypedFn,
	elementOf,
	elementSchema,
	firstTyped,
	type FnResult,
	sameAs,
	schemaOf,
	schemaOfAny,
} from "./ch/define-fn"
