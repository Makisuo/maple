/**
 * Built-in default notification templates.
 *
 * These approximate Maple's designed notification format (lead sentence +
 * compact facts — see buildSlackBlocks) using the `{{ variable }}` grammar.
 * They seed the rule editor, power the live preview, and fill whichever field
 * (title/body) a partially-customized template leaves unset. NOTE: at dispatch
 * time, a rule with NO custom template at all takes the hardcoded designed
 * formatter path (see AlertDeliveryDispatch), not these strings.
 */

export const DEFAULT_TITLE_TEMPLATE = "{{ event.emoji }} {{ rule.name }} — {{ event.label }}"

export const DEFAULT_BODY_TEMPLATE = [
	"{{ signal.label }} is *{{ observed }}* ({{ comparator.label }} {{ threshold }}{{#if thresholdUpper}} and {{ thresholdUpper }}{{/if}}) over the last {{ window }}.",
	"*Severity:* {{ severity }} · *Group:* {{ group }}",
].join("\n")
