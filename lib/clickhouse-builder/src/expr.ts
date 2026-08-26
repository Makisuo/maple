export * from "./ch/expr"
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
