/**
 * The engine's name for "this result has no grouping dimension".
 *
 * Storage, the wire and the UI spell the same thing `UNGROUPED_GROUP_KEY`
 * (`"__total__"`), and `toStorageGroupKey` in the alerts service is the one
 * boundary that translates between them. That translation was already named;
 * this side was a bare `"all"` repeated at a dozen sites, which is what made it
 * possible to write one of them as `"__total__"` by mistake and produce an
 * `alert_rule_states` row no reader can see.
 *
 * Lives in its own driver-free module rather than in `runtime/query-engine.ts`
 * because both sides of the engine need it: the alert lowering emits it, and the
 * query-set merge has to recognise it to decide whether a series gets a group
 * suffix. `runtime` is API-only, so a web-bundled consumer cannot reach it.
 */
export const ENGINE_UNGROUPED_GROUP_KEY = "all"

/**
 * Whether a group name from the warehouse means "no grouping".
 *
 * Case-insensitive and whitespace-tolerant on purpose: this reads names that
 * came back through SQL and through the raw-SQL `group` column convention, where
 * the value is whatever the author's query produced.
 */
export const isEngineUngroupedKey = (groupName: string): boolean =>
	groupName.trim().toLowerCase() === ENGINE_UNGROUPED_GROUP_KEY
