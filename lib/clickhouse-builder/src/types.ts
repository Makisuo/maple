// Column types — the `/types` subpath.
//
// An explicit list rather than a re-export of the implementation module, which
// is what the other three entry points do. Pointing straight at `./ch/types`
// also published `CHDateTimeUtc`, `chDateTimeLiteral` and `chDateTimeToIso`,
// which are how DateTime columns encode internally, not a consumer's tools.
export {
	type CHArray,
	type CHBool,
	type CHDateTime,
	type CHDateTime64,
	type CHDateTime64String,
	type CHDateTimeString,
	type CHFloat64,
	type CHInt32,
	type CHInt64,
	type CHMap,
	type CHNullable,
	type CHString,
	type CHStringLike,
	type CHType,
	type CHUInt8,
	type CHUInt16,
	type CHUInt32,
	type CHUInt64,
	type ColumnDefs,
	type InferEncoded,
	type InferTS,
	type NullableColumnDefs,
	type OutputToColumnDefs,
	aggregateState,
	array,
	bool,
	/**
	 * The codec every numeric column type is built from: a finite number, or the
	 * decimal string a backend sends when it quotes 64-bit integers. Exported
	 * because a `custom()` type of your own almost always wants it.
	 */
	CHNumber,
	custom,
	dateTime,
	dateTime64,
	dateTime64String,
	dateTimeString,
	float64,
	int32,
	int64,
	map,
	nullable,
	string,
	uint8,
	uint16,
	uint32,
	uint64,
	untyped,
} from "./ch/types"
