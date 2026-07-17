import { Atom } from "@/lib/effect-atom"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"
import { Schema } from "effect"

export const RecentTimeRangeSchema = Schema.Struct({
	label: Schema.String,
	value: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
})

export type RecentTimeRange = Schema.Schema.Type<typeof RecentTimeRangeSchema>

export const RECENTLY_USED_TIMES_STORAGE_KEY = "maple-recently-used-times:v1"

export const recentlyUsedTimesAtom = Atom.kvs({
	runtime: localStorageRuntime,
	key: RECENTLY_USED_TIMES_STORAGE_KEY,
	schema: Schema.mutable(Schema.Array(RecentTimeRangeSchema)),
	defaultValue: () => [] as RecentTimeRange[],
})
